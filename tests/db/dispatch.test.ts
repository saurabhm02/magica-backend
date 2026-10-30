import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { db } from "@/lib/db";
import { dispatchRun } from "@/modules/runs/runs";

const { trigger, createPublicToken } = vi.hoisted(() => ({ trigger: vi.fn(), createPublicToken: vi.fn() }));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger },
  auth: { createPublicToken },
  task: (definition: unknown) => definition,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

afterEach(() => {
  trigger.mockReset();
  createPublicToken.mockReset();
});

async function queuedRun(chatId: string, triggerRunId?: string) {
  const message = await db.message.create({ data: { chatId, role: "user", status: "complete", content: [] } });
  return db.agentRun.create({
    data: { chatId, userId, userMessageId: message.id, status: "queued", idempotencyKey: randomUUID(), triggerRunId },
  });
}

test("when the run can't be started, it is failed so the chat isn't locked", async () => {
  trigger.mockRejectedValue(new Error("Trigger.dev is down"));
  const chat = await db.chat.create({ data: { userId } });
  const run = await queuedRun(chat.id);

  await expect(dispatchRun(run, "trace")).rejects.toMatchObject({ code: "INTERNAL", retryable: true });

  const saved = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(saved.status).toBe("failed");
  await expect(queuedRun(chat.id)).resolves.toBeDefined();
});

test("a fresh run triggers the task and returns the Trigger.dev run id", async () => {
  trigger.mockResolvedValue({ id: "run_abc", publicAccessToken: "token_abc" });
  const chat = await db.chat.create({ data: { userId } });
  const run = await queuedRun(chat.id);

  const result = await dispatchRun(run, "trace");

  expect(result).toEqual({ runId: "run_abc", accessToken: "token_abc" });
  expect(trigger).toHaveBeenCalledTimes(1);
  const saved = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(saved.triggerRunId).toBe("run_abc");
});

test("a run that was already dispatched reuses triggerRunId instead of triggering again", async () => {
  const triggerRunId = `run_${randomUUID()}`;
  createPublicToken.mockResolvedValue("token_xyz");
  const chat = await db.chat.create({ data: { userId } });
  const run = await queuedRun(chat.id, triggerRunId);

  const result = await dispatchRun(run, "trace");

  expect(result).toEqual({ runId: triggerRunId, accessToken: "token_xyz" });
  expect(trigger).not.toHaveBeenCalled();
  expect(createPublicToken).toHaveBeenCalledWith({ scopes: { read: { runs: [triggerRunId] } } });
});
