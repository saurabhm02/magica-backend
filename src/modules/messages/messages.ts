import { type Attachment as PrismaAttachment, Prisma, type Message as PrismaMessage } from "@prisma/client";
import { z } from "zod";
import { ContentBlock } from "@/contracts/content-blocks";
import type { Message } from "@/contracts/message";
import type { SendMessageRequest } from "@/contracts/api";
import { attachToMessage, toAttachmentDTO } from "@/modules/attachments/attachments";
import { getOwnedChat } from "@/modules/chats/chats";
import { recoverStaleRun } from "@/modules/runs/runs";
import { respondWaitpoint } from "@/modules/waitpoints/waitpoints";
import { db } from "@/lib/db";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import {
  CHAT_TITLE_MAX_CHARS,
  DEFAULT_CHAT_TITLE,
  RATE_LIMIT_MESSAGES_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  SAFE_ERROR_MESSAGES,
} from "@/lib/constants";
import { AppError } from "@/lib/errors";
import { WEBHOOK_EVENTS } from "@/contracts/webhook";
import { generateWebhookSecret, validateWebhookUrl } from "@/modules/webhooks/webhooks";

export function extractSearchText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) {
      parts.push(b.text.trim());
    }
  }
  return parts.join("\n");
}

export async function listMessages(userId: string, chatId: string, { cursor, limit }: { cursor?: string; limit: number }) {
  await getOwnedChat(userId, chatId);
  const decoded = cursor ? decodeCursor(cursor, CreatedAtIdCursor) : undefined;

  const rows = await db.message.findMany({
    where: { chatId, ...(decoded && { OR: afterCreatedAtIdCursor(decoded) }) },
    include: {
      attachments: {
        orderBy: { position: "asc" },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items, nextCursor };
}

export async function sendMessage(userId: string, chatId: string, body: SendMessageRequest) {
  const [chat, existing] = await Promise.all([
    getOwnedChat(userId, chatId),
    findSentMessage(chatId, body.clientRequestId),
  ]);
  if (existing) return existing;

  const oneMinuteAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentCount = await db.message.count({
    where: {
      chat: { userId },
      role: "user",
      createdAt: { gte: oneMinuteAgo },
    },
  });

  if (recentCount >= RATE_LIMIT_MESSAGES_PER_MINUTE) {
    const oldest = await db.message.findFirst({
      where: {
        chat: { userId },
        role: "user",
        createdAt: { gte: oneMinuteAgo },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const retryAfterSeconds = oldest
      ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000))
      : 60;
    throw new AppError("RATE_LIMITED", SAFE_ERROR_MESSAGES.RATE_LIMITED, true, retryAfterSeconds);
  }

  const pendingPlanWaitpoint = await db.waitpoint.findFirst({
    where: {
      run: { chatId, status: "waiting" },
      type: "plan",
      status: "pending",
    },
    include: { run: true },
  });

  if (pendingPlanWaitpoint) {
    const message = await db.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          chatId,
          role: "user",
          status: "complete",
          content: [{ type: "text", text: body.content }],
          searchText: body.content.trim(),
          clientRequestId: body.clientRequestId,
        },
      });

      if (body.attachmentIds && body.attachmentIds.length > 0) {
        await attachToMessage(tx, userId, msg.id, body.attachmentIds);
      }

      return tx.message.findUniqueOrThrow({
        where: { id: msg.id },
        include: { attachments: { orderBy: { position: "asc" } } },
      });
    });

    await respondWaitpoint({
      userId,
      chatId,
      waitpointId: pendingPlanWaitpoint.id,
      body: { request_changes: body.content },
    });

    return { message, run: pendingPlanWaitpoint.run, signingSecret: undefined };
  }

  if (body.webhook) {
    await validateWebhookUrl(body.webhook.url);
  }
  const webhookSecret = body.webhook ? generateWebhookSecret() : undefined;

  const title = chat.title === DEFAULT_CHAT_TITLE ? deriveTitle(body.content) : undefined;

  const createMessageAndRun = () =>
    db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          chatId,
          role: "user",
          status: "complete",
          content: [{ type: "text", text: body.content }],
          searchText: body.content.trim(),
          clientRequestId: body.clientRequestId,
        },
      });

      if (body.attachmentIds && body.attachmentIds.length > 0) {
        await attachToMessage(tx, userId, message.id, body.attachmentIds);
      }

      const run = await tx.agentRun.create({
        data: {
          chatId,
          userId,
          userMessageId: message.id,
          status: "queued",
          idempotencyKey: body.clientRequestId,
          planMode: body.planMode ?? false,
        },
      });

      if (body.webhook && webhookSecret) {
        await tx.webhookSubscription.create({
          data: {
            agentRunId: run.id,
            url: body.webhook.url,
            secret: webhookSecret,
            events: body.webhook.events?.length ? body.webhook.events : [...WEBHOOK_EVENTS],
            headers: body.webhook.headers ? (body.webhook.headers as Prisma.InputJsonValue) : undefined,
            metadata: body.webhook.metadata ? (body.webhook.metadata as Prisma.InputJsonValue) : undefined,
          },
        });
      }

      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date(), ...(title && { title }) } });
      const savedMessage = await tx.message.findUniqueOrThrow({
        where: { id: message.id },
        include: { attachments: { orderBy: { position: "asc" } } },
      });
      return { message: savedMessage, run, signingSecret: webhookSecret };
    }, { timeout: 20_000, maxWait: 15_000 });

  try {
    return await createMessageAndRun();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const sameSend = await findSentMessage(chatId, body.clientRequestId);
      if (sameSend) return sameSend;

      const recovered = await recoverStaleRun(chatId);
      if (recovered) {
        return await createMessageAndRun();
      }

      throw new AppError("RUN_ALREADY_ACTIVE", "A reply is already in progress in this chat.", false);
    }
    throw error;
  }
}

async function findSentMessage(chatId: string, clientRequestId: string) {
  const message = await db.message.findUnique({
    where: { chatId_clientRequestId: { chatId, clientRequestId } },
    include: { attachments: { orderBy: { position: "asc" } } },
  });
  if (!message) return null;
  const run = await db.agentRun.findFirstOrThrow({ where: { userMessageId: message.id }, orderBy: { createdAt: "desc" } });
  const sub = await db.webhookSubscription.findUnique({ where: { agentRunId: run.id } });
  if (run.status === "failed" && !run.triggerRunId) {
    const updated = await db.agentRun.update({
      where: { id: run.id },
      data: { status: "queued", error: Prisma.DbNull, finishedAt: null },
    });
    return { message, run: updated, signingSecret: sub?.secret };
  }
  return { message, run, signingSecret: sub?.secret };
}

export function deriveTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX_CHARS);
}

export function toMessageDTO(message: PrismaMessage & { attachments?: PrismaAttachment[] }): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    status: message.status,
    content: z.array(ContentBlock).parse(message.content),
    clientRequestId: message.clientRequestId,
    suggestion: message.suggestion ?? undefined,
    attachments: (message.attachments ?? []).map(toAttachmentDTO),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
