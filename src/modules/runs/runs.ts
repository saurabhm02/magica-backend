import type { AgentRun } from "@prisma/client";
import { tasks } from "@trigger.dev/sdk";
import type { agentTurn } from "@/trigger/agent-turn";
import { DISPATCH_FAILED_ERROR } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function dispatchRun(run: AgentRun, traceId: string) {
  try {
    const handle = await tasks.trigger<typeof agentTurn>(
      "agent-turn",
      { runId: run.id, traceId },
      { idempotencyKey: run.id },
    );
    await db.agentRun.update({ where: { id: run.id }, data: { triggerRunId: handle.id } });
    return { accessToken: handle.publicAccessToken };
  } catch (error) {
    logger.error("dispatch failed", { traceId, chatId: run.chatId, runId: run.id, message: (error as Error).message });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "failed", error: DISPATCH_FAILED_ERROR, finishedAt: new Date() },
    });
    throw new AppError(DISPATCH_FAILED_ERROR.code, DISPATCH_FAILED_ERROR.message, DISPATCH_FAILED_ERROR.retryable);
  }
}
