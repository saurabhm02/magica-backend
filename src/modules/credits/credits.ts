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

/**
 * Holds credits before a paid tool runs, so the user can't spend more than they have.
 *
 * Input:
 * - userId: whose balance to hold from
 * - runId: the agent run, if any
 * - toolInvocationId: the tool call the hold is for
 * - amount: credits to hold (microcredits)
 *
 * Output:
 * - { reserved, balanceAfter }: reserved is false for a zero amount or a repeat call
 *
 * Rules it enforces:
 * - One hold per tool call (key reserve:<toolInvocationId>); a repeat returns the first result.
 * - Balance lower than the amount → INSUFFICIENT_CREDITS, nothing is held.
 * - The user row is locked (FOR UPDATE), so parallel holds can't overspend.
 */
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

/**
 * Charges the real cost of a finished tool call: releases its hold, then charges the actual amount.
 *
 * Input:
 * - userId, runId, toolInvocationId: who and what to charge
 * - actualCreditUsed: what the tool really cost (microcredits)
 *
 * Output:
 * - { settled, balanceAfter }: settled is false if this call was already settled
 *
 * Rules it enforces:
 * - Runs once per tool call (key settle:<toolInvocationId>); refund and charge happen in one transaction.
 * - The actual cost is charged even if it is more than the hold; that case is logged.
 * - Also stores the charged amount on the tool invocation.
 */
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

/**
 * Gives back a tool call's held credits (for a failed or cancelled call).
 *
 * Input:
 * - userId, runId, toolInvocationId: who and what to refund
 * - amount: credits to return (microcredits)
 *
 * Output:
 * - { refunded, balanceAfter }: refunded is false for a zero amount or a repeat call
 *
 * Rules it enforces:
 * - Same key as the refund inside settleCredits (refund:<toolInvocationId>), so a hold is
 *   never returned twice.
 */
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

/**
 * Adds credits to a user's balance (sign-up bonus, top-ups, seeding).
 *
 * Input:
 * - userId: who gets the credits
 * - amount: credits to add (microcredits)
 * - idempotencyKey: makes the grant safe to retry
 *
 * Output:
 * - { granted, balanceAfter }: granted is false if this key was already used
 */
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

/**
 * Returns any credit holds a run still has open, used when a run ends, is cancelled or goes stale.
 *
 * Input:
 * - runId: the agent run
 *
 * Output:
 * - nothing
 *
 * Notes:
 * - Safe to call many times: holds already settled or refunded share the refund key, so
 *   they are skipped.
 */
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

/**
 * Lists a user's credit ledger, newest first, one page at a time.
 *
 * Input:
 * - userId: whose ledger to read
 * - query.cursor: from a previous page's nextCursor; query.limit: page size (default 20, 1 to 100)
 *
 * Output:
 * - { items, nextCursor }: ledger rows with amounts as numbers, and the cursor for the next
 *   page (null on the last page)
 */
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
