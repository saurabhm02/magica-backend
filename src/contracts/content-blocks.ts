import { z } from "zod";
import { SafeError } from "./errors";

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });

const ThinkingBlock = z.object({ type: z.literal("thinking"), text: z.string() });

// `title` is a few-word summary ("Decided to inspect the working directory"), set when the reasoning led to a tool call.
const ReasoningBlock = z.object({ type: z.literal("reasoning"), text: z.string(), title: z.string().optional() });

const ToolField = z.object({
  label: z.string(),
  value: z.string(),
});

const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  renderKey: z.string().optional(),
  label: z.string().optional(),
  doneLabel: z.string().optional(),
  detail: z.string().optional(),
  fields: z.array(ToolField).optional(),
  model: z.string().optional(),
});

const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  output: z.unknown().optional(),
  error: SafeError.optional(),
  credits: z.number().optional(),
  durationMs: z.number().optional(),
  assets: z.array(z.object({ type: z.enum(["image", "video", "audio"]), url: z.string() })).optional(),
});

const CitationsBlock = z.object({
  type: z.literal("citations"),
  citations: z.array(z.object({ url: z.url(), title: z.string().optional() })),
});

const UsageBlock = z.object({
  type: z.literal("usage"),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ThinkingBlock,
  ReasoningBlock,
  ToolUseBlock,
  ToolResultBlock,
  CitationsBlock,
  UsageBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
