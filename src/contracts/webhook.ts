import { z } from "zod";

export const WEBHOOK_EVENTS = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "tool.completed",
] as const;

export const WebhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookConfigInput = z.object({
  url: z.string().url(),
  events: z.array(WebhookEvent).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type WebhookConfigInput = z.infer<typeof WebhookConfigInput>;

export const WebhookCreateResponse = z.object({
  signingSecret: z.string(),
});
export type WebhookCreateResponse = z.infer<typeof WebhookCreateResponse>;

export const WebhookData = z.object({
  status: z.string(),
  toolName: z.string().nullable().optional(),
  output: z.unknown().nullable().optional(),
  creditUsed: z.number().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type WebhookData = z.infer<typeof WebhookData>;

export const WebhookPayload = z.object({
  type: WebhookEvent,
  runId: z.string(),
  data: WebhookData,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
