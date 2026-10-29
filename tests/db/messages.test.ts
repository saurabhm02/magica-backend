import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";

let userId: string;
let chatId: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { clerkUserId: `test_${randomUUID()}` } });
  userId = user.id;
});

beforeEach(async () => {
  const chat = await createChat(userId);
  chatId = chat.id;
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

test("sending the same clientRequestId twice returns the same message and run", async () => {
  const clientRequestId = randomUUID();
  const first = await sendMessage(userId, chatId, { content: "hello", clientRequestId, planMode: false });
  const second = await sendMessage(userId, chatId, { content: "hello", clientRequestId, planMode: false });

  expect(second.message.id).toBe(first.message.id);
  expect(second.run.id).toBe(first.run.id);
  expect(await db.message.count({ where: { chatId } })).toBe(1);
});

test("a second send while a run is active is rejected as RUN_ALREADY_ACTIVE", async () => {
  await sendMessage(userId, chatId, { content: "first", clientRequestId: randomUUID(), planMode: false });

  await expect(
    sendMessage(userId, chatId, { content: "second", clientRequestId: randomUUID(), planMode: false }),
  ).rejects.toThrow(AppError);
});

test("the chat title is set from the first message once, not overwritten after", async () => {
  const longContent = "a".repeat(100);
  await sendMessage(userId, chatId, { content: longContent, clientRequestId: randomUUID(), planMode: false });

  const afterFirst = await db.chat.findUniqueOrThrow({ where: { id: chatId } });
  expect(afterFirst.title).toBe("a".repeat(60));

  await db.agentRun.updateMany({ where: { chatId }, data: { status: "succeeded" } });
  await sendMessage(userId, chatId, { content: "a different message", clientRequestId: randomUUID(), planMode: false });

  const afterSecond = await db.chat.findUniqueOrThrow({ where: { id: chatId } });
  expect(afterSecond.title).toBe("a".repeat(60));
});
