import { verifyToken } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { DEFAULT_STARTING_CREDITS } from "@/lib/constants";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

export async function requireUser(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) throw new AppError("UNAUTHORIZED", "Missing bearer token");

  const payload = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties: [env.CLIENT_ORIGIN],
  }).catch(() => null);
  if (!payload) throw new AppError("UNAUTHORIZED", "Invalid session token");

  const existing = await db.user.findUnique({ where: { clerkUserId: payload.sub } });
  if (existing) return existing;

  return await db.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { clerkUserId: payload.sub },
      update: {},
      create: { clerkUserId: payload.sub, creditBalance: DEFAULT_STARTING_CREDITS },
    });
    await tx.creditLedger.upsert({
      where: { idempotencyKey: `grant:initial:${user.id}` },
      update: {},
      create: {
        userId: user.id,
        type: "grant",
        amount: DEFAULT_STARTING_CREDITS,
        balanceAfter: user.creditBalance,
        idempotencyKey: `grant:initial:${user.id}`,
      },
    });
    return user;
  });
}
