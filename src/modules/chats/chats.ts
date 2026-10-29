import type { Chat as PrismaChat, Prisma } from "@prisma/client";
import { z } from "zod";
import type { Chat } from "@/contracts/chat";
import { db } from "@/lib/db";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { AppError } from "@/lib/errors";

const ChatCursor = z.object({ pinned: z.boolean(), updatedAt: z.iso.datetime(), id: z.string() });
type ChatCursor = z.infer<typeof ChatCursor>;

function afterCursor(cursor: ChatCursor) {
  const updatedAt = new Date(cursor.updatedAt);
  const sameBucket = [
    { pinned: cursor.pinned, updatedAt: { lt: updatedAt } },
    { pinned: cursor.pinned, updatedAt, id: { lt: cursor.id } },
  ];
  return cursor.pinned ? [{ pinned: false }, ...sameBucket] : sameBucket;
}

export async function getOwnedChat(userId: string, chatId: string) {
  const chat = await db.chat.findFirst({ where: { id: chatId, userId, deletedAt: null } });
  if (!chat) throw new AppError("NOT_FOUND", "Chat not found", false);
  return chat;
}

export function createChat(userId: string, title?: string) {
  return db.chat.create({ data: { userId, ...(title && { title }) } });
}

export async function listChats(
  userId: string,
  { cursor, limit, q }: { cursor?: string; limit: number; q?: string }
) {
  const decoded = cursor ? decodeCursor(cursor, ChatCursor) : undefined;
  const trimmedQ = q?.trim();

  const searchFilter = trimmedQ
    ? {
        OR: [
          { title: { contains: trimmedQ, mode: "insensitive" as const } },
          {
            messages: {
              some: {
                searchText: { contains: trimmedQ, mode: "insensitive" as const },
              },
            },
          },
        ],
      }
    : undefined;

  const conditions: Prisma.ChatWhereInput[] = [];
  if (decoded) conditions.push({ OR: afterCursor(decoded) });
  if (searchFilter) conditions.push(searchFilter);

  const rows = await db.chat.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(conditions.length > 0 && { AND: conditions }),
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ pinned: last.pinned, updatedAt: last.updatedAt.toISOString(), id: last.id })
      : null;

  return { items, nextCursor };
}

export async function updateChat(userId: string, chatId: string, data: { title?: string; pinned?: boolean }) {
  await getOwnedChat(userId, chatId);
  return db.chat.update({ where: { id: chatId }, data });
}

export async function softDeleteChat(userId: string, chatId: string) {
  await getOwnedChat(userId, chatId);
  await db.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
}

export function toChatDTO(chat: PrismaChat): Chat {
  return {
    id: chat.id,
    title: chat.title,
    pinned: chat.pinned,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}
