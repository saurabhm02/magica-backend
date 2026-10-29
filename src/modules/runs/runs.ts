import type { AgentRun } from "@prisma/client";
import { auth, runs, tasks } from "@trigger.dev/sdk";
import type { agentTurn } from "@/trigger/agent-turn";
import {
  ACTIVE_RUN_STATUSES,
  DISPATCH_FAILED_ERROR,
  SAFE_ERROR_MESSAGES,
  STALE_RUN_AFTER_MS,
  TERMINAL_RUN_STATUSES,
} from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getOwnedChat } from "@/modules/chats/chats";
import { refundLeakedHolds } from "@/modules/credits/credits";

export async function dispatchRun(run: AgentRun, traceId: string) {
  if (run.triggerRunId) {
    const accessToken = await auth.createPublicToken({ scopes: { read: { runs: [run.triggerRunId] } } });
    return { runId: run.triggerRunId, accessToken };
  }

  let handleId: string | null = null;
  let publicAccessToken: string | undefined;
  try {
    const handle = await tasks.trigger<typeof agentTurn>(
      "agent-turn",
      { runId: run.id, traceId },
      { idempotencyKey: run.id },
    );
    handleId = handle.id;
    publicAccessToken = handle.publicAccessToken;
    await db.agentRun.update({ where: { id: run.id }, data: { triggerRunId: handle.id } });
    return { runId: handle.id, accessToken: handle.publicAccessToken };
  } catch (error) {
    if (handleId) {
      logger.error("saving triggerRunId failed after trigger succeeded", {
        traceId,
        chatId: run.chatId,
        runId: run.id,
        handleId,
        message: (error as Error).message,
      });
      return { runId: handleId, accessToken: publicAccessToken };
    }
    logger.error("dispatch failed", { traceId, chatId: run.chatId, runId: run.id, message: (error as Error).message });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "failed", error: DISPATCH_FAILED_ERROR, finishedAt: new Date() },
    });
    throw new AppError(DISPATCH_FAILED_ERROR.code, DISPATCH_FAILED_ERROR.message, DISPATCH_FAILED_ERROR.retryable);
  }
}

export async function cancelAgentRun(userId: string, chatId: string, runId: string) {
  await getOwnedChat(userId, chatId);

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

  const updated = await db.agentRun.updateMany({
    where: { id: run.id, status: { in: ACTIVE_RUN_STATUSES } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
  if (updated.count > 0) {
    if (run.assistantMessageId) {
      await db.message.updateMany({
        where: { id: run.assistantMessageId, status: "streaming" },
        data: { status: "cancelled" },
      });
    }
    await refundLeakedHolds(run.id).catch((err) =>
      logger.error("refundLeakedHolds failed in cancelAgentRun", { runId: run.id, detail: String(err) })
    );
  }

  return { runId: run.id, status: "cancelled" as const };
}

export async function getActiveAgentRun(userId: string, chatId: string) {
  await getOwnedChat(userId, chatId);

  const run = await db.agentRun.findFirst({
    where: {
      chatId,
      status: { in: ACTIVE_RUN_STATUSES },
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

export async function recoverStaleRun(chatId: string): Promise<boolean> {
  const activeRun = await db.agentRun.findFirst({
    where: { chatId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { createdAt: "desc" },
  });

  if (!activeRun) return false;

  let isStale = Date.now() - activeRun.updatedAt.getTime() > STALE_RUN_AFTER_MS;
  if (!isStale && activeRun.triggerRunId) {
    try {
      const triggerRun = await runs.retrieve(activeRun.triggerRunId);
      const st = triggerRun.status.toUpperCase();
      isStale = ["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "SYSTEM_FAILURE", "TIMED_OUT", "CRASHED", "EXPIRED"].includes(st);
    } catch (err) {
      logger.warn("failed to retrieve triggerRun for active check", {
        triggerRunId: activeRun.triggerRunId,
        detail: String(err),
      });
    }
  }

  if (!isStale) return false;

  logger.info("recovering stale run", { runId: activeRun.id, chatId });
  await db.agentRun.update({
    where: { id: activeRun.id },
    data: {
      status: "failed",
      error: { code: "STALE_RUN", message: SAFE_ERROR_MESSAGES.STALE_RUN, retryable: false },
      finishedAt: new Date(),
    },
  });
  if (activeRun.assistantMessageId) {
    await db.message.updateMany({
      where: { id: activeRun.assistantMessageId, status: "streaming" },
      data: { status: "failed" },
    });
  }
  await refundLeakedHolds(activeRun.id).catch((err) =>
    logger.error("refundLeakedHolds failed for stale run", { runId: activeRun.id, detail: String(err) })
  );

  return true;
}
