import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import type { MessageRole } from "@prisma/client";
import { streamChat } from "@/agent/llm";
import {
  MAX_HISTORY_MESSAGES,
  RUN_CRASHED_ERROR,
  SAVE_PARTIAL_TEXT_EVERY_MS,
  SYSTEM_PROMPT,
  TERMINAL_RUN_STATUSES,
  TEXT_STREAM_ID,
} from "@/lib/constants";
import { db } from "@/lib/db";
import type { AgentTurnPayload, LlmMessage, TurnResult } from "@/lib/types";

export const textStream = streams.define<string>({ id: TEXT_STREAM_ID });

export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 }, 
  run: async ({ runId, traceId }: AgentTurnPayload, { signal }) => {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

    const thinkingStartedAt = new Date().toISOString();
    metadata.replace({ status: "thinking", thinkingStartedAt });

    const [prompt, reply] = await Promise.all([
      buildPrompt(run.chatId, run.userMessageId),
      startReply(runId, run.chatId),
    ]);
    const logContext = { traceId, chatId: run.chatId, runId, messageId: reply.id };
    logger.info("agent-turn started", logContext);

    let text = "";
    let lastSavedAt = Date.now();
    const result: TurnResult = {};

    try {
      for await (const event of streamChat(prompt, signal)) {
        if (event.type === "text-delta") {
          if (!text) metadata.replace({ status: "working", thinkingStartedAt });
          text += event.text;
          await textStream.append(event.text);
          if (Date.now() - lastSavedAt > SAVE_PARTIAL_TEXT_EVERY_MS) {
            await saveText(reply.id, text);
            lastSavedAt = Date.now();
          }
        }
        if (event.type === "usage") result.usage = event;
        if (event.type === "done") result.routedModel = event.model;
        if (event.type === "error") result.error = { code: event.code, message: event.message, retryable: event.retryable };
      }
    } catch (crash) {
      logger.error("agent-turn crashed", { ...logContext, detail: String(crash) });
      await finishRun(runId, reply.id, text, { error: RUN_CRASHED_ERROR });
      metadata.replace({ status: "failed", thinkingStartedAt, error: RUN_CRASHED_ERROR });
      throw crash;
    }

    await finishRun(runId, reply.id, text, result);
    metadata.replace(
      result.error
        ? { status: "failed", thinkingStartedAt, error: result.error }
        : { status: "complete", thinkingStartedAt },
    );
    logger.info(result.error ? "agent-turn failed" : "agent-turn succeeded", { ...logContext, code: result.error?.code });
  },
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
    .map((message) => ({ role: toLlmRole(message.role), content: textOf(message.content) }))
    .filter((message) => message.content.trim() !== "");
  return [{ role: "system", content: SYSTEM_PROMPT }, ...history];
}

async function startReply(runId: string, chatId: string) {
  const reply = await db.message.create({ data: { chatId, role: "assistant", status: "streaming", content: [] } });
  await db.agentRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date(), assistantMessageId: reply.id },
  });
  return reply;
}

function saveText(messageId: string, text: string) {
  return db.message.update({ where: { id: messageId }, data: { content: [{ type: "text", text }] } });
}

function finishRun(runId: string, messageId: string, text: string, { error, routedModel, usage }: TurnResult) {
  return db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: { status: error ? "failed" : "complete", content: [{ type: "text", text }] },
    }),
    db.agentRun.update({
      where: { id: runId },
      data: { status: error ? "failed" : "succeeded", error, routedModel, usage, finishedAt: new Date() },
    }),
  ]);
}

function toLlmRole(role: MessageRole): LlmMessage["role"] {
  return role === "assistant" ? "assistant" : "user";
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}
