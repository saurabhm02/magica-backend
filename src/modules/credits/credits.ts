import type { LedgerType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 };

interface ApplyEntryParams {
  userId: string;
  runId?: string;
  toolInvocationId?: string;
  type: LedgerType;
  amount: bigint;
  idempotencyKey: string;
}



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
  estimate?: bigint | number;
  actualCreditUsed: bigint | number;
}): Promise<{ settled: boolean; balanceAfter: bigint }> {
  const actualBig = BigInt(params.actualCreditUsed);
  const idempotencyKey = `settle:${params.toolInvocationId}`;

  return db.$transaction(async (tx) => {
    const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey } });
    if (existing) return { settled: false, balanceAfter: existing.balanceAfter };

    let holdAmount = params.estimate !== undefined ? BigInt(params.estimate) : 0n;
    if (holdAmount <= 0n) {
      const reserveRow = await tx.creditLedger.findUnique({
        where: { idempotencyKey: `reserve:${params.toolInvocationId}` },
      });
      if (reserveRow) holdAmount = -reserveRow.amount;
    }

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
  const rows = await db.creditLedger.findMany({
    where: { runId },
    select: { toolInvocationId: true, type: true, amount: true, userId: true },
  });

  const toolMap = new Map<string, Array<{ type: LedgerType; amount: bigint; userId: string }>>();
  for (const r of rows) {
    if (!r.toolInvocationId) continue;
    let list = toolMap.get(r.toolInvocationId);
    if (!list) {
      list = [];
      toolMap.set(r.toolInvocationId, list);
    }
    list.push({ type: r.type, amount: r.amount, userId: r.userId });
  }

  for (const [toolInvocationId, entries] of toolMap) {
    const hasReserve = entries.some((e) => e.type === "reserve");
    const hasSettleOrRefund = entries.some((e) => e.type === "settle" || e.type === "refund");
    if (hasReserve && !hasSettleOrRefund) {
      const reserveEntry = entries.find((e) => e.type === "reserve")!;
      const holdAmount = -reserveEntry.amount;
      if (holdAmount > 0n) {
        await refundCredits({
          userId: reserveEntry.userId,
          runId,
          toolInvocationId,
          amount: holdAmount,
        });
      }
    }
  }
}

export async function getLedger(userId: string, query?: { cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(query?.limit ?? 20, 1), 100);
  const items = await db.creditLedger.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query?.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasNextPage = items.length > limit;
  const pageItems = hasNextPage ? items.slice(0, limit) : items;
  const nextCursor = hasNextPage ? pageItems[pageItems.length - 1]?.id : undefined;

  return {
    items: pageItems.map((item) => ({
      id: item.id,
      userId: item.userId,
      runId: item.runId,
      toolInvocationId: item.toolInvocationId,
      type: item.type,
      amount: item.amount.toString(),
      balanceAfter: item.balanceAfter.toString(),
      idempotencyKey: item.idempotencyKey,
      createdAt: item.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
