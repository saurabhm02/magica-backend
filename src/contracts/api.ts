import { z } from "zod";
import { Chat } from "./chat";
import { SafeError } from "./errors";
import { Message } from "./message";
import { CursorQuery, Page } from "./pagination";
import { RunMetadata, RunStatus } from "./run";

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_TITLE_LENGTH = 200;


export const MeResponse = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const LedgerType = z.enum(["grant", "reserve", "settle", "refund"]);
export type LedgerType = z.infer<typeof LedgerType>;

export const CreditBalanceResponse = z.object({
  balance: z.number(),
});
export type CreditBalanceResponse = z.infer<typeof CreditBalanceResponse>;

export const CreditLedgerItem = z.object({
  id: z.string(),
  type: LedgerType,
  amount: z.number(),
  balanceAfter: z.number(),
  runId: z.string().nullable().optional(),
  toolInvocationId: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type CreditLedgerItem = z.infer<typeof CreditLedgerItem>;

export const ListLedgerQuery = CursorQuery;
export type ListLedgerQuery = z.infer<typeof ListLedgerQuery>;

export const ListLedgerResponse = Page(CreditLedgerItem);
export type ListLedgerResponse = z.infer<typeof ListLedgerResponse>;

export const ListChatsQuery = CursorQuery.extend({
  q: z.string().optional(),
});
export type ListChatsQuery = z.infer<typeof ListChatsQuery>;

export const ListChatsResponse = Page(Chat);
export type ListChatsResponse = z.infer<typeof ListChatsResponse>;

export const CreateChatRequest = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

export const UpdateChatRequest = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  pinned: z.boolean().optional(),
});
export type UpdateChatRequest = z.infer<typeof UpdateChatRequest>;

export const DeleteChatResponse = z.object({
  id: z.string(),
});
export type DeleteChatResponse = z.infer<typeof DeleteChatResponse>;

export const ListMessagesQuery = CursorQuery;
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = Page(Message);
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

export const SendMessageRequest = z.object({
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  attachmentIds: z.array(z.string()).optional(),
  clientRequestId: z.string().min(1),
  planMode: z.boolean().default(false),
  model: z.literal("openrouter/free").optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  chatId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  realtime: z.object({ runId: z.string(), accessToken: z.string() }),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const RunResponse = z.object({
  id: z.string(),
  chatId: z.string(),
  status: RunStatus,
  metadata: RunMetadata,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RunResponse = z.infer<typeof RunResponse>;

export const ActiveRunResponse = z
  .object({
    runId: z.string(),
    triggerRunId: z.string(),
    accessToken: z.string(),
    status: RunStatus,
  })
  .nullable();
export type ActiveRunResponse = z.infer<typeof ActiveRunResponse>;

export const CancelRunResponse = z.object({
  runId: z.string(),
  status: RunStatus,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

export const AssetType = z.enum(["image", "video"]);
export type AssetType = z.infer<typeof AssetType>;

export const AssetItem = z.object({
  url: z.string(),
  type: AssetType,
  chatId: z.string(),
  toolName: z.string(),
  createdAt: z.iso.datetime(),
});
export type AssetItem = z.infer<typeof AssetItem>;

export const ListAssetsQuery = CursorQuery.extend({
  type: AssetType.optional(),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuery>;

export const ListAssetsResponse = Page(AssetItem);
export type ListAssetsResponse = z.infer<typeof ListAssetsResponse>;

export const ToolCategory = z.enum(["image", "video", "util"]);
export type ToolCategory = z.infer<typeof ToolCategory>;

export const ToolItem = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: ToolCategory,
  estimatedCredits: z.number(),
});
export type ToolItem = z.infer<typeof ToolItem>;

export const ListToolsResponse = z.array(ToolItem);
export type ListToolsResponse = z.infer<typeof ListToolsResponse>;

export const ToolStatus = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolDetailResponse = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: ToolCategory,
  inputs: z.record(z.string(), z.unknown()),
  pricingLines: z.array(z.string()),
  defaultEstimate: z.number(),
});
export type ToolDetailResponse = z.infer<typeof ToolDetailResponse>;

export const CreateToolRunRequest = z.object({
  input: z.record(z.string(), z.unknown()),
});
export type CreateToolRunRequest = z.infer<typeof CreateToolRunRequest>;

export const CreateToolRunResponse = z.object({
  runId: z.string(),
  realtime: z.object({
    runId: z.string(),
    accessToken: z.string(),
  }),
});
export type CreateToolRunResponse = z.infer<typeof CreateToolRunResponse>;

export const ToolRunAsset = z.object({
  type: z.string(),
  url: z.string(),
});
export type ToolRunAsset = z.infer<typeof ToolRunAsset>;

export const ToolRunResponse = z.object({
  id: z.string(),
  runId: z.string(),
  triggerRunId: z.string().nullable().optional(),
  accessToken: z.string().nullable().optional(),
  realtime: z
    .object({
      runId: z.string(),
      accessToken: z.string(),
    })
    .nullable()
    .optional(),
  toolName: z.string(),
  status: ToolStatus,
  output: z.record(z.string(), z.unknown()).nullable().optional(),
  credits: z.number(),
  durationMs: z.number().nullable().optional(),
  error: SafeError.nullable().optional(),
  assets: z.array(ToolRunAsset),
  createdAt: z.iso.datetime(),
});
export type ToolRunResponse = z.infer<typeof ToolRunResponse>;

export const ToolRunHistoryItem = z.object({
  runId: z.string(),
  toolName: z.string(),
  status: ToolStatus,
  credits: z.number(),
  output: z.record(z.string(), z.unknown()).nullable().optional(),
  assets: z.array(ToolRunAsset),
  createdAt: z.iso.datetime(),
});
export type ToolRunHistoryItem = z.infer<typeof ToolRunHistoryItem>;

export const ListToolRunsQuery = CursorQuery;
export type ListToolRunsQuery = z.infer<typeof ListToolRunsQuery>;

export const ListToolRunsResponse = Page(ToolRunHistoryItem);
export type ListToolRunsResponse = z.infer<typeof ListToolRunsResponse>;
