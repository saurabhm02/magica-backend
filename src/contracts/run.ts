import { z } from "zod";
import { SafeError } from "./errors";

export const RunStatus = z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

// this is what will show in ui while it running
const RunMetadataStatus = z.enum([
  "queued",
  "thinking",
  "working",
  "waiting",
  "stopping",
  "complete",
  "failed",
  "cancelled",
]);

const RunMetadataTool = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  renderKey: z.string(),
  outputPreview: z.string().optional(),
});

const RunMetadataAsset = z.object({
  type: z.enum(["image", "video", "audio"]),
  url: z.url(),
  toolInvocationId: z.string(),
});

const RunMetadataWaitpoint = z.object({
  id: z.string(),
  type: z.enum(["credit", "plan", "options", "media"]),
  payload: z.unknown(),
  expiresAt: z.iso.datetime(),
});

export const RunMetadata = z.object({
  status: RunMetadataStatus,
  currentStep: z.string().optional(),
  thinkingStartedAt: z.iso.datetime().optional(),
  tools: z.array(RunMetadataTool).optional(),
  assets: z.array(RunMetadataAsset).optional(),
  waitpoint: RunMetadataWaitpoint.optional(),
  error: SafeError.optional(),
});
export type RunMetadata = z.infer<typeof RunMetadata>;
