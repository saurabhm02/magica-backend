import { z } from "zod";

export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "RUN_ALREADY_ACTIVE",
  "INSUFFICIENT_CREDITS",
  "CREDITS_EXHAUSTED",
  "LLM_RATE_LIMITED",
  "LLM_UNAVAILABLE",
  "LLM_EMPTY_STREAM",
  "VISION_UNAVAILABLE",
  "LLM_MALFORMED_TOOL_CALL",
  "MAX_TURNS",
  "MAGICA_UNAUTHORIZED",
  "MAGICA_RATE_LIMITED",
  "MAGICA_TIMEOUT",
  "MAGICA_RUN_FAILED",
  "TOOL_INPUT_INVALID",
  "SKILL_NOT_FOUND",
  "SKILL_INVALID_PATH",
  "SKILL_CHANGED",
  "WAITPOINT_EXPIRED",
  "WAITPOINT_ALREADY_RESOLVED",
  "UPLOAD_TOO_LARGE",
  "UPLOAD_TYPE_NOT_ALLOWED",
  "UPLOAD_QUOTA_EXCEEDED",
  "STALE_RUN",
  "CANCELLED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const SafeError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type SafeError = z.infer<typeof SafeError>;

export const ErrorResponse = z.object({
  error: SafeError.extend({
    traceId: z.string(),
    retryAfterSeconds: z.number().optional(),
  }),
  retryAfterSeconds: z.number().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
