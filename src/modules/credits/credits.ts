import type { LedgerType, Prisma } from "@prisma/client";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 };

type ApplyEntryParams = {
  userId: string;
  runId?: string;
  toolInvocationId?: string;
  type: LedgerType;
  amount: bigint;
  idempotencyKey: string;
};

export function formatMicrocredits(amount: bigint | number): string {
  const m = Number(amount) / 1_000_000;
  return `${m.toFixed(2)}M`;
}

export async function getUserCreditBalance(userId: string): Promise<bigint> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } });
  return user.creditBalance;
}

async function applyEntry(
  tx: Prisma.TransactionClient,
  params: ApplyEntryParams,
): Promise<{ applied: boolean; balanceAfter: bigint }> {
  const existing = await tx.creditLedger.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    return { applied: false, balanceAfter: existing.balanceAfter };
  }

  const users = await tx.$queryRaw<Array<{ creditBalance: bigint }>>`
    SELECT "creditBalance" FROM "User" WHERE id = ${params.userId} FOR UPDATE
  `;
  const user = users[0];
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  if (params.type === "reserve" && user.creditBalance < -params.amount) {
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      `Not enough credits to run this. You need ${formatMicrocredits(-params.amount)}, you have ${formatMicrocredits(user.creditBalance)}.`,
      false,
    );
  }

  const newBalance = user.creditBalance + params.amount;

  await tx.user.update({
    where: { id: params.userId },
    data: { creditBalance: newBalance },
  });

  await tx.creditLedger.create({
    data: {
      userId: params.userId,
      runId: params.runId,
      toolInvocationId: params.toolInvocationId,
      type: params.type,
      amount: params.amount,
      balanceAfter: newBalance,
      idempotencyKey: params.idempotencyKey,
    },
  });

  return { applied: true, balanceAfter: newBalance };
}

export async function reserveCredits(params: {
  userId: string;
  runId?: string;
  toolInvocationId: string;
  amount: bigint | number;
}): Promise<{ reserved: boolean; balanceAfter: bigint }> {
  const amountBig = BigInt(params.amount);
  if (amountBig <= 0n) return { reserved: false, balanceAfter: await getUserCreditBalance(params.userId) };

  return db.$transaction(async (tx) => {
    const res = await applyEntry(tx, {
      userId: params.userId,
      runId: params.runId,
      toolInvocationId: params.toolInvocationId,
      type: "reserve",
      amount: -amountBig,
      idempotencyKey: `reserve:${params.toolInvocationId}`,
    });
    return { reserved: res.applied, balanceAfter: res.balanceAfter };
  }, TX_OPTIONS);
}

export async function settleCredits(params: {
  userId: string;
  runId?: string;
  toolInvocationId: string;
  actualCreditUsed: bigint | number;
}): Promise<{ settled: boolean; balanceAfter: bigint }> {
  const actualBig = BigInt(params.actualCreditUsed);
  const idempotencyKey = `settle:${params.toolInvocationId}`;

  return db.$transaction(async (tx) => {
    const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey } });
    if (existing) return { settled: false, balanceAfter: existing.balanceAfter };

    const reserveRow = await tx.creditLedger.findUnique({
      where: { idempotencyKey: `reserve:${params.toolInvocationId}` },
    });
    const holdAmount = reserveRow ? -reserveRow.amount : 0n;

    if (holdAmount > 0n) {
      await applyEntry(tx, {
        userId: params.userId,
        runId: params.runId,
        toolInvocationId: params.toolInvocationId,
        type: "refund",
        amount: holdAmount,
        idempotencyKey: `refund:${params.toolInvocationId}`,
      });
    }

    if (actualBig > holdAmount) {
      logger.warn("actual credit usage exceeded hold", {
        userId: params.userId,
        toolInvocationId: params.toolInvocationId,
        hold: holdAmount.toString(),
        actual: actualBig.toString(),
      });
    }

    const res = await applyEntry(tx, {
      userId: params.userId,
      runId: params.runId,
      toolInvocationId: params.toolInvocationId,
      type: "settle",
      amount: -actualBig,
      idempotencyKey,
    });

    await tx.toolInvocation.updateMany({
      where: { id: params.toolInvocationId },
      data: { credits: actualBig },
    });

    return { settled: res.applied, balanceAfter: res.balanceAfter };
  }, TX_OPTIONS);
}

export async function refundCredits(params: {
  userId: string;
  runId?: string;
  toolInvocationId: string;
  amount: bigint | number;
}): Promise<{ refunded: boolean; balanceAfter: bigint }> {
  const amountBig = BigInt(params.amount);
  if (amountBig <= 0n) return { refunded: false, balanceAfter: await getUserCreditBalance(params.userId) };

  return db.$transaction(async (tx) => {
    const res = await applyEntry(tx, {
      userId: params.userId,
      runId: params.runId,
      toolInvocationId: params.toolInvocationId,
      type: "refund",
      amount: amountBig,
      idempotencyKey: `refund:${params.toolInvocationId}`,
    });
    return { refunded: res.applied, balanceAfter: res.balanceAfter };
  }, TX_OPTIONS);
}

export async function grantCredits(params: {
  userId: string;
  amount: bigint | number;
  idempotencyKey: string;
}): Promise<{ granted: boolean; balanceAfter: bigint }> {
  const amountBig = BigInt(params.amount);
  return db.$transaction(async (tx) => {
    const res = await applyEntry(tx, {
      userId: params.userId,
      type: "grant",
      amount: amountBig,
      idempotencyKey: params.idempotencyKey,
    });
    return { granted: res.applied, balanceAfter: res.balanceAfter };
  }, TX_OPTIONS);
}

export async function refundLeakedHolds(runId: string): Promise<void> {
  const reserves = await db.creditLedger.findMany({
    where: { runId, type: "reserve" },
    select: { toolInvocationId: true, amount: true, userId: true },
  });
  for (const r of reserves) {
    if (r.toolInvocationId) {
      await refundCredits({ userId: r.userId, runId, toolInvocationId: r.toolInvocationId, amount: -r.amount });
    }
  }
}

export async function getLedger(userId: string, query?: { cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(query?.limit ?? 20, 1), 100);
  const decoded = query?.cursor ? decodeCursor(query.cursor, CreatedAtIdCursor) : undefined;
  const rows = await db.creditLedger.findMany({
    where: { userId, ...(decoded && { OR: afterCreatedAtIdCursor(decoded) }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasNextPage = rows.length > limit;
  const pageItems = hasNextPage ? rows.slice(0, limit) : rows;
  const last = pageItems.at(-1);
  const nextCursor = hasNextPage && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return {
    items: pageItems.map((item) => ({
      id: item.id,
      userId: item.userId,
      runId: item.runId,
      toolInvocationId: item.toolInvocationId,
      type: item.type,
      amount: Number(item.amount),
      balanceAfter: Number(item.balanceAfter),
      idempotencyKey: item.idempotencyKey,
      createdAt: item.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
