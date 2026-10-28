export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorResponse(error: unknown, traceId: string) {
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message, retryable: error.retryable, traceId } };
  }
  return { error: { code: "INTERNAL", message: "Something went wrong", retryable: false, traceId } };
}
