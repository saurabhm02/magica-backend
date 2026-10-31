import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { auth } from "@trigger.dev/sdk";
import { getTool } from "@/agent/tools/registry";
import type {
  ListToolRunsQuery,
  ListToolRunsResponse,
  ToolRunResponse,
  ToolRunSource,
} from "@/contracts/api";
import type { SafeError } from "@/contracts/errors";
import {
  CREDIT_RESERVE_MULTIPLIER,
  RATE_LIMIT_TOOL_RUNS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  SAFE_ERROR_MESSAGES,
} from "@/lib/constants";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { AppError, toSafeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isMagicaTool, type MagicaTool } from "@/lib/types";
import { refundCredits, settleCredits, reserveCredits } from "@/modules/credits/credits";
import { WEBHOOK_EVENTS, type WebhookConfigInput } from "@/contracts/webhook";
import { emitWebhook, generateWebhookSecret, validateWebhookUrl } from "@/modules/webhooks/webhooks";
import { magicaRun } from "@/trigger/magica-run";

export type FinishToolOutcome = {
  ok: boolean;
  output?: unknown;
  creditUsed?: number;
  error?: SafeError;
  durationMs?: number;
  cancelled?: boolean;
};

export async function finishToolInvocation(
  invocation: { id: string; userId: string; runId?: string | null; toolName: string },
  outcome: FinishToolOutcome,
) {
  const isCancelled = outcome.cancelled || outcome.error?.code === "CANCELLED";
  const status = isCancelled ? "cancelled" : outcome.ok ? "succeeded" : "failed";

  const reserveRow = await db.creditLedger.findUnique({
    where: { idempotencyKey: `reserve:${invocation.id}` },
  });

  if (outcome.ok) {
    const creditUsed = typeof outcome.creditUsed === "number" ? outcome.creditUsed : 0;
    if (reserveRow || creditUsed > 0) {
      await settleCredits({
        userId: invocation.userId,
        runId: invocation.runId ?? undefined,
        toolInvocationId: invocation.id,
        actualCreditUsed: creditUsed,
      });
    }
  } else if (reserveRow && reserveRow.amount < 0n) {
    await refundCredits({
      userId: invocation.userId,
      runId: invocation.runId ?? undefined,
      toolInvocationId: invocation.id,
      amount: -reserveRow.amount,
    });
  }

  const tool = getTool(invocation.toolName);
  let assets: Array<{ type: "image" | "video" | "audio"; url: string }> = [];
  if (outcome.ok && tool?.assets && outcome.output) {
    try {
      assets = tool.assets(outcome.output).filter((a) => Boolean(a.url)).map((a) => ({ type: a.type, url: a.url }));
    } catch (err) {
      logger.warn("failed to extract assets in finishToolInvocation", { toolInvocationId: invocation.id, detail: String(err) });
    }
  }

  const updated = await db.toolInvocation.update({
    where: { id: invocation.id },
    data: {
      status,
      output: outcome.ok && outcome.output !== undefined ? (outcome.output as Prisma.InputJsonValue) : undefined,
      error: !outcome.ok && outcome.error ? (outcome.error as Prisma.InputJsonValue) : undefined,
      durationMs: outcome.durationMs,
      credits: outcome.ok ? BigInt(outcome.creditUsed ?? 0) : 0n,
    },
  });

  if (invocation.runId) {
    await emitWebhook({
      agentRunId: invocation.runId,
      event: "tool.completed",
      data: {
        toolName: updated.toolName,
        status: updated.status,
        output: outcome.output ?? null,
        creditUsed: Number(updated.credits),
        finishedAt: new Date().toISOString(),
      },
    });
  } else {
    const event = status === "cancelled" ? "run.canceled" : outcome.ok ? "run.completed" : "run.failed";
    await emitWebhook({
      toolInvocationId: updated.id,
      event,
      data: {
        toolName: updated.toolName,
        status: updated.status,
        output: outcome.output ?? null,
        creditUsed: Number(updated.credits),
        finishedAt: new Date().toISOString(),
      },
    });
  }

  return { invocation: updated, assets };
}

export async function estimateTool(
  toolName: string,
  rawInput: unknown,
): Promise<{ credits: number }> {
  const tool = getTool(toolName);
  if (!tool || tool.hidden) {
    throw new AppError("NOT_FOUND", "Tool not found", false);
  }

  if (!isMagicaTool(tool)) {
    throw new AppError("VALIDATION_FAILED", "Only Magica tools can be executed directly", false);
  }

  const magicaTool = tool as MagicaTool;
  const parsed = magicaTool.inputSchema.safeParse(rawInput);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join(", ");
    throw new AppError("TOOL_INPUT_INVALID", `Invalid input for ${magicaTool.name}: ${detail}`, false);
  }

  const credits = await magicaTool.estimateCredits(parsed.data);
  return { credits };
}

export async function startToolRun(
  user: { id: string },
  toolName: string,
  rawInput: unknown,
  webhookConfig?: WebhookConfigInput,
  source: ToolRunSource = "api",
): Promise<{
  runId: string;
  realtime: { runId: string; accessToken: string };
  webhook?: { signingSecret: string };
}> {
  const tool = getTool(toolName);
  if (!tool || tool.hidden) {
    throw new AppError("NOT_FOUND", "Tool not found", false);
  }

  if (!isMagicaTool(tool)) {
    throw new AppError("VALIDATION_FAILED", "Only Magica tools can be executed directly", false);
  }

  const magicaTool = tool as MagicaTool;
  const parsed = magicaTool.inputSchema.safeParse(rawInput);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join(", ");
    throw new AppError("TOOL_INPUT_INVALID", `Invalid input for ${magicaTool.name}: ${detail}`, false);
  }

  const oneMinuteAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentRuns = await db.toolInvocation.count({
    where: {
      userId: user.id,
      createdAt: { gte: oneMinuteAgo },
    },
  });

  if (recentRuns >= RATE_LIMIT_TOOL_RUNS_PER_MINUTE) {
    const oldest = await db.toolInvocation.findFirst({
      where: {
        userId: user.id,
        createdAt: { gte: oneMinuteAgo },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const retryAfterSeconds = oldest
      ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000))
      : 60;
    throw new AppError("RATE_LIMITED", SAFE_ERROR_MESSAGES.RATE_LIMITED, true, retryAfterSeconds);
  }

  if (webhookConfig) {
    await validateWebhookUrl(webhookConfig.url);
  }
  const webhookSecret = webhookConfig ? generateWebhookSecret() : undefined;

  const estimate = await magicaTool.estimateCredits(parsed.data);
  const reserveAmount = Math.round(estimate * CREDIT_RESERVE_MULTIPLIER);

  const invocation = await db.toolInvocation.create({
    data: {
      userId: user.id,
      runId: null,
      toolCallId: `direct_${randomUUID()}`,
      order: 0,
      toolName: magicaTool.name,
      status: "pending",
      source,
      input: parsed.data as Prisma.InputJsonValue,
      idempotencyKey: `tool_run_${randomUUID()}`,
    },
  });

  if (webhookConfig && webhookSecret) {
    await db.webhookSubscription.create({
      data: {
        toolInvocationId: invocation.id,
        url: webhookConfig.url,
        secret: webhookSecret,
        events: webhookConfig.events?.length ? webhookConfig.events : [...WEBHOOK_EVENTS],
        headers: webhookConfig.headers ? (webhookConfig.headers as Prisma.InputJsonValue) : undefined,
        metadata: webhookConfig.metadata ? (webhookConfig.metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  if (reserveAmount > 0) {
    await reserveCredits({
      userId: user.id,
      toolInvocationId: invocation.id,
      amount: reserveAmount,
    });
  }

  const magicaPayload = magicaTool.magica.buildInput(parsed.data);
  const subModelId = magicaTool.magica.subModelId?.(parsed.data);

  let handle: { id: string; publicAccessToken?: string };
  try {
    handle = await magicaRun.trigger({
      toolInvocationId: invocation.id,
      nodeType: magicaTool.magica.nodeType,
      subModelId,
      params: magicaPayload,
    });
  } catch (err) {
    if (reserveAmount > 0) {
      await refundCredits({
        userId: user.id,
        toolInvocationId: invocation.id,
        amount: reserveAmount,
      });
    }
    await db.toolInvocation.update({
      where: { id: invocation.id },
      data: {
        status: "failed",
        error: toSafeError(err, "MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED) as Prisma.InputJsonValue,
      },
    });
    await emitWebhook({
      toolInvocationId: invocation.id,
      event: "run.failed",
      data: {
        toolName: invocation.toolName,
        status: "failed",
        output: null,
        creditUsed: 0,
        finishedAt: new Date().toISOString(),
      },
    });
    throw err;
  }

  await db.toolInvocation.update({
    where: { id: invocation.id },
    data: { triggerRunId: handle.id },
  });

  await emitWebhook({
    toolInvocationId: invocation.id,
    event: "run.started",
    data: {
      toolName: invocation.toolName,
      status: "running",
      output: null,
      creditUsed: null,
      finishedAt: null,
    },
  });

  return {
    runId: invocation.id,
    realtime: {
      runId: handle.id,
      accessToken: handle.publicAccessToken ?? "",
    },
    webhook: webhookSecret ? { signingSecret: webhookSecret } : undefined,
  };
}

export async function listToolRuns(
  userId: string,
  toolName: string,
  query: ListToolRunsQuery,
): Promise<ListToolRunsResponse> {
  const tool = getTool(toolName);
  if (!tool || tool.hidden) {
    throw new AppError("NOT_FOUND", "Tool not found", false);
  }

  const cursor = query.cursor ? decodeCursor(query.cursor, CreatedAtIdCursor) : undefined;
  const limit = query.limit ?? 20;

  const invocations = await db.toolInvocation.findMany({
    where: {
      userId,
      toolName: tool.name,
      ...(query.source ? { source: query.source } : {}),
      ...(cursor ? { OR: afterCreatedAtIdCursor(cursor) } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasNext = invocations.length > limit;
  const pageItems = hasNext ? invocations.slice(0, limit) : invocations;

  const items = pageItems.map((inv) => {
    const assets = inv.output && tool.assets ? tool.assets(inv.output) : [];
    return {
      runId: inv.id,
      toolName: inv.toolName,
      status: inv.status,
      source: (inv.source as ToolRunSource) ?? "ui",
      credits: Number(inv.credits),
      output: inv.output as Record<string, unknown> | null,
      assets: assets.map((a) => ({ type: a.type, url: a.url })),
      createdAt: inv.createdAt.toISOString(),
    };
  });

  const lastItem = pageItems[pageItems.length - 1];
  const nextCursor =
    hasNext && lastItem
      ? encodeCursor({ createdAt: lastItem.createdAt.toISOString(), id: lastItem.id })
      : null;

  return { items, nextCursor };
}

export async function getToolRun(userId: string, id: string): Promise<ToolRunResponse> {
  const inv = await db.toolInvocation.findUnique({
    where: { id },
  });

  if (!inv || inv.userId !== userId) {
    throw new AppError("NOT_FOUND", "Tool run not found", false);
  }

  let accessToken: string | undefined;
  if (inv.triggerRunId) {
    try {
      accessToken = await auth.createPublicToken({
        scopes: { read: { runs: [inv.triggerRunId] } },
      });
    } catch (err) {
      logger.error("failed to mint trigger token for tool run reload", { id: inv.id, detail: String(err) });
    }
  }

  const tool = getTool(inv.toolName);
  const assets = inv.output && tool?.assets ? tool.assets(inv.output) : [];

  return {
    id: inv.id,
    runId: inv.id,
    triggerRunId: inv.triggerRunId,
    accessToken,
    realtime: inv.triggerRunId && accessToken ? { runId: inv.triggerRunId, accessToken } : undefined,
    toolName: inv.toolName,
    status: inv.status,
    source: (inv.source as ToolRunSource) ?? "ui",
    output: inv.output as Record<string, unknown> | null,
    credits: Number(inv.credits),
    durationMs: inv.durationMs,
    error: inv.error as SafeError | null,
    assets: assets.map((a) => ({ type: a.type, url: a.url })),
    createdAt: inv.createdAt.toISOString(),
  };
}
