import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GET as getChatsRoute } from "@/app/api/v1/chats/route";
import type { ListChatsResponse } from "@/contracts/api";
import * as authModule from "@/lib/auth";
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
  await db.message.deleteMany({ where: { chat: { userId: { in: [userId, otherUserId] } } } });
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

test("GET /v1/chats?q=... finds by title, finds by a word only in message, never returns another user's chats", async () => {
  const chatTitleMatch = await createChat(userId, "Unique Alpha Title Project");

  const chatContentMatch = await createChat(userId, "Normal Daily Notes");
  await db.message.create({
    data: {
      chatId: chatContentMatch.id,
      role: "user",
      status: "complete",
      content: [{ type: "text", text: "We need to analyze the secret keyword velociraptor here." }],
      searchText: "We need to analyze the secret keyword velociraptor here.",
    },
  });

  const otherChat = await createChat(otherUserId, "Unique Alpha Title Project from Other User");
  await db.message.create({
    data: {
      chatId: otherChat.id,
      role: "user",
      status: "complete",
      content: [{ type: "text", text: "velociraptor fossil discovered" }],
      searchText: "velociraptor fossil discovered",
    },
  });

  vi.spyOn(authModule, "requireUser").mockResolvedValue({
    id: userId,
    clerkUserId: "mock_a",
    creditBalance: 10_000_000n,
    createdAt: new Date(),
  });

  const reqTitle = new NextRequest("http://localhost:4000/v1/chats?q=alpha");
  const resTitle = await getChatsRoute(reqTitle, { params: Promise.resolve({}) });
  expect(resTitle.status).toBe(200);
  const bodyTitle = (await resTitle.json()) as ListChatsResponse;
  const titleIds = bodyTitle.items.map((c) => c.id);
  expect(titleIds).toContain(chatTitleMatch.id);
  expect(titleIds).not.toContain(otherChat.id);

  const reqMsg = new NextRequest("http://localhost:4000/v1/chats?q=velociraptor");
  const resMsg = await getChatsRoute(reqMsg, { params: Promise.resolve({}) });
  expect(resMsg.status).toBe(200);
  const bodyMsg = (await resMsg.json()) as ListChatsResponse;
  const msgIds = bodyMsg.items.map((c) => c.id);
  expect(msgIds).toContain(chatContentMatch.id);
  expect(msgIds).not.toContain(otherChat.id);
  expect(msgIds).not.toContain(chatTitleMatch.id);

  await updateChat(userId, chatContentMatch.id, { pinned: true });
  const reqPinned = new NextRequest("http://localhost:4000/v1/chats?q=notes");
  const resPinned = await getChatsRoute(reqPinned, { params: Promise.resolve({}) });
  const bodyPinned = (await resPinned.json()) as ListChatsResponse;
  expect(bodyPinned.items[0]?.id).toBe(chatContentMatch.id);
});
