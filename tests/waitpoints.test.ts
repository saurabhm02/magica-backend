import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { metadata, wait } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import { POST as respondRoute } from "@/app/api/v1/chats/[chatId]/waitpoints/[id]/respond/route";
import type { RespondWaitpointResponse } from "@/contracts/api";
import type { ContentBlock } from "@/contracts/content-blocks";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import type { LlmEvent } from "@/lib/types";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";
import { getActiveAgentRun } from "@/modules/runs/runs";
import { runAgentTurn } from "@/trigger/agent-turn";

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { clerkUserId: `test_waitpoint_${randomUUID()}`, creditBalance: 1_000_000n },
  });
  userId = user.id;

  const otherUser = await db.user.create({
    data: { clerkUserId: `test_waitpoint_other_${randomUUID()}`, creditBalance: 1_000_000n },
  });
  otherUserId = otherUser.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(metadata, "replace").mockImplementation(() => {});
  vi.spyOn(metadata, "set").mockReturnValue(metadata);
  vi.spyOn(metadata, "del").mockReturnValue(metadata);
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.waitpoint.deleteMany({ where: { run: { userId: { in: [userId, otherUserId] } } } });
  await db.toolInvocation.deleteMany({ where: { run: { userId: { in: [userId, otherUserId] } } } });
  await db.agentRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.message.deleteMany({ where: { chat: { userId: { in: [userId, otherUserId] } } } });
  await db.chat.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await db.$disconnect();
});

describe("Phase 6: Human Input Waitpoints", () => {
  const sampleQuestions = [
    {
      id: "q_style",
      question: "Which style would you like?",
      type: "choice" as const,
      options: [
        { id: "minimal", label: "Clean Minimal", description: "Studio lighting, plain background", recommended: true },
        { id: "vibrant", label: "Bold & Vibrant", description: "High saturation and contrast" },
      ],
    },
  ];

  it("answer resumes exactly once and updates the step to 'User input received'", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Help me design an ad",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    let resolveForToken: ((val: unknown) => void) | null = null;
    vi.spyOn(wait, "createToken").mockResolvedValue({
      id: `tok_${randomUUID()}`,
      url: "https://api.trigger.dev/v1/waitpoints/tokens/test",
      publicAccessToken: "tok_pub_access",
    } as unknown as Awaited<ReturnType<typeof wait.createToken>>);

    vi.spyOn(wait, "forToken").mockImplementation((async () => {
      return new Promise((resolve) => {
        resolveForToken = resolve;
      });
    }) as unknown as typeof wait.forToken);

    const completeTokenSpy = vi.spyOn(wait, "completeToken").mockImplementation(async (_id, output) => {
      if (resolveForToken) {
        resolveForToken({ ok: true, output });
      }
      return { success: true } as unknown as Awaited<ReturnType<typeof wait.completeToken>>;
    });

    let turnCount = 0;
    async function* gen(): AsyncGenerator<LlmEvent> {
      turnCount++;
      if (turnCount === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_req_opt_1",
          name: "request_user_options",
          arguments: JSON.stringify({
            message: "Please choose your visual style",
            questions: sampleQuestions,
          }),
        };
        yield { type: "done", model: "test-model" };
      } else {
        yield { type: "text-delta", text: "Got your choice! Creating your minimal ad now." };
        yield { type: "done", model: "test-model" };
      }
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    // Start turn asynchronously
    const turnPromise = runAgentTurn(runId, "trace_test_answer");

    // Wait for the waitpoint to be persisted in DB
    let waitpointRow: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      waitpointRow = await db.waitpoint.findFirst({ where: { runId } });
      if (waitpointRow) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(waitpointRow).not.toBeNull();
    expect(waitpointRow?.status).toBe("pending");

    // Check that run status is set to waiting
    const waitingRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(waitingRun.status).toBe("waiting");

    // Now respond via the route
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "test_clerk",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const answersPayload = [{ questionId: "q_style", question: "Which style would you like?", answer: "Clean Minimal" }];
    const req = new NextRequest(`http://localhost/v1/chats/${chat.id}/waitpoints/${waitpointRow!.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: answersPayload }),
    });

    const res = await respondRoute(req, {
      params: Promise.resolve({ chatId: chat.id, id: waitpointRow!.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RespondWaitpointResponse;
    expect(body.status).toBe("answered");
    expect(body.answers).toEqual(answersPayload);
    expect(completeTokenSpy).toHaveBeenCalledTimes(1);

    // Let the agent turn finish
    await turnPromise;

    // Verify DB states after resume
    const finishedRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finishedRun.status).toBe("succeeded");

    const updatedWaitpoint = await db.waitpoint.findUniqueOrThrow({ where: { id: waitpointRow!.id } });
    expect(updatedWaitpoint.status).toBe("answered");

    const toolInv = await db.toolInvocation.findFirstOrThrow({ where: { runId, toolName: "request_user_options" } });
    expect(toolInv.status).toBe("succeeded");

    // Check that assistant message has the updated step
    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: finishedRun.assistantMessageId! } });
    const blocks = assistantMsg.content as ContentBlock[];
    const toolUseBlock = blocks.find((b) => b.type === "tool_use" && b.name === "request_user_options");
    expect(toolUseBlock).toBeDefined();
    const toolUse = toolUseBlock as { label?: string; doneLabel?: string; fields?: Array<{ label: string; value: string }> };
    expect(toolUse.label).toBe("User input received");
    expect(toolUse.doneLabel).toBe("User input received");
    expect(toolUse.fields).toEqual([
      { label: "Which style would you like?", value: "Clean Minimal" },
    ]);
  });

  it("double submit = one completion and returns saved result", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "waiting",
        idempotencyKey: randomUUID(),
      },
    });

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_double_submit",
        toolName: "request_user_options",
        status: "running",
        input: { message: "Choose", questions: sampleQuestions },
        order: 0,
        idempotencyKey: `tool:${run.id}:double`,
      },
    });

    const waitpoint = await db.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: toolInv.id,
        type: "options",
        tokenId: `tok_${randomUUID()}`,
        status: "pending",
        payload: { message: "Choose", questions: sampleQuestions },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `wp:${run.id}:${toolInv.id}`,
      },
    });

    const completeTokenSpy = vi.spyOn(wait, "completeToken").mockResolvedValue({ success: true } as unknown as Awaited<ReturnType<typeof wait.completeToken>>);
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "test_clerk",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const answersPayload = [{ questionId: "q_style", question: "Which style would you like?", answer: "Clean Minimal" }];

    // First submit
    const req1 = new NextRequest(`http://localhost/v1/chats/${chat.id}/waitpoints/${waitpoint.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: answersPayload }),
    });
    const res1 = await respondRoute(req1, {
      params: Promise.resolve({ chatId: chat.id, id: waitpoint.id }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as RespondWaitpointResponse;
    expect(body1.status).toBe("answered");
    expect(completeTokenSpy).toHaveBeenCalledTimes(1);

    // Second submit with different payload
    const req2 = new NextRequest(`http://localhost/v1/chats/${chat.id}/waitpoints/${waitpoint.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [{ questionId: "q_style", answer: "Bold & Vibrant" }] }),
    });
    const res2 = await respondRoute(req2, {
      params: Promise.resolve({ chatId: chat.id, id: waitpoint.id }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as RespondWaitpointResponse;
    expect(body2.status).toBe("answered");
    // Returns original saved result, no extra completeToken call
    expect(body2.answers).toEqual(answersPayload);
    expect(completeTokenSpy).toHaveBeenCalledTimes(1);
  });

  it("skip continues with answers marked skipped", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Make a poster",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    let resolveForToken: ((val: unknown) => void) | null = null;
    vi.spyOn(wait, "createToken").mockResolvedValue({
      id: `tok_${randomUUID()}`,
      url: "https://api.trigger.dev/v1/waitpoints/tokens/test",
      publicAccessToken: "tok_pub_access",
    } as unknown as Awaited<ReturnType<typeof wait.createToken>>);

    vi.spyOn(wait, "forToken").mockImplementation((async () => {
      return new Promise((resolve) => {
        resolveForToken = resolve;
      });
    }) as unknown as typeof wait.forToken);

    vi.spyOn(wait, "completeToken").mockImplementation(async (_id, output) => {
      if (resolveForToken) {
        resolveForToken({ ok: true, output });
      }
      return { success: true } as unknown as Awaited<ReturnType<typeof wait.completeToken>>;
    });

    let turnCount = 0;
    async function* gen(): AsyncGenerator<LlmEvent> {
      turnCount++;
      if (turnCount === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_req_opt_skip",
          name: "request_user_options",
          arguments: JSON.stringify({
            message: "Pick style",
            questions: sampleQuestions,
          }),
        };
        yield { type: "done", model: "test-model" };
      } else {
        yield { type: "text-delta", text: "Proceeding with default recommendations." };
        yield { type: "done", model: "test-model" };
      }
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    const turnPromise = runAgentTurn(runId, "trace_test_skip");

    let waitpointRow: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      waitpointRow = await db.waitpoint.findFirst({ where: { runId } });
      if (waitpointRow) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(waitpointRow).not.toBeNull();

    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "test_clerk",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest(`http://localhost/v1/chats/${chat.id}/waitpoints/${waitpointRow!.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip: true }),
    });

    const res = await respondRoute(req, {
      params: Promise.resolve({ chatId: chat.id, id: waitpointRow!.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RespondWaitpointResponse;
    expect(body.status).toBe("skipped");
    expect(body.answers).toEqual([
      { questionId: "q_style", question: "Which style would you like?", answer: "skipped" },
    ]);

    await turnPromise;

    const finishedRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finishedRun.status).toBe("succeeded");

    const updatedWaitpoint = await db.waitpoint.findUniqueOrThrow({ where: { id: waitpointRow!.id } });
    expect(updatedWaitpoint.status).toBe("skipped");
  });

  it("expiry ends cleanly with safe message", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Generate creative concepts",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    vi.spyOn(wait, "createToken").mockResolvedValue({
      id: `tok_${randomUUID()}`,
      url: "https://api.trigger.dev/v1/waitpoints/tokens/test",
      publicAccessToken: "tok_pub_access",
    } as unknown as Awaited<ReturnType<typeof wait.createToken>>);

    // Simulate timeout error returned by Trigger.dev forToken
    vi.spyOn(wait, "forToken").mockResolvedValue({
      ok: false,
      error: new Error("Token timed out"),
    });

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_req_opt_expire",
        name: "request_user_options",
        arguments: JSON.stringify({
          message: "Please choose",
          questions: sampleQuestions,
        }),
      };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    // Should complete cleanly without throwing an unhandled exception
    await runAgentTurn(runId, "trace_test_expiry");

    const finishedRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finishedRun.status).toBe("failed");
    const runError = finishedRun.error as { code?: string } | null;
    expect(runError?.code).toBe("WAITPOINT_EXPIRED");

    const waitpoint = await db.waitpoint.findFirstOrThrow({ where: { runId } });
    expect(waitpoint.status).toBe("expired");

    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: finishedRun.assistantMessageId! } });
    const blocks = assistantMsg.content as ContentBlock[];
    const textBlock = blocks.find(
      (b) => b.type === "text" && b.text.includes("Waiting for input timed out. You can reply anytime in the chat to continue."),
    );
    expect(textBlock).toBeDefined();

    const toolUseBlock = blocks.find((b) => b.type === "tool_use" && b.name === "request_user_options");
    expect(toolUseBlock).toBeDefined();
    const toolUse = toolUseBlock as { detail?: string };
    expect(toolUse.detail).toContain("Waiting for input timed out");
  });

  it("reload returns the pending waitpoint", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "waiting",
        triggerRunId: "trig_run_reload_test",
        idempotencyKey: randomUUID(),
      },
    });

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_reload",
        toolName: "request_user_options",
        status: "running",
        input: { message: "Choose one", questions: sampleQuestions },
        order: 0,
        idempotencyKey: `tool:${run.id}:reload`,
      },
    });

    const waitpoint = await db.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: toolInv.id,
        type: "options",
        tokenId: `tok_${randomUUID()}`,
        status: "pending",
        payload: { message: "Choose one", questions: sampleQuestions },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `wp:${run.id}:${toolInv.id}`,
      },
    });

    const activeRun = await getActiveAgentRun(userId, chat.id);
    expect(activeRun).not.toBeNull();
    expect(activeRun?.runId).toBe(run.id);
    expect(activeRun?.status).toBe("waiting");
    expect(activeRun?.waitpoint).toBeDefined();
    expect(activeRun?.waitpoint?.id).toBe(waitpoint.id);
    expect(activeRun?.waitpoint?.type).toBe("options");
    expect(activeRun?.waitpoint?.status).toBe("pending");
    expect(activeRun?.waitpoint?.message).toBe("Choose one");
    expect(activeRun?.waitpoint?.questions).toHaveLength(1);
  });

  it("another user gets 404 when attempting to respond", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "waiting",
        idempotencyKey: randomUUID(),
      },
    });

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_unauth",
        toolName: "request_user_options",
        status: "running",
        input: { message: "Choose", questions: sampleQuestions },
        order: 0,
        idempotencyKey: `tool:${run.id}:unauth`,
      },
    });

    const waitpoint = await db.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: toolInv.id,
        type: "options",
        tokenId: `tok_${randomUUID()}`,
        status: "pending",
        payload: { message: "Choose", questions: sampleQuestions },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `wp:${run.id}:${toolInv.id}`,
      },
    });

    // Simulate otherUser making the request
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: otherUserId,
      clerkUserId: "test_clerk_other",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest(`http://localhost/v1/chats/${chat.id}/waitpoints/${waitpoint.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [{ questionId: "q_style", answer: "Option" }] }),
    });

    const res = await respondRoute(req, {
      params: Promise.resolve({ chatId: chat.id, id: waitpoint.id }),
    });
    expect(res.status).toBe(404);
  });
});
