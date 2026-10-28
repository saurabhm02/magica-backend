import { NextResponse } from "next/server";
import type { ErrorCode, ErrorResponse } from "@/contracts/errors";
import { logger } from "@/lib/logger";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Only codes a route handler can actually throw. Codes set on a run/tool from inside
// the Trigger.dev task (LLM_UNAVAILABLE, MAGICA_TIMEOUT, ...) never reach this map.
const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
};

export function errorResponse(error: unknown, traceId: string): NextResponse<ErrorResponse> {
  if (!(error instanceof AppError)) {
    // Anything we didn't throw on purpose is our bug: log the details, show the user only the traceId.
    logger.error("unhandled error", {
      traceId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
  }
  const appError = error instanceof AppError ? error : new AppError("INTERNAL", "Something went wrong");
  const body: ErrorResponse = {
    error: { code: appError.code, message: appError.message, retryable: appError.retryable, traceId },
  };
  return NextResponse.json(body, { status: STATUS_BY_CODE[appError.code] ?? 500 });
}
