import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createChat, getOwnedChat, listChats, updateChat } from "@/modules/chats/chats";

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { clerkUserId: `test_${randomUUID()}` } });
  const otherUser = await db.user.create({ data: { clerkUserId: `test_${randomUUID()}` } });
  userId = user.id;
  otherUserId = otherUser.id;
});

afterAll(async () => {
  await db.chat.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await db.$disconnect();
});

test("pinned chats come before unpinned, newest first within each group", async () => {
  const unpinnedOld = await createChat(userId, "unpinned old");
  const unpinnedNew = await createChat(userId, "unpinned new");
  const pinned = await createChat(userId, "pinned");
  await updateChat(userId, pinned.id, { pinned: true });

  const { items } = await listChats(userId, { limit: 10 });

  expect(items.map((chat) => chat.id)).toEqual([pinned.id, unpinnedNew.id, unpinnedOld.id]);
});

test("pagination does not skip or duplicate rows across pages", async () => {
  const created = await Promise.all(Array.from({ length: 5 }, (_, i) => createChat(userId, `page chat ${i}`)));

  const page1 = await listChats(userId, { limit: 2 });
  const page2 = await listChats(userId, { cursor: page1.nextCursor ?? undefined, limit: 2 });
  const page3 = await listChats(userId, { cursor: page2.nextCursor ?? undefined, limit: 2 });

  const seenIds = [...page1.items, ...page2.items, ...page3.items].map((chat) => chat.id);

  expect(new Set(seenIds).size).toBe(seenIds.length);
  for (const chat of created) {
    expect(seenIds).toContain(chat.id);
  }
});

test("another user's chat is not found", async () => {
  const chat = await createChat(otherUserId, "someone else's chat");
  await expect(getOwnedChat(userId, chat.id)).rejects.toThrow(AppError);
});
