import type { NextRequest } from "next/server";
import type OpenAI from "openai";
import type { z } from "zod";
import type { ToolCategory } from "@/contracts/api";
import type { ErrorCode, SafeError } from "@/contracts/errors";

export type ToolCall = { id: string; name: string; arguments: string; order?: number };

export type LlmMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type LlmUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type LlmEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; arguments?: string }
  | ({ type: "usage" } & LlmUsage)
  | { type: "done"; model: string }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

// Tools
export type ToolContext = {
  runId: string;
  userId: string;
  toolInvocationId: string;
  signal: AbortSignal;
  traceId?: string;
  order: number;
};

export type ToolAsset = { type: "image" | "video"; url: string };

export type ToolDisplayField = { label: string; value: string };

export type ToolDisplayInfo = {
  label: string;
  doneLabel: string;
  detail: string;
  fields: ToolDisplayField[];
  model?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalTool<TInput = any, TOutput = any> = {
  name: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  hidden?: boolean;
  pricingLines?: string[];
  inputSchema: z.ZodType<TInput>;
  renderKey: string;
  estimateCredits: (input: TInput) => Promise<number>;
  assets?: (output: TOutput) => ToolAsset[];
  describe: (input: Partial<TInput>) => ToolDisplayInfo;
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MagicaTool<TInput = any, TOutput = any> = {
  name: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  hidden?: boolean;
  pricingLines?: string[];
  inputSchema: z.ZodType<TInput>;
  renderKey: string;
  estimateCredits: (input: TInput) => Promise<number>;
  assets?: (output: TOutput) => ToolAsset[];
  describe: (input: Partial<TInput>) => ToolDisplayInfo;
  magica: {
    nodeType: string;
    subModelId?: (input: TInput) => string | undefined;
    buildInput: (input: TInput) => Record<string, unknown>;
    outputSchema: z.ZodType<TOutput>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool<TInput = any, TOutput = any> = LocalTool<TInput, TOutput> | MagicaTool<TInput, TOutput>;

export function isMagicaTool(tool: Tool): tool is MagicaTool {
  return "magica" in tool;
}

// Trigger.dev
export type AgentTurnPayload = { runId: string; traceId: string };
export type TurnResult = { error?: SafeError; routedModel?: string; usage?: LlmUsage };

// HTTP
export type RouteHandler<Ctx> = (req: NextRequest, ctx: Ctx, traceId: string) => Promise<Response>;
export type ChatRouteContext = { params: Promise<{ chatId: string }> };
export type RunRouteContext = { params: Promise<{ chatId: string; runId: string }> };

// Logging
export type LogLevel = "info" | "warn" | "error";
export type LogContext = {
  traceId?: string;
  chatId?: string;
  runId?: string;
  messageId?: string;
  processId?: string;
  waitpointTokenId?: string;
  [key: string]: unknown;
};
