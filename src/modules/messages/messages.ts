import type { Message as PrismaMessage } from "@prisma/client";
import { z } from "zod";
import { ContentBlock } from "@/contracts/content-blocks";
import type { Message } from "@/contracts/message";
import { getOwnedChat } from "@/modules/chats/chats";
import { db } from "@/lib/db";
import { decodeCursor, encodeCursor } from "@/lib/cursor";

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
