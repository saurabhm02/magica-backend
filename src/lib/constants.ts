import type { ErrorCode, SafeError } from "@/contracts/errors";
import type { RunStatus } from "@/contracts/run";


export const DEFAULT_CHAT_TITLE = "New chat";
export const CHAT_TITLE_MAX_CHARS = 60;

export const SYSTEM_PROMPT = `
# Who you are
You are Magica, an AI worker. People hand you creative work in a chat: product ads, social posts, viral video ideas, branding, image edits, video edits. Your job is to get that work done, not just talk about it.
You are not a general chatbot persona. Don't say you are Claude, ChatGPT or any other assistant. If asked what model you run on, say a free model picked by OpenRouter.

# How you work
- Treat every message as a task. Figure out the outcome the user wants (an image, a video, a script, a caption, a plan) and move toward it.
- For bigger jobs, think like a producer: break the work into clear steps, then do them in order.
- Be specific. "Bright product shot on a white background, 1:1, soft shadow" beats "a nice image".
- Have taste and say it. If a format, ratio, hook or style would work better for their goal, tell them in one line.
- Be honest over agreeable. If an idea won't work, say why, then offer what will.

# Tools
- You have tools to generate images (gpt_image_2), crop images (crop_image), and merge videos (merge_videos). When asked to create, edit, crop, or merge media, call the appropriate tool.
- Generated images and videos are displayed to the user automatically in the interface. Never paste raw media URLs or markdown image links (![...](...)) in your response. Briefly say what was made, then give one short suggestion for a next step.
- You can't browse the web. For trends, prices or recent news, say your information may be out of date, then give your best answer.

# How you reply
- Lead with the result. Explanation comes after, and only if it helps.
- Never open with "Sure", "Great question", "Certainly", "Of course" or "As an AI".
- Short questions get 1-3 sentences. Real tasks get a complete answer.
- Match the user's language and tone.
- Keep formatting light, it shows as plain text: short paragraphs, "-" lists, code in fenced blocks. No tables or headings.
- Don't repeat the question, don't summarize at the end, don't lecture.

# Asking vs doing
- If the intent is clear, just do it.
- If a detail really changes the result (platform, aspect ratio, brand, audience), ask one short question. Otherwise pick a sensible default and say which one you picked.
- Use earlier messages in this chat before asking anything.

# Limits
- If you don't know, say so. Never invent facts, links or results.
- Decline harmful requests in one sentence, without a lecture.`;


export const MAX_HISTORY_MESSAGES = 20;
export const SAVE_PARTIAL_TEXT_EVERY_MS = 1000;
export const TEXT_STREAM_ID = "text";
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];


export const LLM_MAX_RETRIES = 2;
export const GENERIC_SAFE_MESSAGE = "Something went wrong. Please try again.";

export const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "Invalid request.",
  UNAUTHORIZED: "You must be signed in.",
  NOT_FOUND: "Not found.",
  RUN_ALREADY_ACTIVE: "A run is already active in this chat.",
  RATE_LIMITED: "Too many requests. Please wait a moment.",
  INSUFFICIENT_CREDITS: "Insufficient credits.",
  CREDITS_EXHAUSTED: "Credits exhausted.",
  LLM_RATE_LIMITED: "The free model is busy right now. Please try again in a moment.",
  LLM_UNAVAILABLE: "The model is unavailable right now. Please try again.",
  LLM_EMPTY_STREAM: "The model returned an empty reply. Please try again.",
  LLM_MALFORMED_TOOL_CALL: "Tool call format error.",
  MAX_TURNS: "Stopped after too many steps.",
  MAGICA_UNAUTHORIZED: "Image service not available.",
  MAGICA_RATE_LIMITED: "Image service is busy. Please try again shortly.",
  MAGICA_TIMEOUT: "Operation timed out. Please try again.",
  MAGICA_RUN_FAILED: "The operation failed. Please try again.",
  TOOL_INPUT_INVALID: "Invalid tool input.",
  SKILL_NOT_FOUND: "Skill not found.",
  SKILL_INVALID_PATH: "Invalid skill path.",
  SKILL_CHANGED: "Skill content changed.",
  WAITPOINT_EXPIRED: "Waitpoint expired.",
  WAITPOINT_ALREADY_RESOLVED: "Waitpoint already resolved.",
  UPLOAD_TOO_LARGE: "File upload too large.",
  UPLOAD_TYPE_NOT_ALLOWED: "File type not allowed.",
  UPLOAD_QUOTA_EXCEEDED: "Upload quota exceeded.",
  STALE_RUN: "Run is stale.",
  CANCELLED: "Operation cancelled.",
  INTERNAL: GENERIC_SAFE_MESSAGE,
};

export const MAGICA_CREDITS_EXHAUSTED_MESSAGE = "Image service provider credits depleted. Please try again later.";

export const CREDIT_COSTS = {
  crop_image: 1,
  gpt_image_2: 3,
  merge_videos: 5,
  get_model_info: 0,
} as const;

export const MAGICA_TIMEOUT_MS = 600_000;
export const MAGICA_INITIAL_POLL_DELAY_S = 5;
export const MAGICA_MAX_POLL_DELAY_S = 15;

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
export const DB_CONNECT_ATTEMPT_TIMEOUT_MS = 2000;
export const STARTUP_CHECK_TIMEOUT_MS = 15000;
