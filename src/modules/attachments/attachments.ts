import { createHmac } from "node:crypto";
import type { Attachment as PrismaAttachment, Prisma } from "@prisma/client";
import { getTool } from "@/agent/tools/registry";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
  type AttachmentKind,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UPLOAD_BYTES,
  type UploadFileItem,
} from "@/contracts/attachment";
import { SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};


export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const clean = base.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  return clean || "file";
}

export function getAttachmentKind(mimeType: string): AttachmentKind {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "image";
}

export function isAllowedMimeType(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(type);
}

// Transloadit expects UTC timestamps in YYYY/MM/DD HH:mm:ss+00:00 format.
export function formatAuthExpires(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}+00:00`;
}

/**
 * Builds signed Transloadit upload params so the browser can upload files straight to Transloadit.
 *
 * Input:
 * - userId: the signed-in user (stored in the assembly fields, checked again in completeUpload)
 * - files: name, type and size of each file the client wants to upload
 *
 * Output:
 * - { params, signature }: the params JSON and its sha384 HMAC signature, valid for one hour
 *
 * Rules it enforces:
 * - At least one file, at most MAX_ATTACHMENTS_PER_MESSAGE.
 * - Each file must be an allowed type and at most MAX_UPLOAD_BYTES.
 * - Files are stored to S3 only when S3 credentials are set.
 */
export function createUploadParams(userId: string, files: UploadFileItem[]) {
  if (files.length === 0) {
    throw new AppError("VALIDATION_FAILED", "At least one file is required.");
  }
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AppError("VALIDATION_FAILED", `Cannot upload more than ${MAX_ATTACHMENTS_PER_MESSAGE} files at once.`);
  }

  for (const file of files) {
    if (!isAllowedMimeType(file.type)) {
      throw new AppError("UPLOAD_TYPE_NOT_ALLOWED", SAFE_ERROR_MESSAGES.UPLOAD_TYPE_NOT_ALLOWED);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError("UPLOAD_TOO_LARGE", SAFE_ERROR_MESSAGES.UPLOAD_TOO_LARGE);
    }
  }

  const authKey = env.TRANSLOADIT_KEY;
  const authSecret = env.TRANSLOADIT_SECRET;
  const expires = formatAuthExpires(new Date(Date.now() + 60 * 60 * 1000));

  const steps: Record<string, unknown> = {
    ":original": {
      robot: "/upload/handle",
    },
  };

  if (env.TRANSLOADIT_S3_CREDENTIALS) {
    steps.store = {
      robot: "/s3/store",
      use: ":original",
      credentials: env.TRANSLOADIT_S3_CREDENTIALS,
      acl: "bucket-default",
      path: "uploads/${fields.userId}/${unique_prefix}/${file.url_name}",
    };
  }

  const paramsObj = {
    auth: {
      key: authKey,
      expires,
    },
    fields: {
      userId,
    },
    steps,
  };

  const params = JSON.stringify(paramsObj);
  const signature = "sha384:" + createHmac("sha384", authSecret).update(params).digest("hex");

  return { params, signature };
}

export function mapTransloaditError(err?: string | null, message?: string | null): AppError {
  const code = (err || "").toUpperCase();
  if (code.includes("CREDIT") || code.includes("QUOTA") || code.includes("SLOTS_DEPLETED")) {
    return new AppError("UPLOAD_QUOTA_EXCEEDED", SAFE_ERROR_MESSAGES.UPLOAD_QUOTA_EXCEEDED);
  }
  if (code.includes("RATE_LIMIT")) {
    return new AppError("RATE_LIMITED", SAFE_ERROR_MESSAGES.RATE_LIMITED);
  }
  if (code.includes("MAX_FILE_SIZE") || code.includes("ENTITY_TOO_LARGE") || code.includes("TOO_LARGE")) {
    return new AppError("UPLOAD_TOO_LARGE", SAFE_ERROR_MESSAGES.UPLOAD_TOO_LARGE);
  }
  if (code.includes("INVALID") || code.includes("UNSUPPORTED") || code.includes("TYPE")) {
    return new AppError("UPLOAD_TYPE_NOT_ALLOWED", SAFE_ERROR_MESSAGES.UPLOAD_TYPE_NOT_ALLOWED);
  }
  return new AppError("INTERNAL", message || SAFE_ERROR_MESSAGES.INTERNAL);
}

/**
 * Reads a finished Transloadit assembly and saves its files as the user's attachments.
 *
 * Input:
 * - userId: the signed-in user
 * - assemblyId: the Transloadit assembly id (32 hex characters)
 *
 * Output:
 * - { attachments }: the saved attachments, ready to attach to a message
 *
 * Rules it enforces:
 * - Bad id, unfinished upload, or too many files → VALIDATION_FAILED.
 * - The assembly must have been signed for this user → UNAUTHORIZED otherwise.
 * - Size and type are checked again on the server, not trusted from the client.
 * - Safe to call twice: one row per assembly + URL (upsert).
 * - Files not stored in our own bucket expire after 24 hours.
 */
export async function completeUpload(userId: string, assemblyId: string): Promise<{ attachments: Attachment[] }> {
  if (!/^[0-9a-f]{32}$/.test(assemblyId)) {
    throw new AppError("VALIDATION_FAILED", "Invalid assembly ID");
  }

  const res = await fetch(`https://api2.transloadit.com/assemblies/${assemblyId}`);
  const assembly = (await res.json().catch(() => ({}))) as {
    ok?: string;
    error?: string;
    message?: string;
    fields?: { userId?: string };
    uploads?: Array<{ id?: string; name?: string; size?: number; mime?: string; url?: string; ssl_url?: string }>;
    results?: Record<string, Array<{ name?: string; size?: number; mime?: string; url?: string; ssl_url?: string; original_id?: string }>>;
  };

  if (!res.ok || assembly.error) {
    throw mapTransloaditError(assembly.error, assembly.message);
  }

  if (assembly.ok !== "ASSEMBLY_COMPLETED") {
    throw new AppError("VALIDATION_FAILED", "Upload is not finished yet.");
  }

  if (assembly.fields?.userId !== userId) {
    throw new AppError("UNAUTHORIZED", "You do not own this upload.");
  }

  const files: Array<{ name: string; size: number; mime: string; url: string; stored: boolean }> = [];
  const uploads = Array.isArray(assembly.uploads) ? assembly.uploads : [];
  const storeResults = (assembly.results && Array.isArray(assembly.results.store))
    ? assembly.results.store
    : [];

  if (uploads.length > 0) {
    for (const u of uploads) {
      const stored = storeResults.find((r) => r.original_id === u.id);
      if (stored) {
        const fileUrl = stored.ssl_url || stored.url;
        if (!fileUrl) continue;
        files.push({
          name: stored.name || u.name || "file",
          size: stored.size ?? u.size ?? 0,
          mime: stored.mime || u.mime || "application/octet-stream",
          url: fileUrl,
          stored: true,
        });
      } else {
        const fileUrl = u.ssl_url || u.url;
        if (!fileUrl) continue;
        const isS3Stored =
          (u as { is_temp_url?: boolean }).is_temp_url === false ||
          (Boolean(fileUrl) && !fileUrl.includes("transloadit.com"));
        files.push({
          name: u.name || "file",
          size: u.size ?? 0,
          mime: u.mime || "application/octet-stream",
          url: fileUrl,
          stored: isS3Stored,
        });
      }
    }
  } else if (storeResults.length > 0) {
    for (const r of storeResults) {
      const fileUrl = r.ssl_url || r.url;
      if (!fileUrl) continue;
      files.push({
        name: r.name || "file",
        size: r.size ?? 0,
        mime: r.mime || "application/octet-stream",
        url: fileUrl,
        stored: true,
      });
    }
  } else if (assembly.results) {
    const fallbackResults = Object.values(assembly.results).flat();
    for (const r of fallbackResults) {
      const fileUrl = r.ssl_url || r.url;
      if (!fileUrl) continue;
      files.push({
        name: r.name || "file",
        size: r.size ?? 0,
        mime: r.mime || "application/octet-stream",
        url: fileUrl,
        stored: false,
      });
    }
  }

  if (files.length === 0) {
    throw new AppError("INTERNAL", "No files found in upload.");
  }

  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AppError("VALIDATION_FAILED", `Cannot upload more than ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
  }

  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) {
      throw new AppError("UPLOAD_TOO_LARGE", SAFE_ERROR_MESSAGES.UPLOAD_TOO_LARGE);
    }
    if (!isAllowedMimeType(f.mime)) {
      throw new AppError("UPLOAD_TYPE_NOT_ALLOWED", SAFE_ERROR_MESSAGES.UPLOAD_TYPE_NOT_ALLOWED);
    }
  }

  const attachments = await Promise.all(
    files.map((f) =>
      db.attachment.upsert({
        where: {
          assemblyId_url: {
            assemblyId,
            url: f.url,
          },
        },
        create: {
          userId,
          assemblyId,
          url: f.url,
          name: sanitizeFilename(f.name),
          sizeBytes: BigInt(f.size),
          mimeType: f.mime,
          kind: getAttachmentKind(f.mime),
          source: "upload",
          status: "ready",
          expiresAt: f.stored ? null : new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        update: {
          status: "ready",
        },
      }),
    ),
  );

  return { attachments: attachments.map(toAttachmentDTO) };
}

/**
 * Creates a new attachment from the user's media library, so an old upload or a generated
 * asset can be sent with a new message.
 *
 * Input:
 * - userId: the signed-in user
 * - target: { attachmentId } to reuse an upload, or { toolInvocationId, url } to reuse a generated
 *   asset (the old (toolInvocationId, url) argument form is also accepted)
 *
 * Output:
 * - the new attachment
 *
 * Rules it enforces:
 * - An upload must be the user's, ready and not expired; a generated asset must come from the
 *   user's succeeded tool call and its URL must be one of that tool's outputs. Otherwise NOT_FOUND.
 * - Always creates a fresh copy, so the original stays free for its own message.
 */
export async function createLibraryAttachment(
  userId: string,
  targetOrToolInvocationId: string | { toolInvocationId?: string; url?: string; attachmentId?: string },
  maybeUrl?: string,
): Promise<Attachment> {
  const params = typeof targetOrToolInvocationId === "string"
    ? { toolInvocationId: targetOrToolInvocationId, url: maybeUrl }
    : targetOrToolInvocationId;

  if (params.attachmentId) {
    const now = new Date();
    const original = await db.attachment.findFirst({
      where: {
        id: params.attachmentId,
        userId,
        status: "ready",
        source: "upload",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });

    if (!original) {
      throw new AppError("NOT_FOUND", "Upload not found in your media library.");
    }

    const copy = await db.attachment.create({
      data: {
        userId,
        source: "library",
        kind: original.kind,
        mimeType: original.mimeType,
        sizeBytes: original.sizeBytes,
        name: original.name,
        url: original.url,
        status: "ready",
        expiresAt: original.expiresAt,
      },
    });

    return toAttachmentDTO(copy);
  }

  if (!params.toolInvocationId || !params.url) {
    throw new AppError("VALIDATION_FAILED", "Either attachmentId or both toolInvocationId and url are required.");
  }

  const invocation = await db.toolInvocation.findFirst({
    where: {
      id: params.toolInvocationId,
      userId,
      status: "succeeded",
    },
  });

  if (!invocation) {
    throw new AppError("NOT_FOUND", "Asset not found in your generated media.");
  }

  const tool = getTool(invocation.toolName);
  const assets = tool?.assets && invocation.output ? tool.assets(invocation.output) : [];
  const matched = assets.find((a) => a.url === params.url);

  if (!matched) {
    throw new AppError("NOT_FOUND", "Asset not found in your generated media.");
  }

  const filename = sanitizeFilename(params.url.split("/").pop()?.split("?")[0] ?? "asset");
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = MIME_BY_EXTENSION[ext] ?? (matched.type === "video" ? "video/mp4" : "image/png");

  const attachment = await db.attachment.create({
    data: {
      userId,
      source: "library",
      kind: matched.type as AttachmentKind,
      mimeType,
      sizeBytes: 0n,
      name: filename,
      url: params.url,
      status: "ready",
      expiresAt: null,
    },
  });

  return toAttachmentDTO(attachment);
}

/**
 * Links attachments to a message, in the given order. Runs inside the caller's transaction.
 *
 * Input:
 * - tx: the open transaction
 * - userId: the message owner
 * - messageId: the message to attach to
 * - attachmentIds: attachments in display order
 *
 * Output:
 * - nothing; throws if any attachment can't be used
 *
 * Rules it enforces:
 * - At most MAX_ATTACHMENTS_PER_MESSAGE.
 * - Each must belong to the user (NOT_FOUND otherwise), be ready, and not be expired.
 * - Each can be attached only once; one already on a message → VALIDATION_FAILED.
 */
export async function attachToMessage(
  tx: Prisma.TransactionClient,
  userId: string,
  messageId: string,
  attachmentIds: string[],
) {
  if (attachmentIds.length === 0) return;

  if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AppError("VALIDATION_FAILED", `Cannot attach more than ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
  }

  const now = new Date();
  const attachments = await tx.attachment.findMany({
    where: { id: { in: attachmentIds } },
  });

  const attMap = new Map(attachments.map((a) => [a.id, a]));

  for (const id of attachmentIds) {
    const att = attMap.get(id);
    if (!att || att.userId !== userId) {
      throw new AppError("NOT_FOUND", "Attachment not found.");
    }
    if (att.status !== "ready") {
      throw new AppError("VALIDATION_FAILED", "Attachment is not ready.");
    }
    if (att.expiresAt && att.expiresAt <= now) {
      throw new AppError("VALIDATION_FAILED", "Attachment has expired.");
    }
  }

  for (let position = 0; position < attachmentIds.length; position++) {
    const id = attachmentIds[position]!;
    const claimed = await tx.attachment.updateMany({
      where: {
        id,
        userId,
        messageId: null,
      },
      data: {
        messageId,
        position,
      },
    });

    if (claimed.count !== 1) {
      throw new AppError("VALIDATION_FAILED", "Attachment has already been attached to a message.");
    }
  }
}

export function toAttachmentDTO(att: PrismaAttachment): Attachment {
  return {
    id: att.id,
    messageId: att.messageId,
    position: att.position,
    source: att.source,
    kind: att.kind,
    mimeType: att.mimeType,
    sizeBytes: Number(att.sizeBytes),
    name: att.name,
    url: att.url,
    status: att.status,
    expiresAt: att.expiresAt ? att.expiresAt.toISOString() : null,
    createdAt: att.createdAt.toISOString(),
  };
}
