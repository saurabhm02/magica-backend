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
- To make or edit media you must call the tool. Never write tool results or media URLs yourself: only use URLs that a tool returned or the user gave you.
- You can't browse the web. For trends, prices or recent news, say your information may be out of date, then give your best answer.

# Skills
- If a listed skill matches the task, call load_skill BEFORE any other tool, and read its assets if it mentions them.

# How you reply
- Lead with the result. Explanation comes after, and only if it helps.
- Never open with "Sure", "Great question", "Certainly", "Of course" or "As an AI".
- Short questions get 1-3 sentences. Real tasks get a complete answer.
- Match the user's language and tone.
- Keep formatting light, it shows as plain text: short paragraphs, "-" lists, code in fenced blocks. No tables or headings.
- Don't repeat the question, don't summarize at the end, don't lecture.

# Asking vs doing
- If the intent is clear, just do it.
- If details really change the result (style, brand name, colors, platform, aspect ratio), ask them all at once with request_user_options, never as questions in your reply. Otherwise pick a sensible default and say which one you picked.
- Once the user has answered, do the work right away. Don't ask more questions; fill any gaps with sensible defaults.
- When taste decides the result (logos, branding, ad concepts), make 2-3 clearly different options in parallel by calling the tool several times in one step, so the user can compare.
- Use earlier messages in this chat before asking anything.

# Limits
- If you don't know, say so. Never invent facts, links or results.
- Decline harmful requests in one sentence, without a lecture.`;


export const MAX_HISTORY_MESSAGES = 20;
export const SAVE_PARTIAL_TEXT_EVERY_MS = 1000;
export const TEXT_STREAM_ID = "text";
export const REASONING_STREAM_ID = "reasoning";
export const REASONING_RENDER_KEY = "reasoning"; // a thinking step in the step list
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "running", "waiting"];


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
  VISION_UNAVAILABLE: "Sorry, I can't look at images right now. The free image models are busy, please try again in a minute.",
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

export const CREDIT_COSTS = {
  crop_image: 5_000,
  gpt_image_2: 68_484,
  merge_videos: 40_000,
  merge_videos_additional: 10_000,
  get_model_info: 0,
  load_skill: 0,
  read_skill_asset: 0,
} as const;

export const STALE_RUN_AFTER_MS = 10 * 60 * 1000;

export const MAGICA_TIMEOUT_MS = 600_000;
export const MAGICA_INITIAL_POLL_DELAY_S = 5;
export const MAGICA_MAX_POLL_DELAY_S = 15;

export const RUN_CRASHED_ERROR: SafeError = { code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, retryable: true };
export const DISPATCH_FAILED_ERROR: SafeError = {
  code: "INTERNAL",
  message: "Couldn't start the reply. Please try again.",
  retryable: true,
};

export const RATE_LIMIT_MESSAGES_PER_MINUTE = 20;
export const RATE_LIMIT_TOOL_RUNS_PER_MINUTE = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export const HTTP_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  TOOL_INPUT_INVALID: 400,
  INSUFFICIENT_CREDITS: 400,
  UPLOAD_TOO_LARGE: 400,
  UPLOAD_TYPE_NOT_ALLOWED: 400,
  RATE_LIMITED: 429,
  LLM_RATE_LIMITED: 429,
  MAGICA_RATE_LIMITED: 429,
  UPLOAD_QUOTA_EXCEEDED: 429,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RUN_ALREADY_ACTIVE: 409,
  WAITPOINT_ALREADY_RESOLVED: 409,
  WAITPOINT_EXPIRED: 410,
};
export const CORS_ALLOWED_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
export const CORS_ALLOWED_HEADERS = "Content-Type,Authorization";
export const DB_CONNECT_ATTEMPT_TIMEOUT_MS = 2000;
export const STARTUP_CHECK_TIMEOUT_MS = 15000;

export const DEFAULT_STARTING_CREDITS = 30_000_000n;
export const CREDIT_RESERVE_MULTIPLIER = 1.5;

export const MAX_SKILL_FILE_SIZE_BYTES = 64 * 1024;
export const ALLOWED_SKILL_EXTENSIONS = [".md", ".txt", ".json"] as const;

export const WAITPOINT_TIMEOUT = "24h";
export const WAITPOINT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const FOLLOW_UP_TIMEOUT_MS = 8000;

// openrouter/free sometimes routes to a model that can't see images, and that model then makes
// up a description. When the user's message has images we try these free vision models in order.
export const VISION_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-31b-it:free",
];

export function validateVisionModels(models: readonly string[] = VISION_MODELS): void {
  for (const model of models) {
    if (!model.endsWith(":free")) {
      throw new Error(`Refused vision model "${model}": must end in ":free"`);
    }
  }
}

validateVisionModels();
export const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

export {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UPLOAD_BYTES,
} from "@/contracts/attachment";


