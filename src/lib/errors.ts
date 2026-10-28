import { NextResponse } from "next/server";
import type { ErrorCode, ErrorResponse } from "@/contracts/errors";
import { GENERIC_SAFE_MESSAGE, HTTP_STATUS_BY_ERROR_CODE } from "@/lib/constants";
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

export function errorResponse(error: unknown, traceId: string): NextResponse<ErrorResponse> {
  if (!(error instanceof AppError)) {
    logger.error("unhandled error", {
      traceId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
  }
  const appError = error instanceof AppError ? error : new AppError("INTERNAL", GENERIC_SAFE_MESSAGE);
  const body: ErrorResponse = {
    error: { code: appError.code, message: appError.message, retryable: appError.retryable, traceId },
  };
  return NextResponse.json(body, { status: HTTP_STATUS_BY_ERROR_CODE[appError.code] ?? 500 });
}
