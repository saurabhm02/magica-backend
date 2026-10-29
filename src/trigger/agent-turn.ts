import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import type { RunMetadata as TriggerMetadata } from "@trigger.dev/sdk";
import type { Prisma } from "@prisma/client";
import { streamChat } from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { getSkillsPromptSummary } from "@/agent/skills/registry";
import { getLlmTools } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import {
  MAX_HISTORY_MESSAGES,
  RUN_CRASHED_ERROR,
  SAVE_PARTIAL_TEXT_EVERY_MS,
  SYSTEM_PROMPT,
  TERMINAL_RUN_STATUSES,
  TEXT_STREAM_ID,
} from "@/lib/constants";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { AgentTurnPayload, LlmMessage, ToolCall, TurnResult } from "@/lib/types";
import { refundLeakedHolds } from "@/modules/credits/credits";
import { extractSearchText } from "@/modules/messages/messages";

export const textStream = streams.define<string>({ id: TEXT_STREAM_ID });

type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
type AssetMeta = NonNullable<RunMetadata["assets"]>[number];

const updateMeta = (patch: RunMetadata) => metadata.replace(patch as TriggerMetadata);

export async function runAgentTurn(runId: string, traceId: string, signal = new AbortController().signal) {
  let replyId: string | null = null;
  const contentBlocks: ContentBlock[] = [];
  const toolsMetadata: ToolMeta[] = [];
  const assetsMetadata: AssetMeta[] = [];
  let streamText = "";
  const thinkingStartedMs = Date.now();
  const thinkingStartedAt = new Date(thinkingStartedMs).toISOString();
  let logContext = { traceId, chatId: "", runId, messageId: "" };
  const result: TurnResult = {};

  const onAbort = () => updateMeta({ status: "stopping", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

    updateMeta({ status: "thinking", thinkingStartedAt });

    const [prompt, reply] = await Promise.all([
      buildPrompt(run.chatId, run.userMessageId),
      startReply(runId, run.chatId),
    ]);
    replyId = reply.id;
    logContext = { traceId, chatId: run.chatId, runId, messageId: reply.id };

    const messages: LlmMessage[] = [...prompt];
    const llmTools = getLlmTools();
    let lastSavedAt = Date.now();
    let overallToolOrder = 0;

    for (let turn = 0; turn < env.MAX_AGENT_TURNS; turn++) {
      if (signal.aborted) break;
      streamText = "";
      let isFirstTextTokenOfStep = true;
      let firstTokenAt: number | null = null;
      let firstToolCallAt: number | null = null;
      const turnToolCalls: ToolCall[] = [];

      for await (const event of streamChat(messages, signal, llmTools)) {
        if (event.type === "text-delta") {
          if (!firstTokenAt) firstTokenAt = Date.now();
          if (isFirstTextTokenOfStep) {
            isFirstTextTokenOfStep = false;
            updateMeta({ status: "working", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });
          }
          streamText += event.text;
          await textStream.append(event.text);

          const now = Date.now();
          if (now - lastSavedAt >= SAVE_PARTIAL_TEXT_EVERY_MS) {
            await savePartialContent(reply.id, contentBlocks, streamText);
            lastSavedAt = now;
          }
        } else if (event.type === "tool-call-delta") {
          if (!firstToolCallAt) firstToolCallAt = Date.now();
          const tc = (turnToolCalls[event.index] ??= { id: "", name: "", arguments: "" });
          if (event.id) tc.id = event.id;
          if (event.name) tc.name += event.name;
          if (event.arguments) tc.arguments += event.arguments;
        } else if (event.type === "usage") {
          result.usage = event;
        } else if (event.type === "done") {
          result.routedModel = event.model;
        } else if (event.type === "error") {
          result.error = { code: event.code, message: event.message, retryable: event.retryable };
          break;
        }
      }

      logger.info("agent step timing", {
        ...logContext,
        turn,
        msToFirstToken: firstTokenAt ? firstTokenAt - thinkingStartedMs : null,
        msToFirstToolCall: firstToolCallAt ? firstToolCallAt - thinkingStartedMs : null,
        toolCallsCount: turnToolCalls.length,
      });

      if (streamText.trim()) contentBlocks.push({ type: "text", text: streamText });
      const currentStepText = streamText;
      streamText = "";

      if (result.error || turnToolCalls.length === 0) break;

      for (const tc of turnToolCalls) {
        const order = overallToolOrder++;
        tc.id = tc.id?.trim() || `call_${order}`;
        tc.order = order;
      }

      messages.push({
        role: "assistant",
        content: currentStepText || null,
        tool_calls: turnToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      const exec = await executeTurnTools({
        runId,
        userId: run.userId,
        traceId,
        signal,
        toolCalls: turnToolCalls,
        toolsMetadata,
        assetsMetadata,
        onMetadataChange: () => updateMeta({ status: "working", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata }),
      });

      contentBlocks.push(...exec.contentBlocks);
      messages.push(...exec.toolMessages);

      if (exec.insufficientCreditsError) {
        result.error = exec.insufficientCreditsError;
        break;
      }

      if (turn === env.MAX_AGENT_TURNS - 1 && !result.error) {
        result.error = { code: "MAX_TURNS", message: "Stopped after too many steps.", retryable: false };
      }
    }
  } catch (crash) {
    if (signal.aborted) {
      logger.info("agent-turn aborted during execution", logContext);
    } else {
      logger.error("agent-turn crashed", { ...logContext, detail: String(crash) });
      const { chargedCredits } = await finalizeRun({
        runId,
        messageId: replyId,
        blocks: contentBlocks,
        partial: streamText,
        status: "failed",
        error: RUN_CRASHED_ERROR,
      });
      updateMeta({ status: "failed", thinkingStartedAt, error: RUN_CRASHED_ERROR, tools: toolsMetadata, assets: assetsMetadata, credits: chargedCredits });
      throw crash;
    }
  }

  if (signal.aborted) {
    await db.toolInvocation.updateMany({
      where: { runId, status: { in: ["pending", "running"] } },
      data: { status: "cancelled" },
    });
    for (const m of toolsMetadata) {
      if (m.status === "pending" || m.status === "running") {
        m.status = "cancelled";
        m.finishedAt = new Date().toISOString();
      }
    }
    const { chargedCredits } = await finalizeRun({
      runId,
      messageId: replyId,
      blocks: contentBlocks,
      partial: streamText,
      status: "cancelled",
    });
    updateMeta({
      status: "cancelled",
      thinkingStartedAt,
      tools: toolsMetadata,
      assets: assetsMetadata,
      credits: chargedCredits,
    });
    logger.info("agent-turn cancelled", { ...logContext, chargedCredits });
    return;
  }

  const status = result.error ? "failed" : "succeeded";
  const { chargedCredits } = await finalizeRun({
    runId,
    messageId: replyId,
    blocks: contentBlocks,
    partial: streamText,
    status,
    error: result.error,
    usage: result.usage,
    routedModel: result.routedModel,
  });
  updateMeta(
    result.error
      ? { status: "failed", thinkingStartedAt, error: result.error, tools: toolsMetadata, assets: assetsMetadata, credits: chargedCredits }
      : { status: "complete", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata, credits: chargedCredits },
  );
  logger.info(result.error ? "agent-turn failed" : "agent-turn succeeded", { ...logContext, code: result.error?.code, chargedCredits });
}

export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 },
  run: ({ runId, traceId }: AgentTurnPayload, { signal }) => runAgentTurn(runId, traceId, signal),
});

async function buildPrompt(chatId: string, userMessageId: string): Promise<LlmMessage[]> {
  const latest = await db.message.findMany({
    where: { chatId },
    cursor: { id: userMessageId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
  });
  const history = latest
    .reverse()
    .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: textOf(m.content) }))
    .filter((m) => m.content.trim() !== "");
  const skillsSummary = getSkillsPromptSummary();
  const systemContent = skillsSummary
    ? `${SYSTEM_PROMPT}\n\n# Available Skills\nLoad these on-demand using load_skill when the user's task matches:\n${skillsSummary}`
    : SYSTEM_PROMPT;
  return [{ role: "system", content: systemContent }, ...history];
}

async function startReply(runId: string, chatId: string) {
  const reply = await db.message.create({ data: { chatId, role: "assistant", status: "streaming", content: [] } });
  await db.agentRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date(), assistantMessageId: reply.id },
  });
  return reply;
}

function savePartialContent(messageId: string, contentBlocks: ContentBlock[], partialText: string) {
  const content = [...contentBlocks];
  if (partialText) content.push({ type: "text", text: partialText });
  const searchText = extractSearchText(content);
  return db.message.update({
    where: { id: messageId },
    data: {
      content: content as Prisma.InputJsonValue,
      searchText,
    },
  });
}

async function finalizeRun({
  runId,
  messageId,
  blocks,
  partial,
  status,
  error,
  usage,
  routedModel,
}: {
  runId: string;
  messageId?: string | null;
  blocks: ContentBlock[];
  partial: string;
  status: "succeeded" | "failed" | "cancelled";
  error?: SafeError;
  usage?: TurnResult["usage"];
  routedModel?: string;
}) {
  await refundLeakedHolds(runId).catch((e) =>
    logger.error("refundLeakedHolds failed in finalizeRun", { runId, detail: String(e) })
  );

  const content = [...blocks];
  if (partial.trim()) {
    content.push({ type: "text", text: partial });
  } else if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const toolAgg = await db.toolInvocation.aggregate({
    where: { runId },
    _sum: { credits: true },
  });
  const chargedCredits = toolAgg._sum.credits ?? 0n;

  const messageStatus = status === "succeeded" ? "complete" : status;
  const updates: Prisma.PrismaPromise<unknown>[] = [
    db.agentRun.update({
      where: { id: runId },
      data: {
        status,
        error: error ? (error as Prisma.InputJsonValue) : undefined,
        routedModel,
        usage: usage ? (usage as Prisma.InputJsonValue) : undefined,
        chargedCredits,
        finishedAt: new Date(),
      },
    }),
  ];

  if (messageId) {
    const searchText = extractSearchText(content);
    updates.push(
      db.message.update({
        where: { id: messageId },
        data: {
          status: messageStatus,
          content: content as Prisma.InputJsonValue,
          searchText,
        },
      }),
    );
  }

  await db.$transaction(updates, { timeout: 30_000, maxWait: 15_000 });
  return { chargedCredits: Number(chargedCredits) };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  const toolNames = new Map<string, string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text);
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolNames.set(block.id, block.name);
    } else if (block.type === "tool_result" && typeof block.toolUseId === "string") {
      const name = toolNames.get(block.toolUseId) ?? "tool";
      const assets = Array.isArray(block.assets) ? (block.assets as Array<{ url: string }>) : [];
      const url = assets[0]?.url;
      lines.push(url ? `[${name} result: ${url}]` : `[${name} result: ${JSON.stringify(block.output ?? {})}]`);
    }
  }
  return lines.join("\n");
}
