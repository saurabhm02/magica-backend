import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import type { RunMetadata as TriggerMetadata } from "@trigger.dev/sdk";
import type { Attachment, Prisma } from "@prisma/client";
import { generateChatTitle, generateSuggestion, streamChatWithFallback, summarizeReasoning } from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { getSkillsPromptSummary } from "@/agent/skills/registry";
import { getLlmTools } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import {
  DEFAULT_CHAT_TITLE,
  FOLLOW_UP_TIMEOUT_MS,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES,
  MAX_VISION_IMAGE_BYTES,
  REASONING_RENDER_KEY,
  REASONING_STREAM_ID,
  RUN_CRASHED_ERROR,
  SAFE_ERROR_MESSAGES,
  SAVE_PARTIAL_TEXT_EVERY_MS,
  SYSTEM_PROMPT,
  TERMINAL_RUN_STATUSES,
  TEXT_STREAM_ID,
  VISION_MODELS,
} from "@/lib/constants";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { AgentTurnPayload, LlmMessage, ToolCall, TurnResult } from "@/lib/types";
import { refundLeakedHolds } from "@/modules/credits/credits";
import { deriveTitle, extractSearchText } from "@/modules/messages/messages";
import { emitWebhook } from "@/modules/webhooks/webhooks";

export const textStream = streams.define<string>({ id: TEXT_STREAM_ID });
// The model's thinking, shown live under the "Thinking" toggle like Magica.
export const reasoningStream = streams.define<string>({ id: REASONING_STREAM_ID });

type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
type AssetMeta = NonNullable<RunMetadata["assets"]>[number];
type ReasoningBlock = Extract<ContentBlock, { type: "reasoning" }>;

/**
 * Runs one agent turn end to end: stream the model's reply, run any tools it asks for,
 * loop until it is done, then save the final reply and settle the run.
 *
 * Input:
 * - runId: the agent run to execute
 * - traceId: request trace id, for logs
 * - signal: aborts the turn when the run is cancelled
 * - processId: the Trigger.dev run id, for logs
 *
 * Output:
 * - nothing; results go to the database, run metadata, live streams and webhooks
 *
 * Notes:
 * - A run that already finished is skipped, so a repeat delivery does nothing.
 * - Text and reasoning stream live; partial text is saved every SAVE_PARTIAL_TEXT_EVERY_MS.
 * - Stops on: no tool calls, a model error, insufficient credits, an expired waitpoint,
 *   or MAX_AGENT_TURNS (MAX_TURNS error).
 * - Cancel → open tools marked cancelled, run saved as cancelled. Crash → saved as failed, then rethrown.
 * - The first reply in a chat also gets a generated title; a successful reply gets a follow-up suggestion.
 */
export async function runAgentTurn(
  runId: string,
  traceId: string,
  signal = new AbortController().signal,
  processId?: string,
) {
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

  let logContext: {
    traceId: string;
    chatId: string;
    runId: string;
    messageId: string;
    processId?: string;
    waitpointTokenId?: string;
  } = {
    traceId,
    chatId: "",
    runId,
    messageId: "",
    processId,
  };
  const result: TurnResult = {};

  const onAbort = () => updateMeta({ status: "stopping", thinkingStartedAt, tools: toolsMetadata, assets: assetsMetadata });
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

    updateMeta({ status: "thinking", thinkingStartedAt });
    await emitWebhook({
      agentRunId: run.id,
      event: "run.started",
      data: {
        status: "running",
        toolName: null,
        output: null,
        creditUsed: null,
        finishedAt: null,
      },
    });

    const [prompt, reply] = await Promise.all([
      buildPrompt(run.chatId, run.userMessageId, run.planMode),
      startReply(runId, run.chatId),
    ]);
    replyId = reply.id;
    logContext = { traceId, chatId: run.chatId, runId, messageId: reply.id, processId };

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
    const hasImages = prompt.some(isMessageWithImages);
    const models = hasImages ? VISION_MODELS : [env.LLM_MODEL];
    const allTools = getLlmTools();
    const planningTools = getLlmTools({ withoutPaidTools: true });
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

      const llmTools = run.planMode && !planApproved ? planningTools : allTools;
      for await (const event of streamChatWithFallback(models, messages, signal, llmTools)) {
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
          result.error = hasImages
            ? { code: "VISION_UNAVAILABLE", message: SAFE_ERROR_MESSAGES.VISION_UNAVAILABLE!, retryable: true }
            : { code: event.code, message: event.message, retryable: event.retryable };
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

      // Some free models leak tool-call markup like "</tool_calls>" into their thinking; that isn't a real thought.
      const hasRealReasoning = stepReasoning.replace(/<\/?tool_calls?>/g, "").trim() !== "";
      const reasoningBlock: ReasoningBlock | null = hasRealReasoning ? { type: "reasoning", text: stepReasoning } : null;
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
      await emitWebhook({
        agentRunId: runId,
        event: "run.failed",
        data: {
          status: "failed",
          toolName: null,
          output: null,
          creditUsed: Number(chargedCredits),
          finishedAt: new Date().toISOString(),
        },
      });
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
    await emitWebhook({
      agentRunId: runId,
      event: "run.canceled",
      data: {
        status: "cancelled",
        toolName: null,
        output: null,
        creditUsed: Number(chargedCredits),
        finishedAt: new Date().toISOString(),
      },
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

  if (result.error) {
    await emitWebhook({
      agentRunId: runId,
      event: "run.failed",
      data: {
        status: "failed",
        toolName: null,
        output: null,
        creditUsed: Number(chargedCredits),
        finishedAt: new Date().toISOString(),
      },
    });
  } else {
    await emitWebhook({
      agentRunId: runId,
      event: "run.completed",
      data: {
        status: "succeeded",
        toolName: null,
        output: { blocks: contentBlocks, text: streamText },
        creditUsed: Number(chargedCredits),
        finishedAt: new Date().toISOString(),
      },
    });
  }

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

/**
 * Trigger.dev task that runs one agent turn. No retries: a retry could repeat paid tool calls.
 */
export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 },
  run: ({ runId, traceId }: AgentTurnPayload, { signal, ctx }) => runAgentTurn(runId, traceId, signal, ctx.run.id),
});

/**
 * Opens one live stream per run, started on the first write.
 * `stream.append()` sends a new request per call and waits for it, far too slow token by token:
 * a reasoning model sends hundreds of small chunks, and the reply only showed up after all of
 * them had gone out.
 *
 * Input:
 * - stream: the Trigger.dev stream to write to (text or reasoning)
 *
 * Output:
 * - { write, close }: write(text) adds a chunk; close() ends the stream and waits at most
 *   FOLLOW_UP_TIMEOUT_MS for it to flush
 *
 * Notes:
 * - Outside a running Trigger task, writes are silently dropped.
 */
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

/**
 * Waits for the work, but never longer than `ms`. A failure or a timeout just moves on.
 *
 * Input:
 * - work: the promise to wait for
 * - ms: the longest wait, in milliseconds
 *
 * Output:
 * - a promise that always resolves, never rejects
 */
function waitAtMost(work: Promise<unknown>, ms: number) {
  return Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Builds the message list sent to the model for this turn.
 *
 * Input:
 * - chatId: the chat
 * - userMessageId: the user message being answered (history is read back from here)
 * - planMode: when true, adds the plan-mode instructions to the system prompt
 *
 * Output:
 * - the system prompt (with the skills summary) followed by up to MAX_HISTORY_MESSAGES
 *   past messages, oldest first
 *
 * Notes:
 * - Empty messages are skipped. Attachment links are added to each message's text.
 * - Only the message being answered carries the images themselves; older ones keep just the links.
 */
export async function buildPrompt(chatId: string, userMessageId: string, planMode = false): Promise<LlmMessage[]> {
  const latest = await db.message.findMany({
    where: { chatId },
    cursor: { id: userMessageId },
    include: { attachments: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
  });

  const history: LlmMessage[] = [];
  const earlierMedia: string[] = [];
  for (const m of latest.reverse()) {
    if (m.role === "assistant") {
      // Replies go back as their text only. Writing tool results into the model's own past
      // replies taught weak models to type fake "[tool result: url]" lines instead of calling tools.
      earlierMedia.push(...mediaLinesOf(m.content));
      const reply = replyTextOf(m.content);
      if (reply.trim()) history.push({ role: "assistant", content: reply });
      continue;
    }
    const text = withAttachedLine(textOf(m.content), m.attachments);
    if (!text.trim()) continue;
    // Only the message being answered carries the images themselves; older ones keep just the
    // links, so a long chat doesn't resend every image on every turn.
    const images = m.id === userMessageId ? await toImageParts(m.attachments) : [];
    history.push({ role: "user", content: images.length ? [{ type: "text", text }, ...images] : text });
  }

  const skillsSummary = getSkillsPromptSummary();
  let systemContent = skillsSummary
    ? `${SYSTEM_PROMPT}\n\n# Available Skills\nLoad these on-demand using load_skill when the user's task matches:\n${skillsSummary}`
    : SYSTEM_PROMPT;
  if (planMode) {
    systemContent +=
      "\n\n# Plan Mode\nResearch first (check models and prices), then call the submit_plan tool with the steps. " +
      "Never write the plan as plain text: the user approves it in the plan card that submit_plan shows. " +
      "Paid tools become available only after the plan is approved.";
  }
  if (earlierMedia.length > 0) {
    systemContent += `\n\n# Media made earlier in this chat\nUse these exact URLs when the user refers to them:\n${earlierMedia.join("\n")}`;
  }
  return [{ role: "system", content: systemContent }, ...history];
}

// The links stay in the text so tools like crop_image can use them.
function withAttachedLine(text: string, attachments: Attachment[]) {
  if (attachments.length === 0) return text;
  const attached = attachments.map((a, i) => `${i + 1}. ${a.kind} ${a.name} ${a.url}`).join(", ");
  return text.trim() ? `${text}\nAttached: ${attached}` : `Attached: ${attached}`;
}

/**
 * Turns image attachments into inline base64 image parts for the model.
 * Images go inline because some model hosts can't download links.
 *
 * Input:
 * - attachments: the message's attachments
 *
 * Output:
 * - image_url parts, one per image that was downloaded
 *
 * Notes:
 * - An image over MAX_VISION_IMAGE_BYTES, or one that can't be downloaded in time, is left out;
 *   the model still has its link.
 */
async function toImageParts(attachments: Attachment[]) {
  const images = attachments.filter((a) => a.kind === "image" && a.sizeBytes <= MAX_VISION_IMAGE_BYTES);
  const parts = await Promise.all(
    images.map(async (a) => {
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) return null;
        const data = Buffer.from(await res.arrayBuffer()).toString("base64");
        return { type: "image_url" as const, image_url: { url: `data:${a.mimeType};base64,${data}` } };
      } catch {
        return null;
      }
    }),
  );
  return parts.filter((part) => part !== null);
}

function isMessageWithImages(message: LlmMessage) {
  return Array.isArray(message.content) && message.content.some((part) => part.type === "image_url");
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

/**
 * Saves the end state of a run and its reply in one transaction.
 *
 * Input:
 * - runId, messageId: the run and its assistant reply (messageId may be missing if the run crashed early)
 * - blocks, partial: the saved content blocks plus any unsaved streamed text
 * - status: succeeded, failed or cancelled
 * - error, usage, routedModel: optional details stored on the run
 *
 * Output:
 * - { chargedCredits }: the total credits charged by this run's tool calls
 *
 * Notes:
 * - Refunds any credit holds still open first (a failure there is only logged).
 * - A reply with no content is saved with one empty text block.
 */
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

// The text the assistant actually wrote, without tool calls or results.
function replyTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

// One "- tool: url" line per media file a tool made, for the "media made earlier" list.
function mediaLinesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const toolNames = new Map<string, string>();
  const lines: string[] = [];
  for (const block of content) {
    if (block?.type === "tool_use") toolNames.set(block.id, block.name);
    if (block?.type === "tool_result" && Array.isArray(block.assets)) {
      for (const asset of block.assets as Array<{ url: string }>) {
        lines.push(`- ${toolNames.get(block.toolUseId) ?? "tool"}: ${asset.url}`);
      }
    }
  }
  return lines;
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
