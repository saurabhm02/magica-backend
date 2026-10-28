import { Prisma, type Message as PrismaMessage } from "@prisma/client";
import { z } from "zod";
import { ContentBlock } from "@/contracts/content-blocks";
import type { Message } from "@/contracts/message";
import type { SendMessageRequest } from "@/contracts/api";
import { getOwnedChat } from "@/modules/chats/chats";
import { db } from "@/lib/db";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { CHAT_TITLE_MAX_CHARS, DEFAULT_CHAT_TITLE } from "@/lib/constants";
import { AppError } from "@/lib/errors";

const MessageCursor = z.object({ createdAt: z.iso.datetime(), id: z.string() });
type MessageCursor = z.infer<typeof MessageCursor>;

function afterCursor(cursor: MessageCursor) {
  const createdAt = new Date(cursor.createdAt);
  return [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }];
}

export async function listMessages(userId: string, chatId: string, { cursor, limit }: { cursor?: string; limit: number }) {
  await getOwnedChat(userId, chatId);
  const decoded = cursor ? decodeCursor(cursor, MessageCursor) : undefined;

  const rows = await db.message.findMany({
    where: { chatId, ...(decoded && { OR: afterCursor(decoded) }) },
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
  const chat = await getOwnedChat(userId, chatId);

  const existing = await findSentMessage(chatId, body.clientRequestId);
  if (existing) return existing;

  const title = chat.title === DEFAULT_CHAT_TITLE ? deriveTitle(body.content) : undefined;

  try {
    const [message, run] = await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          chatId,
          role: "user",
          status: "complete",
          content: [{ type: "text", text: body.content }],
          clientRequestId: body.clientRequestId,
        },
      });
      const run = await tx.agentRun.create({
        data: { chatId, userId, userMessageId: message.id, status: "queued", idempotencyKey: body.clientRequestId },
      });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date(), ...(title && { title }) } });
      return [message, run] as const;
    });
    return { message, run };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const sameSend = await findSentMessage(chatId, body.clientRequestId);
      if (sameSend) return sameSend;
      throw new AppError("RUN_ALREADY_ACTIVE", "A reply is already in progress in this chat.", false);
    }
    throw error;
  }
}

async function findSentMessage(chatId: string, clientRequestId: string) {
  const message = await db.message.findUnique({ where: { chatId_clientRequestId: { chatId, clientRequestId } } });
  if (!message) return null;
  const run = await db.agentRun.findFirstOrThrow({ where: { userMessageId: message.id }, orderBy: { createdAt: "desc" } });
  return { message, run };
}

function deriveTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX_CHARS);
}

export function toMessageDTO(message: PrismaMessage): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    status: message.status,
    content: z.array(ContentBlock).parse(message.content),
    clientRequestId: message.clientRequestId,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
