import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { metadata, wait } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { getTool } from "@/agent/tools/registry";
import { GET as activeRunRoute } from "@/app/api/v1/chats/[chatId]/active-run/route";
import type { ActiveRunResponse } from "@/contracts/api";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { RunMetadataPlan } from "@/contracts/run";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import type { LlmEvent, ToolCall } from "@/lib/types";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";
import { getActiveAgentRun } from "@/modules/runs/runs";
import { respondWaitpoint } from "@/modules/waitpoints/waitpoints";
import { runAgentTurn } from "@/trigger/agent-turn";
import { magicaRun } from "@/trigger/magica-run";

let userId: string;
let otherUserId: string;

const tokenResolvers = new Map<string, (val: unknown) => void>();
const pendingCompletions = new Map<string, unknown>();

function completeToken(tokenId: string, output: unknown) {
  const resolve = tokenResolvers.get(tokenId);
  if (resolve) {
    tokenResolvers.delete(tokenId);
    resolve({ ok: true, output });
  } else {
    pendingCompletions.set(tokenId, { ok: true, output });
  }
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { clerkUserId: `test_plan_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  userId = user.id;

  const otherUser = await db.user.create({
    data: { clerkUserId: `test_plan_other_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  otherUserId = otherUser.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  tokenResolvers.clear();
  pendingCompletions.clear();

  vi.spyOn(metadata, "replace").mockImplementation(() => {});
  vi.spyOn(metadata, "set").mockReturnValue(metadata);
  vi.spyOn(metadata, "del").mockReturnValue(metadata);

  vi.spyOn(wait, "createToken").mockImplementation(((async () => ({
    id: `tok_${randomUUID()}`,
    url: "https://api.trigger.dev/v1/waitpoints/tokens/test",
    publicAccessToken: "tok_pub_access",
  })) as unknown) as typeof wait.createToken);

  vi.spyOn(wait, "forToken").mockImplementation(((async (token: string | { id: string }) => {
    const tokenId = typeof token === "string" ? token : token.id;
    const pending = pendingCompletions.get(tokenId);
    if (pending) {
      pendingCompletions.delete(tokenId);
      return pending;
    }
    return new Promise((resolve) => {
      tokenResolvers.set(tokenId, resolve);
    });
  }) as unknown) as typeof wait.forToken);

  vi.spyOn(wait, "completeToken").mockImplementation(async (token: string | { id: string }, output: unknown) => {
    const tokenId = typeof token === "string" ? token : token.id;
    completeToken(tokenId, output);
    return { success: true } as unknown as Awaited<ReturnType<typeof wait.completeToken>>;
  });

  const originalFetch = global.fetch;
  vi.spyOn(global, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/nodes/estimate-credits")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          estimates: [{ microcredits: 140_000 }],
        }),
      } as unknown as Response;
    }
    return originalFetch(input, init);
  });
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

describe("Plan Mode", () => {
  it("plan mode never runs a paid tool before approval", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "running",
        planMode: true,
        idempotencyKey: randomUUID(),
      },
    });

    const toolCalls: ToolCall[] = [
      {
        id: "call_gpt_image_blocked",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "A coffee mug on a desk" }),
      },
    ];

    const toolsMetadata: NonNullable<import("@/contracts/run").RunMetadata["tools"]> = [];
    const assetsMetadata: NonNullable<import("@/contracts/run").RunMetadata["assets"]> = [];

    const magicaBatchSpy = vi.spyOn(magicaRun, "batchTriggerAndWait");

    const result = await executeTurnTools({
      runId: run.id,
      userId,
      traceId: "trace_plan_blocked",
      signal: new AbortController().signal,
      toolCalls,
      toolsMetadata,
      assetsMetadata,
      planMode: true,
      planApproved: false,
      onMetadataChange: () => {},
    });

    // Magica tool should NOT have been dispatched
    expect(magicaBatchSpy).not.toHaveBeenCalled();

    // Tool invocation row in DB should be marked failed
    const toolInv = await db.toolInvocation.findFirstOrThrow({
      where: { runId: run.id, toolName: "gpt_image_2" },
    });
    expect(toolInv.status).toBe("failed");

    // Tool result message returned to model explains that plan mode is active
    expect(result.toolMessages).toHaveLength(1);
    const content = JSON.parse(String(result.toolMessages[0]?.content ?? "{}"));
    expect(content.error).toContain("Plan mode is active");
    expect(content.error).toContain("submit_plan");
  });

  it("hides paid tools from the model until the plan is approved, so it has to call submit_plan", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, { content: "make 2 product photos", clientRequestId: randomUUID(), planMode: true });

    const offeredTools: string[][] = [];
    async function* reply(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Let me plan that." };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation((_models, _messages, _signal, tools) => {
      offeredTools.push((tools ?? []).map((t) => (t.type === "function" ? t.function.name : "")));
      return reply();
    });
    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValue(undefined);

    await runAgentTurn(sent.run.id, "trace_plan_tools");

    expect(offeredTools[0]).toContain("submit_plan");
    for (const paid of ["gpt_image_2", "crop_image", "merge_videos"]) expect(offeredTools[0]).not.toContain(paid);
  });

  it("estimates come from the registry", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "running",
        planMode: true,
        idempotencyKey: randomUUID(),
      },
    });

    const submitPlanTool = getTool("submit_plan");
    expect(submitPlanTool).toBeDefined();

    const gptTool = getTool("gpt_image_2");
    const cropTool = getTool("crop_image");
    expect(gptTool).toBeDefined();
    expect(cropTool).toBeDefined();

    const step1Input = { prompt: "Coffee mug on marble table" };
    const step2Input = { image_url: "https://example.com/mug.png", width_percent: 50, height_percent: 100 };

    const expectedEst1 = await gptTool!.estimateCredits(step1Input);
    const expectedEst2 = await cropTool!.estimateCredits(step2Input);
    const expectedTotal = expectedEst1 + expectedEst2;

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_submit_plan_est",
        toolName: "submit_plan",
        status: "running",
        input: {},
        order: 0,
        idempotencyKey: `tool:${run.id}:est`,
      },
    });

    // Pre-complete token so execute doesn't wait
    const execPromise = (submitPlanTool as unknown as import("@/lib/types").LocalTool).execute(
      {
        title: "Coffee Mug Ad",
        overview: "Generate and crop photo",
        steps: [
          { title: "Generate photo", description: "Studio coffee mug", tool: "gpt_image_2", input: step1Input },
          { title: "Crop photo", description: "Story 9:16 crop", tool: "crop_image", input: step2Input },
        ],
      },
      {
        runId: run.id,
        userId,
        toolInvocationId: toolInv.id,
        traceId: "trace_est",
        order: 0,
        signal: new AbortController().signal,
      },
    );

    let waitpoint: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      waitpoint = await db.waitpoint.findFirst({
        where: { runId: run.id, toolInvocationId: toolInv.id },
      });
      if (waitpoint) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(waitpoint).not.toBeNull();

    completeToken(waitpoint!.tokenId, { action: "run_all" });
    await execPromise;

    const payload = waitpoint!.payload as {
      title: string;
      overview: string;
      totalEstimatedCredits: number;
      steps: Array<{ tool: string; estimatedCredits: number }>;
    };

    expect(payload.title).toBe("Coffee Mug Ad");
    expect(payload.steps).toHaveLength(2);
    expect(payload.steps[0]?.estimatedCredits).toBe(expectedEst1);
    expect(payload.steps[1]?.estimatedCredits).toBe(expectedEst2);
    expect(payload.totalEstimatedCredits).toBe(expectedTotal);
  });

  it("run_all runs all steps and updates progress", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Create a coffee mug photo and crop it",
      clientRequestId: randomUUID(),
      planMode: true,
    });
    const runId = sent.run.id;

    const planMetadataUpdates: RunMetadataPlan[] = [];
    vi.spyOn(metadata, "set").mockImplementation((key, val) => {
      if (key === "plan") {
        planMetadataUpdates.push(JSON.parse(JSON.stringify(val)));
      }
      return metadata;
    });

    vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async (items) => {
      const itemList = items as Array<{ payload: { toolInvocationId: string; nodeType: string } }>;
      const runs = itemList.map((item) => ({
        id: item.payload.toolInvocationId,
        ok: true,
        output: {
          ok: true,
          output:
            item.payload.nodeType === "crop_image"
              ? { image_url: "https://assets.magica.ai/cropped_mug.png" }
              : { images: ["https://assets.magica.ai/generated_mug.png"] },
          creditUsed: 140_000,
        },
      }));
      return { runs } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
    });

    let turnCount = 0;
    async function* gen(): AsyncGenerator<LlmEvent> {
      turnCount++;
      if (turnCount === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_plan_1",
          name: "submit_plan",
          arguments: JSON.stringify({
            title: "Coffee Mug + Crop",
            overview: "Studio photo and crop",
            steps: [
              { title: "Generate Mug", description: "Studio mug photo", tool: "gpt_image_2", input: { prompt: "Mug" } },
              { title: "Crop Mug", description: "Story crop", tool: "crop_image", input: { image_url: "$last", width_percent: 50, height_percent: 100 } },
            ],
          }),
        };
        yield { type: "done", model: "test-model" };
      } else {
        yield { type: "text-delta", text: "All steps finished successfully!" };
        yield { type: "done", model: "test-model" };
      }
    }
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => gen());

    const turnPromise = runAgentTurn(runId, "trace_run_all");

    let waitpointRow: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      waitpointRow = await db.waitpoint.findFirst({ where: { runId, type: "plan", status: "pending" } });
      if (waitpointRow) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(waitpointRow).not.toBeNull();

    // Respond with run_all via respondWaitpoint
    await respondWaitpoint({
      userId,
      chatId: chat.id,
      waitpointId: waitpointRow!.id,
      body: { action: "run_all" },
    });

    await turnPromise;

    // Verify DB states
    const finishedRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finishedRun.status).toBe("succeeded");

    // Both steps should have executed as tool invocations
    const gptInv = await db.toolInvocation.findFirst({ where: { runId, toolName: "gpt_image_2" } });
    const cropInv = await db.toolInvocation.findFirst({ where: { runId, toolName: "crop_image" } });
    expect(gptInv?.status).toBe("succeeded");
    expect(cropInv?.status).toBe("succeeded");

    // Verify plan progress metadata updates
    expect(planMetadataUpdates.length).toBeGreaterThan(0);
    const finalPlanMeta = planMetadataUpdates.at(-1);
    expect(finalPlanMeta?.done).toBe(2);
    expect(finalPlanMeta?.total).toBe(2);
    expect(finalPlanMeta?.steps.every((s) => s.status === "done")).toBe(true);

    // Verify assistant message contains step blocks and approved plan step label
    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: finishedRun.assistantMessageId! } });
    const blocks = assistantMsg.content as ContentBlock[];
    const planBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_plan") as { label?: string; fields?: Array<{ label: string; value: string }> } | undefined;
    expect(planBlock?.label).toContain("Plan approved Coffee Mug + Crop (2 steps)");
    expect(planBlock?.fields?.some((f) => f.label === "Title")).toBe(true);
    expect(planBlock?.fields?.some((f) => f.label === "Total estimated")).toBe(true);
  });

  it("request_changes returns a new plan", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Make an ad banner",
      clientRequestId: randomUUID(),
      planMode: true,
    });
    const runId = sent.run.id;

    let turnCount = 0;
    let turn2ToolContent = "";

    async function* gen(messages: import("@/lib/types").LlmMessage[]): AsyncGenerator<LlmEvent> {
      turnCount++;
      if (turnCount === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_plan_v1",
          name: "submit_plan",
          arguments: JSON.stringify({
            title: "Banner V1",
            overview: "Initial concept",
            steps: [{ title: "Step 1", description: "Draft", tool: "gpt_image_2", input: { prompt: "V1" } }],
          }),
        };
        yield { type: "done", model: "test-model" };
      } else if (turnCount === 2) {
        const lastMsg = messages.at(-1);
        turn2ToolContent = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content ?? "");
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_plan_v2",
          name: "submit_plan",
          arguments: JSON.stringify({
            title: "Banner V2 (Revised)",
            overview: "Revised concept with 2 steps",
            steps: [
              { title: "Step 1", description: "Background", tool: "gpt_image_2", input: { prompt: "V2" } },
              { title: "Step 2", description: "Crop", tool: "crop_image", input: { image_url: "https://test.com/v2.png" } },
            ],
          }),
        };
        yield { type: "done", model: "test-model" };
      } else {
        yield { type: "text-delta", text: "Plan revised." };
        yield { type: "done", model: "test-model" };
      }
    }
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation((_models, msgs) => gen(msgs));

    const turnPromise = runAgentTurn(runId, "trace_request_changes");

    // Wait for first waitpoint
    let v1Waitpoint: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      v1Waitpoint = await db.waitpoint.findFirst({ where: { runId, type: "plan", status: "pending" } });
      if (v1Waitpoint) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(v1Waitpoint).not.toBeNull();

    // Respond to first waitpoint with request_changes
    await respondWaitpoint({
      userId,
      chatId: chat.id,
      waitpointId: v1Waitpoint!.id,
      body: { request_changes: "Please add a crop step and make it 2 steps" },
    });

    // Wait for second waitpoint to appear
    let v2Waitpoint: Awaited<ReturnType<typeof db.waitpoint.findFirst>> = null;
    for (let i = 0; i < 30; i++) {
      v2Waitpoint = await db.waitpoint.findFirst({
        where: { runId, type: "plan", status: "pending", id: { not: v1Waitpoint!.id } },
      });
      if (v2Waitpoint) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(v2Waitpoint).not.toBeNull();
    const v2Payload = v2Waitpoint?.payload as { title: string; steps: unknown[] };
    expect(v2Payload.title).toBe("Banner V2 (Revised)");
    expect(v2Payload.steps).toHaveLength(2);

    // Verify feedback was passed in tool message to LLM
    expect(turn2ToolContent).toContain("request_changes");
    expect(turn2ToolContent).toContain("Please add a crop step and make it 2 steps");

    // Complete second waitpoint as run_all to cleanly finish turn
    await respondWaitpoint({
      userId,
      chatId: chat.id,
      waitpointId: v2Waitpoint!.id,
      body: { action: "run_all" },
    });

    await turnPromise;
  });

  it("a chat message while waiting = request_changes", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "waiting",
        planMode: true,
        idempotencyKey: randomUUID(),
      },
    });

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_plan_wait_msg",
        toolName: "submit_plan",
        status: "running",
        input: {},
        order: 0,
        idempotencyKey: `tool:${run.id}:wait_msg`,
      },
    });

    const waitpoint = await db.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: toolInv.id,
        type: "plan",
        tokenId: `tok_${randomUUID()}`,
        status: "pending",
        payload: { title: "Test Plan", overview: "Test", steps: [] },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `wp:${run.id}:${toolInv.id}`,
      },
    });

    const completeTokenSpy = vi.spyOn(wait, "completeToken");

    // Send a normal chat message while plan is waiting
    const sent = await sendMessage(userId, chat.id, {
      content: "Have a question first? Can we use vertical aspect ratio?",
      clientRequestId: randomUUID(),
      planMode: true,
    });

    // Should return existing run, NOT create a duplicate run
    expect(sent.run.id).toBe(run.id);

    // Verify waitpoint was answered with request_changes
    const updatedWp = await db.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(updatedWp.status).toBe("answered");
    const response = updatedWp.response as { action: string; feedback: string };
    expect(response.action).toBe("request_changes");
    expect(response.feedback).toBe("Have a question first? Can we use vertical aspect ratio?");

    expect(completeTokenSpy).toHaveBeenCalledWith(
      waitpoint.tokenId,
      expect.objectContaining({
        action: "request_changes",
        feedback: "Have a question first? Can we use vertical aspect ratio?",
      }),
    );
  });

  it("step_by_step pauses between steps", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "running",
        planMode: true,
        idempotencyKey: randomUUID(),
      },
    });

    let planTokenId: string | undefined;
    let pauseTokenId: string | undefined;

    vi.spyOn(wait, "createToken").mockImplementation(((async () => {
      const id = `tok_${randomUUID()}`;
      if (!planTokenId) {
        planTokenId = id;
        setTimeout(() => completeToken(id, { action: "step_by_step" }), 10);
      } else {
        pauseTokenId = id;
        setTimeout(() => completeToken(id, { answers: [{ questionId: "step_continuation", answer: "Stop" }] }), 10);
      }
      return {
        id,
        url: "https://api.trigger.dev/v1/waitpoints/tokens/test",
        publicAccessToken: "tok_pub_access",
      };
    }) as unknown) as typeof wait.createToken);

    vi.spyOn(magicaRun, "batchTriggerAndWait").mockResolvedValue({
      runs: [
        {
          id: "step_1",
          ok: true,
          output: {
            ok: true,
            output: { images: ["https://test.com/img1.png"] },
            creditUsed: 100_000,
          },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>);

    const toolsMetadata: NonNullable<import("@/contracts/run").RunMetadata["tools"]> = [];
    const assetsMetadata: NonNullable<import("@/contracts/run").RunMetadata["assets"]> = [];

    const toolCalls: ToolCall[] = [
      {
        id: "call_submit_plan_sbs",
        name: "submit_plan",
        arguments: JSON.stringify({
          title: "Two-step process",
          overview: "Step by step test",
          steps: [
            { title: "Generate 1", description: "First image", tool: "gpt_image_2", input: { prompt: "Img 1" } },
            { title: "Generate 2", description: "Second image", tool: "gpt_image_2", input: { prompt: "Img 2" } },
          ],
        }),
      },
    ];

    await executeTurnTools({
      runId: run.id,
      userId,
      traceId: "trace_sbs",
      signal: new AbortController().signal,
      toolCalls,
      toolsMetadata,
      assetsMetadata,
      planMode: true,
      planApproved: false,
      onMetadataChange: () => {},
    });

    // Check that pause waitpoint was created between Step 1 and Step 2
    expect(pauseTokenId).toBeDefined();
    const pauseWp = await db.waitpoint.findFirst({
      where: {
        runId: run.id,
        tokenId: pauseTokenId,
      },
    });
    expect(pauseWp).not.toBeNull();
    const payload = pauseWp?.payload as { message: string; questions: Array<{ id: string }> };
    expect(payload.message).toContain("Step 1 (Generate 1) completed. Continue to next step?");
    expect(payload.questions[0]?.id).toBe("step_continuation");

    // Since user selected "Stop", Step 2 should NOT have executed
    const stepInvocations = await db.toolInvocation.findMany({
      where: { runId: run.id, toolName: "gpt_image_2" },
    });
    expect(stepInvocations).toHaveLength(1);
  });

  it("reload returns the pending plan", async () => {
    const chat = await createChat(userId);
    const run = await db.agentRun.create({
      data: {
        userId,
        chatId: chat.id,
        userMessageId: (await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } })).id,
        status: "waiting",
        planMode: true,
        triggerRunId: `trig_${randomUUID()}`,
        idempotencyKey: randomUUID(),
      },
    });

    const toolInv = await db.toolInvocation.create({
      data: {
        runId: run.id,
        userId,
        toolCallId: "call_plan_reload",
        toolName: "submit_plan",
        status: "running",
        input: {},
        order: 0,
        idempotencyKey: `tool:${run.id}:reload`,
      },
    });

    const planPayload = {
      title: "Hero Banner Campaign",
      overview: "Full multi-format ad generation",
      totalEstimatedCredits: 350_000,
      steps: [
        { title: "Generate product photo", description: "Studio product shot", tool: "gpt_image_2", estimatedCredits: 200_000 },
        { title: "Crop 9:16", description: "Instagram story", tool: "crop_image", estimatedCredits: 150_000 },
      ],
    };

    const waitpoint = await db.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: toolInv.id,
        type: "plan",
        tokenId: `tok_${randomUUID()}`,
        status: "pending",
        payload: planPayload,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `wp:${run.id}:${toolInv.id}`,
      },
    });

    // 1. Direct getActiveAgentRun function call
    const active = await getActiveAgentRun(userId, chat.id);
    expect(active).not.toBeNull();
    expect(active?.runId).toBe(run.id);
    expect(active?.status).toBe("waiting");
    expect(active?.waitpoint).toBeDefined();
    expect(active?.waitpoint?.id).toBe(waitpoint.id);
    expect(active?.waitpoint?.type).toBe("plan");
    expect(active?.waitpoint?.status).toBe("pending");
    expect(active?.waitpoint?.payload).toEqual(planPayload);

    // 2. HTTP GET /v1/chats/:chatId/active-run route
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "test_clerk",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest(`http://localhost/v1/chats/${chat.id}/active-run`);
    const res = await activeRunRoute(req, {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActiveRunResponse;
    expect(body?.runId).toBe(run.id);
    expect(body?.status).toBe("waiting");
    expect(body?.waitpoint?.type).toBe("plan");
    expect(body?.waitpoint?.payload).toEqual(planPayload);
  });
});
