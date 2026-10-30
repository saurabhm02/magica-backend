import { inspect } from "node:util";
import { NextResponse } from "next/server";
import { type ErrorCode, type ErrorResponse, SafeError } from "@/contracts/errors";
import { GENERIC_SAFE_MESSAGE, HTTP_STATUS_BY_ERROR_CODE } from "@/lib/constants";
import { logger } from "@/lib/logger";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Turns anything thrown into an error that is safe to show users and the model.
// Our own errors keep their message (a child task's error arrives as a plain
// SafeError object, not an AppError); anything else gets the fallback.
export function toSafeError(
  error: unknown,
  fallbackCode: ErrorCode = "INTERNAL",
  fallbackMessage = GENERIC_SAFE_MESSAGE,
): SafeError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const parsed = SafeError.safeParse(error);
  if (parsed.success) return parsed.data;
  return { code: fallbackCode, message: fallbackMessage, retryable: false };
}

export function errorResponse(error: unknown, traceId: string): NextResponse<ErrorResponse> {
  if (!(error instanceof AppError)) {
    logger.error("unhandled error", {
      traceId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : inspect(error, { depth: 2 }), // e.g. the DB driver throws an ErrorEvent, not an Error
    });
  }
  const appError = error instanceof AppError ? error : new AppError("INTERNAL", GENERIC_SAFE_MESSAGE);
  const retryAfterSeconds = appError.retryAfterSeconds;
  const body: ErrorResponse = {
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      traceId,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(retryAfterSeconds));
  }
  return NextResponse.json(body, {
    status: HTTP_STATUS_BY_ERROR_CODE[appError.code] ?? 500,
    headers,
  });
}
