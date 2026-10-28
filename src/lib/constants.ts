import type { ErrorCode, SafeError } from "@/contracts/errors";
import type { RunStatus } from "@/contracts/run";


export const DEFAULT_CHAT_TITLE = "New chat";
export const CHAT_TITLE_MAX_CHARS = 60;

export const SYSTEM_PROMPT = "You are a helpful assistant inside a chat app. Answer directly and concisely.";
export const MAX_HISTORY_MESSAGES = 20;
export const SAVE_PARTIAL_TEXT_EVERY_MS = 1000;
export const TEXT_STREAM_ID = "text";
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];


export const LLM_MAX_RETRIES = 2;

export const LLM_SAFE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  LLM_RATE_LIMITED: "The free model is busy right now. Please try again in a moment.",
  LLM_UNAVAILABLE: "The model is unavailable right now. Please try again.",
  LLM_EMPTY_STREAM: "The model returned an empty reply. Please try again.",
};
export const GENERIC_SAFE_MESSAGE = "Something went wrong. Please try again.";

export const RUN_CRASHED_ERROR: SafeError = { code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, retryable: true };
export const DISPATCH_FAILED_ERROR: SafeError = {
  code: "INTERNAL",
  message: "Couldn't start the reply. Please try again.",
  retryable: true,
};

export const HTTP_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RUN_ALREADY_ACTIVE: 409,
};
export const CORS_ALLOWED_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
export const CORS_ALLOWED_HEADERS = "Content-Type,Authorization";
