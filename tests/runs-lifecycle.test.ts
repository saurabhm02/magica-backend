import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { metadata, runs } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import { db } from "@/lib/db";
import type { LlmEvent } from "@/lib/types";
import { createChat } from "@/modules/chats/chats";
import { getUserCreditBalance, reserveCredits } from "@/modules/credits/credits";
import { sendMessage } from "@/modules/messages/messages";
import { cancelAgentRun, getActiveAgentRun } from "@/modules/runs/runs";
import { runAgentTurn } from "@/trigger/agent-turn";
import { magicaRun } from "@/trigger/magica-run";

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { clerkUserId: `test_lifecycle_${randomUUID()}`, creditBalance: 1_000_000n },
  });
  userId = user.id;

  const otherUser = await db.user.create({
    data: { clerkUserId: `test_lifecycle_other_${randomUUID()}`, creditBalance: 1_000_000n },
  });
  otherUserId = otherUser.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(metadata, "replace").mockImplementation(() => {});
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.toolInvocation.deleteMany({ where: { run: { userId: { in: [userId, otherUserId] } } } });
  await db.agentRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.message.deleteMany({ where: { chat: { userId: { in: [userId, otherUserId] } } } });
  await db.chat.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await db.$disconnect();
});

describe("Phase 5: Runs Lifecycle (Cancel, Reload Recovery, Reconnect)", () => {
  it("cancel during LLM streaming keeps the partial text", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Tell me a story",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;
    const controller = new AbortController();

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Once upon a time in a far away kingdom" };
      // Simulate user clicking Stop while text is streaming
      controller.abort();
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    await runAgentTurn(runId, "test-stream-cancel-trace", controller.signal);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");

    const msg = await db.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
    expect(msg.status).toBe("cancelled");
    const blocks = msg.content as ContentBlock[];
    expect(blocks.some((b) => b.type === "text" && b.text.includes("Once upon a time"))).toBe(true);
  });

  it("cancel during a Magica tool refunds the hold and marks the tool cancelled", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Make an image of a red apple",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;
    const controller = new AbortController();

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_cancel_tool",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "a red apple", quality: "Medium" }),
      };
      yield { type: "done", model: "test-model" };
    }

    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    // When the tool batch is triggered, simulate cancellation abort
    vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async () => {
      controller.abort();
      return {
        runs: [
          {
            id: "child-run-1",
            ok: false,
            error: new Error("Aborted"),
          },
        ],
      } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
    });

    const balanceBefore = await getUserCreditBalance(userId);

    await runAgentTurn(runId, "test-tool-cancel-trace", controller.signal);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");

    // The tool invocation should be marked cancelled
    const tools = await db.toolInvocation.findMany({ where: { runId } });
    expect(tools.length).toBe(1);
    expect(tools[0]!.status).toBe("cancelled");

    // Hold was fully refunded
    const balanceAfter = await getUserCreditBalance(userId);
    expect(balanceAfter).toBe(balanceBefore);

    // There should be a reserve and a refund row in ledger
    const ledger = await db.creditLedger.findMany({ where: { toolInvocationId: tools[0]!.id } });
    expect(ledger.some((r) => r.type === "reserve")).toBe(true);
    expect(ledger.some((r) => r.type === "refund")).toBe(true);
  });

  it("cancel twice is idempotent", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Test cancel twice",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    vi.spyOn(runs, "cancel").mockResolvedValue({} as never);

    // First cancel on active run
    const first = await cancelAgentRun(userId, chat.id, runId);
    expect(first.status).toBe("cancelled");

    // Simulate agent run completing as cancelled in db
    await db.agentRun.update({
      where: { id: runId },
      data: { status: "cancelled", finishedAt: new Date() },
    });

    // Second cancel on already finished run returns current state without error
    const second = await cancelAgentRun(userId, chat.id, runId);
    expect(second.status).toBe("cancelled");
    expect(second.runId).toBe(runId);
  });

  it("active-run returns null for finished runs and 404 for other users' chats", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Test active run",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;
    const triggerRunId = `run_test_${randomUUID()}`;

    // 1. While run is active, active-run returns the run info
    await db.agentRun.update({
      where: { id: runId },
      data: { status: "running", triggerRunId },
    });
    const active = await getActiveAgentRun(userId, chat.id);
    expect(active).not.toBeNull();
    expect(active?.runId).toBe(runId);
    expect(active?.triggerRunId).toBe(triggerRunId);
    expect(active?.status).toBe("running");

    // 2. When run finishes (succeeded), active-run returns null
    await db.agentRun.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    const finished = await getActiveAgentRun(userId, chat.id);
    expect(finished).toBeNull();

    // 3. Other user trying to access chat receives 404 (NOT_FOUND)
    await expect(getActiveAgentRun(otherUserId, chat.id)).rejects.toThrow(/Chat not found/);
  });

  it("cancelling a queued run refunds its hold and frees the chat", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Hello world",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;
    const invId = `inv_${randomUUID()}`;

    await db.toolInvocation.create({
      data: {
        id: invId,
        userId,
        runId,
        toolCallId: "call_1",
        order: 0,
        toolName: "gpt_image_2",
        status: "pending",
        input: { prompt: "test" },
        idempotencyKey: `inv_${invId}`,
      },
    });

    const initialBal = await getUserCreditBalance(userId);
    await reserveCredits({ userId, runId, toolInvocationId: invId, amount: 50_000n });
    const heldBal = await getUserCreditBalance(userId);
    expect(heldBal).toBe(initialBal - 50_000n);

    const cancelRes = await cancelAgentRun(userId, chat.id, runId);
    expect(cancelRes.status).toBe("cancelled");

    const updatedRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(updatedRun.status).toBe("cancelled");

    const refundedBal = await getUserCreditBalance(userId);
    expect(refundedBal).toBe(initialBal);

    const nextSent = await sendMessage(userId, chat.id, {
      content: "Next message",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    expect(nextSent.message.id).toBeDefined();
    expect(nextSent.run.status).toBe("queued");
  });

  it("a stale run is failed and replaced on the next send", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "First task",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const activeRunId = sent.run.id;
    const trigId = `trig_${randomUUID()}`;

    await db.agentRun.update({
      where: { id: activeRunId },
      data: { triggerRunId: trigId, status: "running" },
    });

    vi.spyOn(runs, "retrieve").mockResolvedValue({
      id: trigId,
      status: "COMPLETED",
    } as unknown as Awaited<ReturnType<typeof runs.retrieve>>);

    const secondSent = await sendMessage(userId, chat.id, {
      content: "Second task after stale",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    expect(secondSent.run.id).not.toBe(activeRunId);
    const oldRun = await db.agentRun.findUniqueOrThrow({ where: { id: activeRunId } });
    expect(oldRun.status).toBe("failed");
    expect((oldRun.error as unknown as SafeError).code).toBe("STALE_RUN");

    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    await db.agentRun.update({
      where: { id: secondSent.run.id },
      data: { status: "running", updatedAt: fifteenMinsAgo },
    });

    const thirdSent = await sendMessage(userId, chat.id, {
      content: "Third task after timeout",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    expect(thirdSent.run.id).not.toBe(secondSent.run.id);
    const secondRun = await db.agentRun.findUniqueOrThrow({ where: { id: secondSent.run.id } });
    expect(secondRun.status).toBe("failed");
    expect((secondRun.error as unknown as SafeError).code).toBe("STALE_RUN");
  });
});
