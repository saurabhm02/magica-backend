import { z } from "zod";

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; 

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/m4a",
  "audio/x-m4a",
  "audio/flac",
] as const;

export const AttachmentSource = z.enum(["upload", "library"]);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

export const AttachmentKind = z.enum(["image", "video", "audio"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const AttachmentStatus = z.enum(["ready", "failed"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

export const Attachment = z.object({
  id: z.string(),
  messageId: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  source: AttachmentSource,
  kind: AttachmentKind,
  mimeType: z.string(),
  sizeBytes: z.number(),
  name: z.string(),
  url: z.string(),
  status: AttachmentStatus,
  expiresAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof Attachment>;

export const UploadFileItem = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  type: z.string().min(1),
});
export type UploadFileItem = z.infer<typeof UploadFileItem>;

export const UploadParamsRequest = z.object({
  files: z.array(UploadFileItem),
});
export type UploadParamsRequest = z.infer<typeof UploadParamsRequest>;

export const UploadParamsResponse = z.object({
  params: z.string(),
  signature: z.string(),
});
export type UploadParamsResponse = z.infer<typeof UploadParamsResponse>;

export const CompleteUploadRequest = z.object({
  assemblyId: z.string().regex(/^[0-9a-f]{32}$/, "Invalid assembly ID"),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

export const CompleteUploadResponse = z.object({
  attachments: z.array(Attachment),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

export const CreateLibraryAttachmentRequest = z
  .object({
    toolInvocationId: z.string().min(1).optional(),
    url: z.string().url().optional(),
    attachmentId: z.string().min(1).optional(),
  })
  .refine(
    (data) =>
      Boolean(data.attachmentId) ||
      Boolean(data.toolInvocationId && data.url),
    {
      message: "Either attachmentId or both toolInvocationId and url must be provided",
    },
  );
export type CreateLibraryAttachmentRequest = z.infer<typeof CreateLibraryAttachmentRequest>;

export const CreateLibraryAttachmentResponse = Attachment;
export type CreateLibraryAttachmentResponse = z.infer<typeof CreateLibraryAttachmentResponse>;
