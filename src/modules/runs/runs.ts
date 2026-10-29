import type { AgentRun } from "@prisma/client";
import { auth, runs, tasks } from "@trigger.dev/sdk";
import type { agentTurn } from "@/trigger/agent-turn";
import { DISPATCH_FAILED_ERROR, TERMINAL_RUN_STATUSES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";


export async function dispatchRun(run: AgentRun, traceId: string) {
  if (run.triggerRunId) {
    const accessToken = await auth.createPublicToken({ scopes: { read: { runs: [run.triggerRunId] } } });
    return { runId: run.triggerRunId, accessToken };
  }

  try {
    const handle = await tasks.trigger<typeof agentTurn>(
      "agent-turn",
      { runId: run.id, traceId },
      { idempotencyKey: run.id },
    );
    await db.agentRun.update({ where: { id: run.id }, data: { triggerRunId: handle.id } });
    return { runId: handle.id, accessToken: handle.publicAccessToken };
  } catch (error) {
    logger.error("dispatch failed", { traceId, chatId: run.chatId, runId: run.id, message: (error as Error).message });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "failed", error: DISPATCH_FAILED_ERROR, finishedAt: new Date() },
    });
    throw new AppError(DISPATCH_FAILED_ERROR.code, DISPATCH_FAILED_ERROR.message, DISPATCH_FAILED_ERROR.retryable);
  }
}

export async function cancelAgentRun(userId: string, chatId: string, runId: string) {
  const chat = await db.chat.findUnique({
    where: { id: chatId, userId, deletedAt: null },
  });
  if (!chat) {
    throw new AppError("NOT_FOUND", "Chat not found", false);
  }

  const run = await db.agentRun.findUnique({
    where: { id: runId, chatId },
  });
  if (!run) {
    throw new AppError("NOT_FOUND", "Run not found", false);
  }

  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    return { runId: run.id, status: run.status };
  }

  if (run.triggerRunId) {
    try {
      await runs.cancel(run.triggerRunId);
    } catch (err) {
      logger.warn("runs.cancel failed or already finished", {
        runId,
        triggerRunId: run.triggerRunId,
        detail: String(err),
      });
    }
  }

  return { runId: run.id, status: "cancelled" as const };
}

export async function getActiveAgentRun(userId: string, chatId: string) {
  const chat = await db.chat.findUnique({
    where: { id: chatId, userId, deletedAt: null },
  });
  if (!chat) {
    throw new AppError("NOT_FOUND", "Chat not found", false);
  }

  const run = await db.agentRun.findFirst({
    where: {
      chatId,
      status: { in: ["queued", "running", "waiting"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!run) return null;

  let accessToken = "";
  if (run.triggerRunId) {
    try {
      accessToken = await auth.createPublicToken({
        scopes: { read: { runs: [run.triggerRunId] } },
      });
    } catch (err) {
      logger.warn("createPublicToken failed for active run", {
        runId: run.id,
        triggerRunId: run.triggerRunId,
        detail: String(err),
      });
    }
  }

  return {
    runId: run.id,
    triggerRunId: run.triggerRunId ?? "",
    accessToken,
    status: run.status,
  };
}
