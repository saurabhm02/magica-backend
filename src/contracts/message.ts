import { z } from "zod";
import { Attachment } from "./attachment";
import { ContentBlock } from "./content-blocks";

export const MessageRole = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageStatus = z.enum(["pending", "streaming", "complete", "failed", "cancelled"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const Message = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRole,
  status: MessageStatus,
  content: z.array(ContentBlock),
  clientRequestId: z.string().nullable(),
  suggestion: z.string().optional(),
  attachments: z.array(Attachment).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;
