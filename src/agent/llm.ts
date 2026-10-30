import OpenAI, { APIError } from "openai";
import type { ErrorCode } from "@/contracts/errors";
import { FOLLOW_UP_TIMEOUT_MS, GENERIC_SAFE_MESSAGE, LLM_MAX_RETRIES, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { LlmEvent, LlmMessage } from "@/lib/types";

const client = new OpenAI({
  baseURL: env.LLM_BASE_URL,
  apiKey: env.LLM_API_KEY,
  maxRetries: LLM_MAX_RETRIES,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
});


/**
 * Says whether a model id is a free OpenRouter model.
 * We only ever use free models; this stops a paid model from running even if one is passed in by mistake.
 *
 * Input:
 * - model: the model id
 *
 * Output:
 * - true for "openrouter/free" or any id ending in ":free"
 */
export function isFreeModel(model: string) {
  return model === "openrouter/free" || model.endsWith(":free");
}

/**
 * Streams one model reply as simple events: text, reasoning, tool-call pieces, usage, then done.
 *
 * Input:
 * - messages: the prompt
 * - signal: aborts the request
 * - tools: tool definitions the model may call (optional)
 * - model: the model to use (defaults to LLM_MODEL)
 *
 * Output:
 * - an async stream of LlmEvent; ends with "done" (with the routed model) or one "error"
 *
 * Notes:
 * - A model that isn't free is refused with LLM_UNAVAILABLE, nothing is sent.
 * - A stream with no text or tool calls → LLM_EMPTY_STREAM (retryable).
 * - Errors become safe error events (429 → LLM_RATE_LIMITED); after an abort the error is rethrown.
 */
export async function* streamChat(
  messages: LlmMessage[],
  signal: AbortSignal,
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
  model: string = env.LLM_MODEL,
): AsyncGenerator<LlmEvent> {
  if (!isFreeModel(model)) {
    logger.error("refused a model that isn't free", { model });
    yield toErrorEvent("LLM_UNAVAILABLE", false);
    return;
  }
  try {
    const stream = await client.chat.completions.create(
      { 
        model, 
        messages,
        stream: true, 
        stream_options: { include_usage: true },
        ...(tools?.length ? { tools } : {}),
      },
      { signal },
    );

    let routedModel = "";
    let sawOutput = false;

    for await (const chunk of stream) {
      routedModel = chunk.model || routedModel;

      // `reasoning` is OpenRouter's field for the model's thinking; the OpenAI types don't know it.
      const delta = chunk.choices[0]?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning?: string }) | undefined;
      if (delta?.reasoning) yield { type: "reasoning-delta", text: delta.reasoning };
      if (delta?.content) {
        sawOutput = true;
        yield { type: "text-delta", text: delta.content };
      }

      if (delta?.tool_calls) {
        sawOutput = true;
        for (const tc of delta.tool_calls) {
          yield {
            type: "tool-call-delta",
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          };
        }
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    if (!sawOutput) {
      yield toErrorEvent("LLM_EMPTY_STREAM", true);
      return;
    }
    yield { type: "done", model: routedModel };
  } catch (error) {
    if (signal.aborted) throw error; 

    logger.warn("llm stream failed", { detail: error instanceof Error ? error.message : String(error) });
    const { code, retryable } = classifyError(error);
    yield toErrorEvent(code, retryable);
  }
}

/**
 * Streams a reply, trying each model in order until one works.
 *
 * Input:
 * - models: model ids, in order of preference
 * - messages, signal, tools: passed to streamChat
 *
 * Output:
 * - the same events as streamChat, from the model that answered
 *
 * Notes:
 * - A model that fails before replying is skipped. Once a model has started replying we stay
 *   with it, because its partial output is already on the user's screen.
 * - The last model's error is passed through as is.
 */
export async function* streamChatWithFallback(
  models: string[],
  messages: LlmMessage[],
  signal: AbortSignal,
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): AsyncGenerator<LlmEvent> {
  for (const [index, model] of models.entries()) {
    const isLastModel = index === models.length - 1;
    let hasReplied = false;
    let failedBeforeReply = false;

    for await (const event of streamChat(messages, signal, tools, model)) {
      if (event.type === "error" && !hasReplied && !isLastModel) {
        failedBeforeReply = true;
        break;
      }
      if (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-call-delta") {
        hasReplied = true;
      }
      yield event;
    }

    if (!failedBeforeReply) return;
    logger.warn("model failed before replying, trying the next one", { model });
  }
}

function toErrorEvent(code: ErrorCode, retryable: boolean): LlmEvent {
  return { type: "error", code, message: SAFE_ERROR_MESSAGES[code] ?? GENERIC_SAFE_MESSAGE, retryable };
}

function classifyError(error: unknown): { code: ErrorCode; retryable: boolean } {
  const status = error instanceof APIError ? error.status : undefined;
  if (status === 429) return { code: "LLM_RATE_LIMITED", retryable: true };
  if (!status || status >= 500) return { code: "LLM_UNAVAILABLE", retryable: true };
  return { code: "LLM_UNAVAILABLE", retryable: false };
}

export function formatTitle(raw: string): string {
  const cleaned = raw.replace(/^["'`]|["'`]$/g, "").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).slice(0, 5);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function formatSuggestion(raw: string): string {
  const cleaned = raw
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).slice(0, 8);
  const joined = words.join(" ");
  return joined.charAt(0).toLowerCase() + joined.slice(1);
}

// Free models are often "reasoning" models: they think before answering. Give them room
// (a tiny max_tokens left only the thinking and no answer), keep the thinking short and out
// of the reply, and read the last line of plain text instead of relying on JSON mode.
async function askForOneLine(instruction: string, input: string, field: "title" | "suggestion") {
  // Some free models still think for hundreds of tokens and return nothing; one retry
  // usually lands on a different model.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const line = await askOnce(instruction, input, field);
      if (line) return line;
    } catch (error) {
      logger.warn(`${field} attempt failed`, { attempt, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return "";
}

async function askOnce(instruction: string, input: string, field: "title" | "suggestion") {
  const body = {
    model: env.LLM_MODEL,
    messages: [
      { role: "system" as const, content: `${instruction} Reply with only that one line, nothing else.` },
      { role: "user" as const, content: input },
    ],
    max_tokens: 1200,
    temperature: 0.3,
    reasoning: { effort: "low", exclude: true }, // OpenRouter option, ignored by models without reasoning
  };
  const completion = await client.chat.completions.create(body, { signal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS) });
  const raw = completion.choices[0]?.message?.content ?? "";
  const lines = raw.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  try {
    const parsed = JSON.parse(last);
    if (typeof parsed?.[field] === "string") return parsed[field] as string;
  } catch {
    // not JSON, which is the normal case: use the line as it is
  }
  return last.replace(new RegExp(`^${field}\\s*[:=]\\s*`, "i"), "");
}

/**
 * Asks the model for a short chat title based on the first user message.
 *
 * Input:
 * - userMessage: the user's first message (only the first 500 characters are sent)
 *
 * Output:
 * - a Title Case title of up to 5 words, or undefined if the call failed or gave nothing usable
 *
 * Notes:
 * - Never throws; it is a nice-to-have and must not fail the run.
 */
export async function generateChatTitle(userMessage: string): Promise<string | undefined> {
  try {
    const raw = await askForOneLine(
      "Write a 2-5 word Title Case title that says what this chat is about, not the exact words used (a greeting becomes Casual Greeting; a request for a red apple image becomes Red Apple Image).",
      userMessage.slice(0, 500),
      "title",
    );
    const title = formatTitle(raw);
    if (!title) logger.warn("title call returned no usable title", { raw });
    return title || undefined;
  } catch (error) {
    logger.warn("failed to generate title", { detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * Asks the model for one short follow-up request the user could send next.
 *
 * Input:
 * - userMessage: what the user asked (first 500 characters)
 * - reply: what the assistant answered (first 500 characters)
 *
 * Output:
 * - a lowercase suggestion of up to 8 words, or undefined if nothing usable came back
 *
 * Notes:
 * - Never throws; it is a nice-to-have and must not fail the run.
 */
export async function generateSuggestion(userMessage: string, reply: string): Promise<string | undefined> {
  try {
    const raw = await askForOneLine(
      "Suggest one short follow-up request the user could send next, based on what the assistant just did. Max 10 words, start lowercase, no quotes.",
      `User message: ${userMessage.slice(0, 500)}\nAssistant reply: ${reply.slice(0, 500)}`,
      "suggestion",
    );
    const suggestion = formatSuggestion(raw);
    if (!suggestion) logger.warn("suggestion call returned no usable suggestion", { raw });
    return suggestion || undefined;
  } catch (error) {
    logger.warn("failed to generate suggestion", { detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * Turns the model's raw thinking into a short step title like Magica's
 * ("Decided to inspect the working directory").
 *
 * Input:
 * - reasoning: the raw thinking text; only the last 2000 characters are sent, since the
 *   decision is usually at the end
 *
 * Output:
 * - a sentence-case title, or undefined if the model gave nothing usable
 */
export async function summarizeReasoning(reasoning: string): Promise<string | undefined> {
  const raw = await askForOneLine(
    "Sum up what this AI assistant decided to do in its reasoning as a short step title: 3-7 words, past tense, sentence case, no period, no tool or function names (for example: Decided to inspect the working directory).",
    reasoning.slice(-2000),
    "title",
  );
  const title = raw.replace(/^["'`]|["'`]$/g, "").replace(/[.!]+$/, "").trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : undefined;
}
