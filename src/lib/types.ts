import type { NextRequest } from "next/server";
import type { ErrorCode, SafeError } from "@/contracts/errors";

// Plain TypeScript types used across the server.
// Types made from a Zod schema stay next to their schema (src/contracts, cursor schemas).

// LLM (provider-neutral: the agent loop only knows these, never OpenRouter)
export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type LlmEvent =
  | { type: "text-delta"; text: string }
  | ({ type: "usage" } & LlmUsage)
  | { type: "done"; model: string }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

// Trigger.dev
export type AgentTurnPayload = { runId: string; traceId: string };
export type TurnResult = { error?: SafeError; routedModel?: string; usage?: LlmUsage };

// HTTP
export type RouteHandler<Ctx> = (req: NextRequest, ctx: Ctx, traceId: string) => Promise<Response>;
export type ChatRouteContext = { params: Promise<{ chatId: string }> };

// Logging
export type LogLevel = "info" | "warn" | "error";
export type LogContext = {
  traceId?: string;
  chatId?: string;
  runId?: string;
  messageId?: string;
  [key: string]: unknown;
};
