import type { AgentRun } from "@prisma/client";
import type { SafeError } from "@/contracts/errors";
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
import { getPendingWaitpointForRun } from "@/modules/waitpoints/waitpoints";
import { emitWebhook } from "@/modules/webhooks/webhooks";

/**
 * Hands a queued run to the Trigger.dev "agent-turn" task and returns a token the client
 * can use to watch it live.
 *
 * Input:
 * - run: the saved agent run
 * - traceId: request trace id, passed through for logs
 *
 * Output:
 * - { runId, accessToken }: the Trigger run id and a read-only public token for it
 *
 * Notes:
 * - Already dispatched (triggerRunId set) → returns a fresh token, never triggers again.
 * - The trigger call uses the run id as idempotency key, so a retry can't start a second job.
 * - If triggering fails, the run is marked failed, a run.failed webhook is sent, and
 *   the dispatch error is thrown.
 */
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
    await emitWebhook({
      agentRunId: run.id,
      event: "run.failed",
      data: {
        status: "failed",
        toolName: null,
        output: null,
        creditUsed: 0,
        finishedAt: new Date().toISOString(),
      },
    });
    throw new AppError(DISPATCH_FAILED_ERROR.code, DISPATCH_FAILED_ERROR.message, DISPATCH_FAILED_ERROR.retryable);
  }
}

/**
 * Stops a run the user asked to cancel.
 *
 * Input:
 * - userId: the signed-in user
 * - chatId: the chat the run belongs to (must belong to this user)
 * - runId: the run to cancel
 *
 * Output:
 * - { runId, status }: "cancelled", or the run's current status if it had already finished
 *
 * Notes:
 * - Unknown run → NOT_FOUND. A finished run is left as it is (safe to call twice).
 * - Cancels the Trigger.dev job first; a failure there is only logged.
 * - Only the call that actually flips the status marks the reply cancelled, refunds any
 *   held credits and sends the run.canceled webhook, so these happen once.
 */
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
    await emitWebhook({
      agentRunId: run.id,
      event: "run.canceled",
      data: {
        status: "cancelled",
        toolName: null,
        output: null,
        creditUsed: Number(run.chargedCredits),
        finishedAt: new Date().toISOString(),
      },
    });
  }

  return { runId: run.id, status: "cancelled" as const };
}

/**
 * Returns the chat's current active run (queued, running or waiting), so a client that
 * reloads can reconnect to it.
 *
 * Input:
 * - userId: the signed-in user
 * - chatId: the chat to check (must belong to this user)
 *
 * Output:
 * - { runId, triggerRunId, accessToken, status, waitpoint }, or null when nothing is active.
 *   accessToken is empty if the run isn't dispatched yet or the token call failed.
 *   waitpoint is the pending question or plan, if any.
 */
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

  const waitpoint = await getPendingWaitpointForRun(run.id);

  return {
    runId: run.id,
    triggerRunId: run.triggerRunId ?? "",
    accessToken,
    status: run.status,
    waitpoint,
  };
}

/**
 * Clears a chat's active run if it is stuck, so a new message can start.
 *
 * Input:
 * - chatId: the chat to check
 *
 * Output:
 * - true if a stuck run was marked failed, false if there was no active run or it is still alive
 *
 * Notes:
 * - Stuck means: not updated for STALE_RUN_AFTER_MS, or Trigger.dev says its job already ended.
 * - A stuck run is marked failed (STALE_RUN), its streaming reply is marked failed, and any
 *   held credits are refunded.
 */
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

/**
 * Returns the status of one run for its owner.
 *
 * Input:
 * - userId: the signed-in user
 * - runId: the run to read
 *
 * Output:
 * - the run's status, safe error, timestamps, charged credits, routed model and reply id.
 *   Throws NOT_FOUND if the run doesn't exist or isn't this user's.
 */
export async function getRun(userId: string, runId: string) {
  const run = await db.agentRun.findFirst({
    where: { id: runId, userId },
  });

  if (!run) {
    throw new AppError("NOT_FOUND", "Run not found", false);
  }

  return {
    id: run.id,
    chatId: run.chatId,
    status: run.status,
    error: (run.error as SafeError | null) ?? null,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    chargedCredits: Number(run.chargedCredits),
    routedModel: run.routedModel,
    assistantMessageId: run.assistantMessageId,
  };
}
