import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import type { RunMetadata as TriggerMetadata } from "@trigger.dev/sdk";
import type { Prisma } from "@prisma/client";
import { generateChatTitle, generateSuggestion, streamChat, summarizeReasoning } from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { getSkillsPromptSummary } from "@/agent/skills/registry";
import { getLlmTools } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import {
  DEFAULT_CHAT_TITLE,
  FOLLOW_UP_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES,
  REASONING_RENDER_KEY,
  REASONING_STREAM_ID,
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
import { deriveTitle, extractSearchText } from "@/modules/messages/messages";

export const textStream = streams.define<string>({ id: TEXT_STREAM_ID });
// The model's thinking, shown live under the "Thinking" toggle like Magica.
export const reasoningStream = streams.define<string>({ id: REASONING_STREAM_ID });

type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
type AssetMeta = NonNullable<RunMetadata["assets"]>[number];
type ReasoningBlock = Extract<ContentBlock, { type: "reasoning" }>;

export async function runAgentTurn(runId: string, traceId: string, signal = new AbortController().signal) {
  let replyId: string | null = null;
  let savedChatTitle: string | undefined;
  let titlePromise: Promise<void> | null = null;
  const contentBlocks: ContentBlock[] = [];
  const toolsMetadata: ToolMeta[] = [];
  const assetsMetadata: AssetMeta[] = [];
  let streamText = "";
  const liveText = openLiveStream(textStream);
  const liveReasoning = openLiveStream(reasoningStream);
  const closeLiveStreams = () => Promise.all([liveText.close(), liveReasoning.close()]);
  const pendingStepTitles: Promise<void>[] = [];
  const thinkingStartedMs = Date.now();
  const thinkingStartedAt = new Date(thinkingStartedMs).toISOString();

  const updateMeta = (patch: RunMetadata) => {
    try {
      const current = (metadata.current() ?? {}) as TriggerMetadata;
      const plan = (current as { plan?: RunMetadata["plan"] }).plan;
      const liveChatTitle = (current as { chatTitle?: string }).chatTitle ?? savedChatTitle;
      const merged: RunMetadata = {
        ...patch,
        ...(plan && !patch.plan ? { plan } : {}),
        ...(liveChatTitle && !patch.chatTitle ? { chatTitle: liveChatTitle } : {}),
      };
      metadata.replace(merged as TriggerMetadata);
    } catch {
      metadata.replace(patch as TriggerMetadata);
    }
  };

  // Magica shows the thinking before a tool call as its own grey step, with the raw text
  // until a few-word title arrives.
  const addReasoningStep = (block: ReasoningBlock, id: string, startedAt: string): ToolMeta => {
    const step: ToolMeta = {
      id,
      name: REASONING_RENDER_KEY,
      renderKey: REASONING_RENDER_KEY,
      status: "succeeded",
      startedAt,
      finishedAt: new Date().toISOString(),
      text: block.text,
    };
    toolsMetadata.push(step);
    updateMeta({ status: "working", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });
    return step;
  };

  // Runs while the tools run. Sets the title on the live step and on the block that gets saved.
  const addStepTitle = async (step: ToolMeta, block: ReasoningBlock) => {
    const title = await summarizeReasoning(block.text);
    if (!title) return;
    step.label = title;
    block.title = title;
    // Only touch `tools`: a full replace here could wipe a question card that is showing.
    try {
      metadata.set("tools", toolsMetadata as unknown as Parameters<typeof metadata.set>[1]);
    } catch {
      // metadata only works inside a running Trigger task
    }
  };

  let logContext: { traceId: string; chatId: string; runId: string; messageId: string; waitpointTokenId?: string } = {
    traceId,
    chatId: "",
    runId,
    messageId: "",
  };
  const result: TurnResult = {};

  const onAbort = () => updateMeta({ status: "stopping", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

    updateMeta({ status: "thinking", thinkingStartedAt });

    const [prompt, reply] = await Promise.all([
      buildPrompt(run.chatId, run.userMessageId, run.planMode),
      startReply(runId, run.chatId),
    ]);
    replyId = reply.id;
    logContext = { traceId, chatId: run.chatId, runId, messageId: reply.id };

    // 1. Title: for the FIRST message of a chat, start the title call at the START of the run, in parallel
    const previousRepliesCount = await db.message.count({
      where: {
        chatId: run.chatId,
        role: "assistant",
        id: { not: reply.id },
      },
    });
    const isFirstMessage = previousRepliesCount === 0;

    if (isFirstMessage) {
      const userMsg = await db.message.findUnique({ where: { id: run.userMessageId } });
      const userText = userMsg ? textOf(userMsg.content).trim() : "";
      const chat = await db.chat.findUnique({ where: { id: run.chatId } });

      if (chat && userText) {
        const defaultOrFirst = deriveTitle(userText);
        const isDefaultOrFirst =
          chat.title === DEFAULT_CHAT_TITLE ||
          chat.title === defaultOrFirst ||
          chat.title.trim() === "";

        if (isDefaultOrFirst) {
          titlePromise = (async () => {
            try {
              const title = await generateChatTitle(userText);
              if (title) {
                const freshChat = await db.chat.findUnique({ where: { id: run.chatId } });
                if (
                  freshChat &&
                  (freshChat.title === DEFAULT_CHAT_TITLE ||
                    freshChat.title === defaultOrFirst ||
                    freshChat.title.trim() === "")
                ) {
                  await db.chat.update({
                    where: { id: run.chatId },
                    data: { title },
                  });
                  savedChatTitle = title;
                  try {
                    metadata.set("chatTitle", title);
                  } catch {
                    // ignore
                  }
                  updateMeta({
                    ...((metadata.current() ?? {}) as RunMetadata),
                    chatTitle: title,
                  });
                }
              }
            } catch (err) {
              logger.warn("failed to generate title", { runId, detail: String(err) });
            }
          })();
        }
      }
    }

    const messages: LlmMessage[] = [...prompt];
    const llmTools = getLlmTools();
    let lastSavedAt = Date.now();
    let overallToolOrder = 0;
    let planApproved = false;

    for (let turn = 0; turn < env.MAX_AGENT_TURNS; turn++) {
      if (signal.aborted) break;
      streamText = "";
      let stepReasoning = "";
      const stepStartedAt = new Date().toISOString();
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
          liveText.write(event.text);

          const now = Date.now();
          if (now - lastSavedAt >= SAVE_PARTIAL_TEXT_EVERY_MS) {
            await savePartialContent(reply.id, contentBlocks, streamText);
            lastSavedAt = now;
          }
        } else if (event.type === "reasoning-delta") {
          stepReasoning += event.text;
          liveReasoning.write(event.text);
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

      const reasoningBlock: ReasoningBlock | null = stepReasoning.trim() ? { type: "reasoning", text: stepReasoning } : null;
      if (reasoningBlock) contentBlocks.push(reasoningBlock);
      if (streamText.trim()) contentBlocks.push({ type: "text", text: streamText });
      const currentStepText = streamText;
      streamText = "";

      if (result.error || turnToolCalls.length === 0) break;
      if (reasoningBlock) {
        const step = addReasoningStep(reasoningBlock, `reasoning_${turn}`, stepStartedAt);
        pendingStepTitles.push(addStepTitle(step, reasoningBlock));
      }

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
        planMode: run.planMode && !planApproved,
        planApproved,
        onMetadataChange: () => updateMeta({ status: "working", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata }),
      });

      if (exec.planApproved) {
        planApproved = true;
      }

      contentBlocks.push(...exec.contentBlocks);
      messages.push(...exec.toolMessages);

      const latestWaitpoint = await db.waitpoint.findFirst({
        where: { runId },
        orderBy: { createdAt: "desc" },
        select: { tokenId: true },
      });
      if (latestWaitpoint?.tokenId) {
        logContext.waitpointTokenId = latestWaitpoint.tokenId;
      }

      if (exec.insufficientCreditsError) {
        result.error = exec.insufficientCreditsError;
        break;
      }

      if (exec.waitpointExpiredError) {
        result.error = exec.waitpointExpiredError;
        contentBlocks.push({
          type: "text",
          text: exec.waitpointExpiredError.message,
        });
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
      await closeLiveStreams();
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
    await closeLiveStreams();
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

  // Let step titles land in the saved message; a slow title call just leaves the raw text.
  await waitAtMost(Promise.all(pendingStepTitles), FOLLOW_UP_TIMEOUT_MS);

  await closeLiveStreams();

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
      : {
          status: "complete",
          thinkingStartedAt,
          tools: toolsMetadata,
          assets: assetsMetadata,
          credits: chargedCredits,
          ...(savedChatTitle ? { chatTitle: savedChatTitle } : {}),
        },
  );

  // 2. Suggestion: generate it AFTER finalizeRun + the final "complete" metadata
  if (status === "succeeded" && replyId) {
    try {
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
      const userMsg = await db.message.findUnique({ where: { id: run.userMessageId } });
      const userText = userMsg ? textOf(userMsg.content).trim() : "";
      const replyText = textOf(contentBlocks).trim();
      const suggestion = await generateSuggestion(userText, replyText);
      if (suggestion) {
        await db.message.update({
          where: { id: replyId },
          data: { suggestion },
        });
        try {
          metadata.set("suggestion", suggestion);
        } catch {
          // ignore
        }
        updateMeta({
          ...((metadata.current() ?? {}) as RunMetadata),
          suggestion,
        });
      }
    } catch (err) {
      logger.warn("failed to generate suggestion", { runId, detail: String(err) });
    }
  }

  // 4. Make sure the task waits for the pending title promise before it ends
  if (titlePromise) await waitAtMost(titlePromise, FOLLOW_UP_TIMEOUT_MS);

  logger.info(result.error ? "agent-turn failed" : "agent-turn succeeded", { ...logContext, code: result.error?.code, chargedCredits });
}

export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 },
  run: ({ runId, traceId }: AgentTurnPayload, { signal }) => runAgentTurn(runId, traceId, signal),
});

// One open stream per run, opened on the first write. `stream.append()` sends a new request
// per call and waits for it, far too slow token by token: a reasoning model sends hundreds
// of small chunks, and the reply only showed up after all of them had gone out.
function openLiveStream(stream: typeof textStream) {
  let source: ReadableStreamDefaultController<string> | null = null;
  let sent: Promise<unknown> | null = null;

  return {
    write(text: string) {
      if (!source) {
        const body = new ReadableStream<string>({ start: (controller) => void (source = controller) });
        try {
          sent = stream.pipe(body).waitUntilComplete();
        } catch {
          // realtime streams only work inside a running Trigger task
        }
      }
      if (sent) source?.enqueue(text);
    },
    async close() {
      if (!sent || !source) return;
      source.close();
      source = null;
      await waitAtMost(sent, FOLLOW_UP_TIMEOUT_MS);
    },
  };
}

// Waits for the work, but never longer than `ms`. A failure or a timeout just moves on.
function waitAtMost(work: Promise<unknown>, ms: number) {
  return Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function buildPrompt(chatId: string, userMessageId: string, planMode = false): Promise<LlmMessage[]> {
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
  let systemContent = skillsSummary
    ? `${SYSTEM_PROMPT}\n\n# Available Skills\nLoad these on-demand using load_skill when the user's task matches:\n${skillsSummary}`
    : SYSTEM_PROMPT;
  if (planMode) {
    systemContent += "\n\n# Plan Mode\nResearch first (check models and prices), then call submit_plan. Don't run any paid tool until the plan is approved.";
  }
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
