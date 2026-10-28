import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";

type Handler<Ctx> = (req: NextRequest, ctx: Ctx, traceId: string) => Promise<Response>;

export function route<Ctx>(handler: Handler<Ctx>) {
  return async (req: NextRequest, ctx: Ctx) => {
    const traceId = randomUUID();
    try {
      return await handler(req, ctx, traceId);
    } catch (error) {
      return errorResponse(error, traceId);
    }
  };
}

export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  throw new AppError("VALIDATION_FAILED", field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid request"));
}

export async function readJson(req: NextRequest): Promise<unknown> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid JSON body");
  }
}

export function queryOf(req: NextRequest) {
  return Object.fromEntries(req.nextUrl.searchParams);
}
