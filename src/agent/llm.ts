import OpenAI, { APIError } from "openai";
import type { ErrorCode } from "@/contracts/errors";
import { GENERIC_SAFE_MESSAGE, LLM_MAX_RETRIES, SAFE_ERROR_MESSAGES } from "@/lib/constants";
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

      const delta = chunk.choices[0]?.delta;
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
