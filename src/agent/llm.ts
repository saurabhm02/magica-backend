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


export async function* streamChat(
  messages: LlmMessage[],
  signal: AbortSignal,
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): AsyncGenerator<LlmEvent> {
  try {
    const stream = await client.chat.completions.create(
      { 
        model: env.LLM_MODEL, 
        messages,
        stream: true, 
        stream_options: { include_usage: true },
        ...(tools?.length ? { tools } : {}),
      },
      { signal },
    );

    let model = "";
    let sawOutput = false;

    for await (const chunk of stream) {
      model = chunk.model || model;

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
    yield { type: "done", model };
  } catch (error) {
    if (signal.aborted) throw error; 

    logger.warn("llm stream failed", { detail: error instanceof Error ? error.message : String(error) });
    const { code, retryable } = classifyError(error);
    yield toErrorEvent(code, retryable);
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

// Turns the model's raw thinking into a step title like Magica's
// ("Decided to inspect the working directory"). The decision is usually at the end.
export async function summarizeReasoning(reasoning: string): Promise<string | undefined> {
  const raw = await askForOneLine(
    "Sum up what this AI assistant decided to do in its reasoning as a short step title: 3-7 words, past tense, sentence case, no period, no tool or function names (for example: Decided to inspect the working directory).",
    reasoning.slice(-2000),
    "title",
  );
  const title = raw.replace(/^["'`]|["'`]$/g, "").replace(/[.!]+$/, "").trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : undefined;
}
