import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import type { Prisma } from "@prisma/client";
import { streamChat } from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { getSkillsPromptSummary } from "@/agent/skills/registry";
import { getLlmTools } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
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

export const textStream = streams.define<string>({ id: TEXT_STREAM_ID });

type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
type AssetMeta = NonNullable<RunMetadata["assets"]>[number];

export async function runAgentTurn(runId: string, traceId: string, signal = new AbortController().signal) {
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

  const thinkingStartedMs = Date.now();
  const thinkingStartedAt = new Date(thinkingStartedMs).toISOString();
  metadata.replace({ status: "thinking", thinkingStartedAt });

  const [prompt, reply] = await Promise.all([
    buildPrompt(run.chatId, run.userMessageId),
    startReply(runId, run.chatId),
  ]);
  const logContext = { traceId, chatId: run.chatId, runId, messageId: reply.id };

  const messages: LlmMessage[] = [...prompt];
  const contentBlocks: ContentBlock[] = [];
  const toolsMetadata: ToolMeta[] = [];
  const assetsMetadata: AssetMeta[] = [];
  let streamText = "";
  const llmTools = getLlmTools();

  const result: TurnResult = {};
  let lastSavedAt = Date.now();
  let overallToolOrder = 0;

  const updateWorkingMeta = () =>
    metadata.replace({ status: "working", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });

  const onAbort = () => {
    metadata.replace({
      status: "stopping",
      thinkingStartedAt,
      tools: toolsMetadata,
      assets: assetsMetadata,
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
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
            updateWorkingMeta();
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
      if (result.error || turnToolCalls.length === 0) break;

      for (const tc of turnToolCalls) {
        const order = overallToolOrder++;
        tc.id = tc.id?.trim() || `call_${order}`;
        tc.order = order;
      }

      messages.push({
        role: "assistant",
        content: streamText || null,
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
        onMetadataChange: updateWorkingMeta,
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
      await refundLeakedHolds(runId).catch((e) => logger.error("refundLeakedHolds failed in crash handler", { ...logContext, detail: String(e) }));
      const { chargedCredits } = await finishRun(runId, reply.id, contentBlocks, streamText, { error: RUN_CRASHED_ERROR });
      metadata.replace({ status: "failed", thinkingStartedAt, error: RUN_CRASHED_ERROR, tools: toolsMetadata, assets: assetsMetadata, credits: chargedCredits });
      throw crash;
    }
  }

  if (signal.aborted) {
    await refundLeakedHolds(runId).catch((e) => logger.error("refundLeakedHolds failed in cancel handler", { ...logContext, detail: String(e) }));
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
    const { chargedCredits } = await finishCancelledRun(runId, reply.id, contentBlocks, streamText);
    metadata.replace({
      status: "cancelled",
      thinkingStartedAt,
      tools: toolsMetadata,
      assets: assetsMetadata,
      credits: chargedCredits,
    });
    logger.info("agent-turn cancelled", { ...logContext, chargedCredits });
    return;
  }

  const { chargedCredits } = await finishRun(runId, reply.id, contentBlocks, streamText, result);
  metadata.replace(
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
  return db.message.update({ where: { id: messageId }, data: { content: content as unknown as Prisma.InputJsonValue } });
}

async function finishRun(runId: string, messageId: string, blocks: ContentBlock[], partial: string, res: TurnResult) {
  await refundLeakedHolds(runId).catch((e) => logger.error("refundLeakedHolds failed in finishRun", { runId, detail: String(e) }));
  const content = [...blocks];
  if (partial.trim()) {
    if (content[content.length - 1]?.type !== "text") content.push({ type: "text", text: partial });
  } else if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const toolAgg = await db.toolInvocation.aggregate({
    where: { runId },
    _sum: { credits: true },
  });
  const chargedCredits = toolAgg._sum.credits ?? 0n;

  await db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: { status: res.error ? "failed" : "complete", content: content as unknown as Prisma.InputJsonValue },
    }),
    db.agentRun.update({
      where: { id: runId },
      data: {
        status: res.error ? "failed" : "succeeded",
        error: res.error ? (res.error as unknown as Prisma.InputJsonValue) : undefined,
        routedModel: res.routedModel,
        usage: res.usage ? (res.usage as unknown as Prisma.InputJsonValue) : undefined,
        chargedCredits,
        finishedAt: new Date(),
      },
    }),
  ]);

  return { chargedCredits: Number(chargedCredits) };
}

async function finishCancelledRun(runId: string, messageId: string, blocks: ContentBlock[], partial: string) {
  const content = [...blocks];
  if (partial.trim()) {
    if (content[content.length - 1]?.type !== "text") content.push({ type: "text", text: partial });
  } else if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const toolAgg = await db.toolInvocation.aggregate({
    where: { runId, status: "succeeded" },
    _sum: { credits: true },
  });
  const chargedCredits = toolAgg._sum.credits ?? 0n;

  await db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: { status: "cancelled", content: content as unknown as Prisma.InputJsonValue },
    }),
    db.agentRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        chargedCredits,
        finishedAt: new Date(),
      },
    }),
  ]);

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
    } else if (block.type === "tool_result" && typeof block.toolUseId === "string" && block.output && typeof block.output === "object") {
      const name = toolNames.get(block.toolUseId) ?? "tool";
      const out = block.output as Record<string, unknown>;
      const url = (out.image_url || out.video_url || (Array.isArray(out.images) && out.images[0])) as string | undefined;
      lines.push(url ? `[${name} result: ${url}]` : `[${name} result: ${JSON.stringify(block.output)}]`);
    }
  }
  return lines.join("\n");
}
