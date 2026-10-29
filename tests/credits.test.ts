import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { metadata } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import { GET as getLedgerRoute } from "@/app/api/v1/me/credits/ledger/route";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import { db } from "@/lib/db";
import * as authModule from "@/lib/auth";
import type { LlmEvent } from "@/lib/types";
import { createChat } from "@/modules/chats/chats";
import {
  getUserCreditBalance,
  grantCredits,
  refundCredits,
  reserveCredits,
  settleCredits,
} from "@/modules/credits/credits";
import { sendMessage } from "@/modules/messages/messages";
import { runAgentTurn, textStream } from "@/trigger/agent-turn";

let userId: string;

async function createTestTool(targetUserId: string) {
  const chat = await createChat(targetUserId);
  const sent = await sendMessage(targetUserId, chat.id, {
    content: "test",
    clientRequestId: randomUUID(),
    planMode: false,
  });
  const tool = await db.toolInvocation.create({
    data: {
      userId: targetUserId,
      runId: sent.run.id,
      toolCallId: randomUUID(),
      order: 0,
      toolName: "test_tool",
      status: "pending",
      input: {},
      idempotencyKey: `tool:${sent.run.id}:${randomUUID()}`,
    },
  });
  return { chat, run: sent.run, tool };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      clerkUserId: `test_credits_${randomUUID()}`,
      creditBalance: 100_000n,
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId } });
  await db.runSkill.deleteMany({ where: { run: { userId } } });
  await db.toolInvocation.deleteMany({ where: { run: { userId } } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("Credits System", { timeout: 60_000 }, () => {
  it("Reserve -> settle -> refund amounts", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_flow_${randomUUID()}`,
        creditBalance: 100_000n,
      },
    });

    const { tool } = await createTestTool(testUser.id);
    const toolInvocationId = tool.id;

    // 1. Reserve 50,000
    const resReserve = await reserveCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 50_000n,
    });
    expect(resReserve.reserved).toBe(true);
    expect(resReserve.balanceAfter).toBe(50_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(50_000n);

    // 2. Settle with actual cost 40,000 (10,000 reservation difference refunded)
    const resSettle = await settleCredits({
      userId: testUser.id,
      toolInvocationId,
      actualCreditUsed: 40_000n,
    });
    expect(resSettle.settled).toBe(true);
    expect(resSettle.balanceAfter).toBe(60_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(60_000n);

    // Teardown test user
    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("settle twice = one charge", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_idempotent_${randomUUID()}`,
        creditBalance: 100_000n,
      },
    });

    const { tool } = await createTestTool(testUser.id);
    const toolInvocationId = tool.id;

    await reserveCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 50_000n,
    });

    const first = await settleCredits({
      userId: testUser.id,
      toolInvocationId,
      actualCreditUsed: 45_000n,
    });
    expect(first.settled).toBe(true);
    expect(first.balanceAfter).toBe(55_000n);

    // Second call with same idempotency key must be a no-op
    const second = await settleCredits({
      userId: testUser.id,
      toolInvocationId,
      actualCreditUsed: 45_000n,
    });
    expect(second.settled).toBe(false);
    expect(second.balanceAfter).toBe(55_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(55_000n);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("failed tool = full refund", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_fail_${randomUUID()}`,
        creditBalance: 100_000n,
      },
    });

    const { tool } = await createTestTool(testUser.id);
    const toolInvocationId = tool.id;

    await reserveCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 52_680n,
    });
    expect(await getUserCreditBalance(testUser.id)).toBe(47_320n);

    const refund = await refundCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 52_680n,
    });
    expect(refund.refunded).toBe(true);
    expect(refund.balanceAfter).toBe(100_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(100_000n);

    // Calling refund again is idempotent
    const refund2 = await refundCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 52_680n,
    });
    expect(refund2.refunded).toBe(false);
    expect(refund2.balanceAfter).toBe(100_000n);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("insufficient balance blocks tool", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_insufficient_${randomUUID()}`,
        creditBalance: 10_000n,
      },
    });

    const { tool } = await createTestTool(testUser.id);
    const toolInvocationId = tool.id;

    await expect(
      reserveCredits({
        userId: testUser.id,
        toolInvocationId,
        amount: 52_680n,
      }),
    ).rejects.toThrow(/Not enough credits to run this/);

    expect(await getUserCreditBalance(testUser.id)).toBe(10_000n);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("ledger balanceAfter consistency", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_ledger_${randomUUID()}`,
        creditBalance: 50_000n,
      },
    });

    // 1. Initial grant
    await grantCredits({
      userId: testUser.id,
      amount: 50_000n,
      idempotencyKey: `grant:${randomUUID()}`,
    });

    // 2. Reserve
    const { tool: tool1Rec } = await createTestTool(testUser.id);
    const tool1 = tool1Rec.id;
    await reserveCredits({ userId: testUser.id, toolInvocationId: tool1, amount: 20_000n });

    // 3. Settle
    await settleCredits({
      userId: testUser.id,
      toolInvocationId: tool1,
      actualCreditUsed: 15_000n,
    });

    // 4. Reserve & fail
    const { tool: tool2Rec } = await createTestTool(testUser.id);
    const tool2 = tool2Rec.id;
    await reserveCredits({ userId: testUser.id, toolInvocationId: tool2, amount: 30_000n });
    await refundCredits({ userId: testUser.id, toolInvocationId: tool2, amount: 30_000n });

    const rows = await db.creditLedger.findMany({
      where: { userId: testUser.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    expect(rows.length).toBeGreaterThan(0);
    let runningBalance = 50_000n; // starting User.creditBalance before transactions
    for (const row of rows) {
      runningBalance += row.amount;
      expect(row.balanceAfter).toBe(runningBalance);
    }

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("concurrent reserves cannot go negative", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_concurrent_${randomUUID()}`,
        creditBalance: 50_000n,
      },
    });

    const tools = await Promise.all(
      Array.from({ length: 5 }).map(() => createTestTool(testUser.id)),
    );

    // Attempt 5 concurrent reserves of 20,000 each (total 100,000 requested on a 50,000 balance)
    const results = await Promise.allSettled(
      tools.map(({ tool }) =>
        reserveCredits({
          userId: testUser.id,
          toolInvocationId: tool.id,
          amount: 20_000n,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 2 can succeed (2 * 20,000 = 40,000 <= 50,000)
    expect(fulfilled.length).toBe(2);
    // Exactly 3 must fail with insufficient credits
    expect(rejected.length).toBe(3);

    const finalBalance = await getUserCreditBalance(testUser.id);
    expect(finalBalance).toBe(10_000n);
    expect(finalBalance).toBeGreaterThanOrEqual(0n);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("mid-turn exhaustion preserves earlier results", async () => {
    // User with 0 credits
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_exhaust_${randomUUID()}`,
        creditBalance: 0n,
      },
    });

    const chat = await createChat(testUser.id);
    const sent = await sendMessage(testUser.id, chat.id, {
      content: "Make an apple and crop it",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    // Mock LLM to first stream partial text, then call gpt_image_2
    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "I'll create that apple for you." };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_apple",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "a red apple", quality: "Medium" }),
      };
      yield { type: "done", model: "test-model" };
    }

    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());
    const metadataStates: unknown[] = [];
    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      metadataStates.push(data);
    });
    vi.spyOn(textStream, "append").mockResolvedValue(undefined);

    await runAgentTurn(runId, "test-exhaust-trace");

    // The run should be marked failed due to INSUFFICIENT_CREDITS
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    const runError = run.error as SafeError | null;
    expect(runError?.code).toBe("INSUFFICIENT_CREDITS");

    // Assistant message should preserve partial text and the failed tool block
    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
    expect(assistantMsg.status).toBe("failed");
    const blocks = assistantMsg.content as ContentBlock[];
    expect(blocks.some((b) => b.type === "text" && b.text.includes("I'll create that apple"))).toBe(true);
    expect(blocks.some((b) => b.type === "tool_result" && b.error?.code === "INSUFFICIENT_CREDITS")).toBe(true);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("actual > estimate still settles once and the ledger adds up", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_overage_${randomUUID()}`,
        creditBalance: 50_000n,
      },
    });

    const { run, tool } = await createTestTool(testUser.id);
    const toolInvocationId = tool.id;

    // 1. Reserve 20,000 (balance becomes 30,000)
    await reserveCredits({
      userId: testUser.id,
      toolInvocationId,
      amount: 20_000n,
    });
    expect(await getUserCreditBalance(testUser.id)).toBe(30_000n);

    // 2. Actual usage 35,000 > 20,000 hold
    const first = await settleCredits({
      userId: testUser.id,
      toolInvocationId,
      actualCreditUsed: 35_000n,
    });
    expect(first.settled).toBe(true);
    // Balance after: 30,000 + 20,000 (refund hold) - 35,000 (settle actual) = 15,000
    expect(first.balanceAfter).toBe(15_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(15_000n);

    // 3. Settle again with same idempotency key must settle once
    const second = await settleCredits({
      userId: testUser.id,
      toolInvocationId,
      actualCreditUsed: 35_000n,
    });
    expect(second.settled).toBe(false);
    expect(second.balanceAfter).toBe(15_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(15_000n);

    // 4. Check ledger entries math
    const rows = await db.creditLedger.findMany({
      where: { userId: testUser.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows.length).toBe(3); // reserve, refund, settle
    expect(rows[0]!.type).toBe("reserve");
    expect(rows[0]!.amount).toBe(-20_000n);
    expect(rows[0]!.balanceAfter).toBe(30_000n);

    expect(rows[1]!.type).toBe("refund");
    expect(rows[1]!.amount).toBe(20_000n);
    expect(rows[1]!.balanceAfter).toBe(50_000n);

    expect(rows[2]!.type).toBe("settle");
    expect(rows[2]!.amount).toBe(-35_000n);
    expect(rows[2]!.balanceAfter).toBe(15_000n);

    // 5. Also test: actual > estimate causing negative balance
    const tool2 = await db.toolInvocation.create({
      data: {
        userId: testUser.id,
        runId: run.id,
        toolCallId: randomUUID(),
        order: 1,
        toolName: "test_tool",
        status: "pending",
        input: {},
        idempotencyKey: `tool:${run.id}:${randomUUID()}`,
      },
    });
    await reserveCredits({
      userId: testUser.id,
      toolInvocationId: tool2.id,
      amount: 15_000n,
    });
    expect(await getUserCreditBalance(testUser.id)).toBe(0n);

    // Actual usage 25,000 > 15,000 hold -> balance goes to -10,000
    const overSettle = await settleCredits({
      userId: testUser.id,
      toolInvocationId: tool2.id,
      actualCreditUsed: 25_000n,
    });
    expect(overSettle.settled).toBe(true);
    expect(overSettle.balanceAfter).toBe(-10_000n);
    expect(await getUserCreditBalance(testUser.id)).toBe(-10_000n);

    // Next reserve must be blocked due to negative balance
    const tool3 = await db.toolInvocation.create({
      data: {
        userId: testUser.id,
        runId: run.id,
        toolCallId: randomUUID(),
        order: 2,
        toolName: "test_tool",
        status: "pending",
        input: {},
        idempotencyKey: `tool:${run.id}:${randomUUID()}`,
      },
    });
    await expect(
      reserveCredits({
        userId: testUser.id,
        toolInvocationId: tool3.id,
        amount: 5_000n,
      }),
    ).rejects.toThrow(/Not enough credits to run this/);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  }, 60_000);

  it("crash after reserve -> the balance is restored and there is exactly one refund row", async () => {
    const testUser = await db.user.create({
      data: {
        clerkUserId: `test_crash_${randomUUID()}`,
        creditBalance: 100_000n,
      },
    });

    const chat = await createChat(testUser.id);
    const sent = await sendMessage(testUser.id, chat.id, {
      content: "Make an apple",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    // Create a tool invocation and reserve credits directly under this run, simulating a hold that was placed right before a crash
    const toolRec = await db.toolInvocation.create({
      data: {
        userId: testUser.id,
        runId,
        toolCallId: "call_crash_test",
        order: 0,
        toolName: "gpt_image_2",
        status: "running",
        input: { prompt: "a red apple" },
        idempotencyKey: `tool:${runId}:call_crash_test`,
      },
    });

    await reserveCredits({
      userId: testUser.id,
      runId,
      toolInvocationId: toolRec.id,
      amount: 79_020n,
    });
    expect(await getUserCreditBalance(testUser.id)).toBe(20_980n);

    // Mock streamChat to simulate a crash during the turn
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => {
      throw new Error("Simulated engine crash during run");
    });
    vi.spyOn(metadata, "replace").mockImplementation(() => {});
    vi.spyOn(textStream, "append").mockResolvedValue(undefined);

    // Running the agent turn will crash
    await expect(runAgentTurn(runId, "trace-crash")).rejects.toThrow("Simulated engine crash during run");

    // Assert: Balance is fully restored back to 100,000n!
    expect(await getUserCreditBalance(testUser.id)).toBe(100_000n);

    // Assert: Exactly one refund row in CreditLedger for this toolInvocation
    const ledgerRows = await db.creditLedger.findMany({
      where: { userId: testUser.id, toolInvocationId: toolRec.id },
    });
    const reserveRows = ledgerRows.filter((r) => r.type === "reserve");
    const refundRows = ledgerRows.filter((r) => r.type === "refund");
    const settleRows = ledgerRows.filter((r) => r.type === "settle");

    expect(reserveRows.length).toBe(1);
    expect(refundRows.length).toBe(1);
    expect(settleRows.length).toBe(0);
    expect(refundRows[0]!.amount).toBe(79_020n);
    expect(refundRows[0]!.balanceAfter).toBe(100_000n);

    await db.creditLedger.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.delete({ where: { id: testUser.id } });
  });

  it("GET /v1/me/credits/ledger returns 200 with numbers and nextCursor", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_clerk",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:4000/v1/me/credits/ledger?limit=5");
    const res = await getLedgerRoute(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: Array<{ amount: number; balanceAfter: number }>; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect("nextCursor" in body).toBe(true);
    for (const item of body.items) {
      expect(typeof item.amount).toBe("number");
      expect(typeof item.balanceAfter).toBe("number");
    }
  });
});
