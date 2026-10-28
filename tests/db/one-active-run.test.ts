import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "@/lib/db";

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { clerkUserId: `test_${randomUUID()}` } });
  userId = user.id;
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function createChatWithMessage() {
  const chat = await db.chat.create({ data: { userId } });
  const message = await db.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [] },
  });
  return { chatId: chat.id, messageId: message.id };
}

async function cleanupChat(chatId: string) {
  await db.agentRun.deleteMany({ where: { chatId } });
  await db.message.deleteMany({ where: { chatId } });
  await db.chat.delete({ where: { id: chatId } });
}

test("a second running run in the same chat is rejected by the partial unique index", async () => {
  const { chatId, messageId } = await createChatWithMessage();
  try {
    await db.agentRun.create({
      data: { chatId, userId, userMessageId: messageId, status: "running", idempotencyKey: randomUUID() },
    });
    const secondMessage = await db.message.create({
      data: { chatId, role: "user", status: "complete", content: [] },
    });

    await expect(
      db.agentRun.create({
        data: { chatId, userId, userMessageId: secondMessage.id, status: "running", idempotencyKey: randomUUID() },
      }),
    ).rejects.toThrow();
  } finally {
    await cleanupChat(chatId);
  }
});

test("retrying a failed run against the same user message is allowed", async () => {
  const { chatId, messageId } = await createChatWithMessage();
  try {
    await db.agentRun.create({
      data: { chatId, userId, userMessageId: messageId, status: "failed", idempotencyKey: randomUUID() },
    });

    await expect(
      db.agentRun.create({
        data: { chatId, userId, userMessageId: messageId, status: "running", idempotencyKey: randomUUID() },
      }),
    ).resolves.toBeDefined();
  } finally {
    await cleanupChat(chatId);
  }
});
