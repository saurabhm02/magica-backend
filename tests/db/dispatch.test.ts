import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { db } from "@/lib/db";
import { dispatchRun } from "@/modules/runs/runs";

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn().mockRejectedValue(new Error("Trigger.dev is down")) },
}));

let userId: string;

beforeAll(async () => {
  userId = (await db.user.create({ data: { clerkUserId: `test_${randomUUID()}` } })).id;
});

afterAll(async () => {
  const chats = await db.chat.findMany({ where: { userId }, select: { id: true } });
  const chatIds = chats.map((chat) => chat.id);
  await db.agentRun.deleteMany({ where: { chatId: { in: chatIds } } });
  await db.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function queuedRun(chatId: string) {
  const message = await db.message.create({ data: { chatId, role: "user", status: "complete", content: [] } });
  return db.agentRun.create({
    data: { chatId, userId, userMessageId: message.id, status: "queued", idempotencyKey: randomUUID() },
  });
}

test("when the run can't be started, it is failed so the chat isn't locked", async () => {
  const chat = await db.chat.create({ data: { userId } });
  const run = await queuedRun(chat.id);

  await expect(dispatchRun(run, "trace")).rejects.toMatchObject({ code: "INTERNAL", retryable: true });

  const saved = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(saved.status).toBe("failed");
  await expect(queuedRun(chat.id)).resolves.toBeDefined();
});
