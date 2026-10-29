import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { runNode } from "@/agent/magica";
import { executeTurnTools } from "@/agent/run-tools";
import { buildCropImageParams, cropImageTool } from "@/agent/tools/crop-image";
import { gptImage2Tool } from "@/agent/tools/gpt-image-2";
import { mergeVideosTool } from "@/agent/tools/merge-videos";
import { getUserFacingTools } from "@/agent/tools/registry";
import { GET as getToolsRoute } from "@/app/api/v1/tools/route";
import type { ListToolsResponse } from "@/contracts/api";
import type { SafeError } from "@/contracts/errors";
import { executeMagicaRun, magicaRun } from "@/trigger/magica-run";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { SAFE_ERROR_MESSAGES } from "@/lib/constants";

const baseUrl = process.env.MAGICA_BASE_URL?.replace(/\/$/, "") || "https://inference.magica.com";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe("Tool input validation", () => {
  it("rejects invalid input without crashing", () => {
    const invalidCrop = cropImageTool.inputSchema.safeParse({ image_url: "not-a-valid-url" });
    expect(invalidCrop.success).toBe(false);

    const invalidVideos = mergeVideosTool.inputSchema.safeParse({
      video_urls: ["https://example.com/one.mp4"],
      transition: "fade",
    });
    expect(invalidVideos.success).toBe(false);

    const validCrop = cropImageTool.inputSchema.safeParse({
      image_url: "https://example.com/pic.jpg",
      x_percent: 10,
      y_percent: 10,
      width_percent: 80,
      height_percent: 80,
    });
    expect(validCrop.success).toBe(true);
  });

  it("rejects an invalid size in gpt_image_2 schema and describe() returns model 'GPT Image 2'", () => {
    const invalidSize = gptImage2Tool.inputSchema.safeParse({
      prompt: "a red apple",
      size: "1024x768",
    });
    expect(invalidSize.success).toBe(false);

    const validSize = gptImage2Tool.inputSchema.safeParse({
      prompt: "a red apple",
      size: "1024x1024",
    });
    expect(validSize.success).toBe(true);

    const desc = gptImage2Tool.describe({ prompt: "a red apple", size: "1024x1024" });
    expect(desc.model).toBe("GPT Image 2");
  });

  it("maps crop object to pixel coordinates without guessing", () => {
    const params = buildCropImageParams({
      image_url: "https://example.com/pic.jpg",
      crop: { x: 10, y: 20, width: 300, height: 400 },
    });

    expect(params).toEqual({
      image_url: "https://example.com/pic.jpg",
      x_px: 10,
      y_px: 20,
      width_px: 300,
      height_px: 400,
    });
  });
});

describe("Magica API error handling", () => {
  it("maps 401 to MAGICA_UNAUTHORIZED without retrying", async () => {
    let callCount = 0;
    server.use(
      http.post(`${baseUrl}/v1/nodes/:nodeType/run`, () => {
        callCount++;
        return HttpResponse.json({ message: "Invalid API key" }, { status: 401 });
      }),
    );

    let thrown: unknown;
    try {
      await runNode("crop_image", { input: { image_url: "https://example.com/pic.jpg" } });
    } catch (err) {
      thrown = err;
    }

    expect(callCount).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("MAGICA_UNAUTHORIZED");
    expect((thrown as AppError).retryable).toBe(false);
  });

  it("maps 403 to MAGICA_UNAUTHORIZED with provider credits message", async () => {
    server.use(
      http.post(`${baseUrl}/v1/nodes/:nodeType/run`, () => {
        return HttpResponse.json({ message: "Insufficient credits" }, { status: 403 });
      }),
    );

    let thrown: unknown;
    try {
      await runNode("crop_image", { input: { image_url: "https://example.com/pic.jpg" } });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("CREDITS_EXHAUSTED");
    expect((thrown as AppError).message.toLowerCase()).toContain("credits");
    expect((thrown as AppError).retryable).toBe(false);
  });

  it("runNode never passes raw Magica errors, maps 403 to CREDITS_EXHAUSTED", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn<typeof fetch>();
    globalThis.fetch = mockFetch;

    try {
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "Internal raw stripe payment failure", message: "secret internal provider message" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ));

      await expect(
        runNode("gpt_image_2", { input: { prompt: "test" } }),
      ).rejects.toThrow();

      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "Internal raw stripe payment failure", message: "secret internal provider message" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ));

      try {
        await runNode("gpt_image_2", { input: { prompt: "test" } });
      } catch (err) {
        const e = err as SafeError;
        expect(e.code).toBe("CREDITS_EXHAUSTED");
        expect(e.message).toBe(SAFE_ERROR_MESSAGES.CREDITS_EXHAUSTED);
        expect(e.message).not.toContain("secret internal");
      }

      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "Internal crash in GPU cluster node 99" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ));

      try {
        await runNode("gpt_image_2", { input: { prompt: "test" } });
      } catch (err) {
        const e = err as SafeError;
        expect(e.code).toBe("MAGICA_RUN_FAILED");
        expect(e.message).toBe(SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED);
        expect(e.message).not.toContain("GPU cluster");
      }

      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ userMessage: "Aspect ratio must be square" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));

      try {
        await runNode("gpt_image_2", { input: { prompt: "test" } });
      } catch (err) {
        const e = err as SafeError;
        expect(e.code).toBe("TOOL_INPUT_INVALID");
        expect(e.message).toBe("Aspect ratio must be square");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on 429 with backoff and succeeds", async () => {
    let callCount = 0;
    server.use(
      http.post(`${baseUrl}/v1/nodes/:nodeType/run`, () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(JSON.stringify({ message: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after-ms": "5" },
          });
        }
        return HttpResponse.json({ runId: "magica-run-123" }, { status: 202 });
      }),
    );

    const res = await runNode("crop_image", { input: { image_url: "https://example.com/pic.jpg" } });
    expect(callCount).toBe(2);
    expect(res.runId).toBe("magica-run-123");
  });

  it("maps polling timeout to MAGICA_TIMEOUT", async () => {
    server.use(
      http.get(`${baseUrl}/v1/nodes/runs/:runId`, () => {
        return HttpResponse.json({ id: "magica-run-timeout", status: "RUNNING" });
      }),
    );

    vi.spyOn(db.toolInvocation, "findUniqueOrThrow").mockResolvedValueOnce({
      id: "inv-timeout",
      magicaRunId: "magica-run-timeout",
      runId: "run-1",
      toolName: "crop_image",
      toolCallId: "tc_timeout",
      idempotencyKey: "idem_timeout",
      order: 0,
      input: {},
      output: null,
      error: null,
      credits: 0n,
      status: "running",
      durationMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let thrown: unknown;
    try {
      await executeMagicaRun(
        {
          toolInvocationId: "inv-timeout",
          nodeType: "crop_image",
          params: {},
        },
        {
          timeoutMs: 30,
          sleep: async () => {},
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("MAGICA_TIMEOUT");
    expect((thrown as AppError).retryable).toBe(false);
  });

  it("maps failed run to MAGICA_RUN_FAILED without retrying", async () => {
    let pollCount = 0;
    server.use(
      http.get(`${baseUrl}/v1/nodes/runs/:runId`, () => {
        pollCount++;
        return HttpResponse.json({
          id: "magica-run-fail",
          status: "FAILED",
          userMessage: "GPU node crashed",
        });
      }),
    );

    vi.spyOn(db.toolInvocation, "findUniqueOrThrow").mockResolvedValueOnce({
      id: "inv-fail",
      magicaRunId: "magica-run-fail",
      runId: "run-1",
      toolName: "crop_image",
      toolCallId: "tc_fail",
      idempotencyKey: "idem_fail",
      order: 0,
      input: {},
      output: null,
      error: null,
      credits: 0n,
      status: "running",
      durationMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let thrown: unknown;
    try {
      await executeMagicaRun(
        {
          toolInvocationId: "inv-fail",
          nodeType: "crop_image",
          params: {},
        },
        {
          timeoutMs: 1000,
          sleep: async () => {},
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(pollCount).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("MAGICA_RUN_FAILED");
    expect((thrown as AppError).message).toBe(SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED);
    expect((thrown as AppError).retryable).toBe(false);
  });
});

describe("Trigger magica-run task idempotency", () => {
  it("duplicate dispatch skips POST and reuses existing magicaRunId", async () => {
    let postCount = 0;
    let getCount = 0;

    server.use(
      http.post(`${baseUrl}/v1/nodes/:nodeType/run`, () => {
        postCount++;
        return HttpResponse.json({ runId: "new-run-id" }, { status: 202 });
      }),
      http.get(`${baseUrl}/v1/nodes/runs/:runId`, ({ params }) => {
        getCount++;
        expect(params.runId).toBe("existing-magica-run-456");
        return HttpResponse.json({
          id: "existing-magica-run-456",
          status: "COMPLETED",
          output: { image_url: "https://example.com/output.png" },
        });
      }),
    );

    vi.spyOn(db.toolInvocation, "findUniqueOrThrow").mockResolvedValueOnce({
      id: "invocation-1",
      magicaRunId: "existing-magica-run-456",
      runId: "run-1",
      toolName: "crop_image",
      toolCallId: "tc_1",
      idempotencyKey: "idem_1",
      order: 0,
      input: {},
      output: null,
      error: null,
      credits: 0n,
      status: "running",
      durationMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await executeMagicaRun(
      {
        toolInvocationId: "invocation-1",
        nodeType: "crop_image",
        params: { image_url: "https://example.com/test.jpg" },
      },
      { sleep: async () => {} },
    );

    expect(postCount).toBe(0);
    expect(getCount).toBe(1);
    expect(result).toEqual({ output: { image_url: "https://example.com/output.png" }, creditUsed: undefined });
  });
});

describe("Parallel tool execution ordering", () => {
  it("preserves original call order when tools finish in different order", async () => {
    const invocations = [
      { id: "call_slow", delayMs: 40, output: { slow: true } },
      { id: "call_fast", delayMs: 5, output: { fast: true } },
    ];

    const results = await Promise.all(
      invocations.map(async (inv, order) => {
        await new Promise((r) => setTimeout(r, inv.delayMs));
        return { order, id: inv.id, output: inv.output };
      }),
    );

    expect(results[0]?.id).toBe("call_slow");
    expect(results[0]?.order).toBe(0);
    expect(results[1]?.id).toBe("call_fast");
    expect(results[1]?.order).toBe(1);
  });
});

describe("executeTurnTools", () => {
  let userId: string;
  let chatId: string;
  let runId: string;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { clerkUserId: `test_tools_bugs_${randomUUID()}`, creditBalance: 1_000_000n },
    });
    userId = user.id;

    const chat = await db.chat.create({
      data: { userId },
    });
    chatId = chat.id;

    const message = await db.message.create({
      data: { chatId, role: "user", status: "complete", content: [] },
    });

    const run = await db.agentRun.create({
      data: { chatId, userId, userMessageId: message.id, status: "running", idempotencyKey: `run_${randomUUID()}` },
    });
    runId = run.id;
  });

  afterAll(async () => {
    if (userId) await db.creditLedger.deleteMany({ where: { userId } });
    if (runId) await db.toolInvocation.deleteMany({ where: { runId } });
    if (runId) await db.runSkill.deleteMany({ where: { runId } });
    if (runId) await db.agentRun.deleteMany({ where: { id: runId } });
    if (chatId) await db.message.deleteMany({ where: { chatId } });
    if (chatId) await db.chat.deleteMany({ where: { id: chatId } });
    if (userId) await db.user.deleteMany({ where: { id: userId } });
  });

  it("bad JSON from the model yields TOOL_INPUT_INVALID and is never run with {}", async () => {
    const res = await executeTurnTools({
      runId,
      userId,
      traceId: "test-trace-bad-json",
      signal: new AbortController().signal,
      toolCalls: [{ id: "call_bad_json", name: "load_skill", arguments: '{"name": "broken' }],
      toolsMetadata: [],
      assetsMetadata: [],
      onMetadataChange: () => {},
    });

    expect(res.toolMessages).toHaveLength(1);
    expect(JSON.parse(res.toolMessages[0]!.content as string)).toEqual({ error: "arguments are not valid JSON" });

    const resultBlock = res.contentBlocks.find((b) => b.type === "tool_result");
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      toolUseId: "call_bad_json",
      error: { code: "TOOL_INPUT_INVALID", message: "arguments are not valid JSON", retryable: false },
    });

    const inv = await db.toolInvocation.findFirst({ where: { runId, toolCallId: "call_bad_json" } });
    expect(inv?.status).toBe("failed");
    expect(inv?.input).toEqual({});
  });

  it("creditUsed is not merged into the saved output", async () => {
    const res = await executeTurnTools({
      runId,
      userId,
      traceId: "test-trace-output-shape",
      signal: new AbortController().signal,
      toolCalls: [{ id: "call_good_skill", name: "load_skill", arguments: JSON.stringify({ name: "product-photo" }) }],
      toolsMetadata: [],
      assetsMetadata: [],
      onMetadataChange: () => {},
    });

    expect(res.contentBlocks.some((b) => b.type === "tool_result" && !b.error)).toBe(true);

    const inv = await db.toolInvocation.findFirst({ where: { runId, toolCallId: "call_good_skill" } });
    expect(inv?.status).toBe("succeeded");
    expect(inv?.output).toBeDefined();
    expect(typeof inv?.output).toBe("object");
    expect("creditUsed" in (inv?.output as Record<string, unknown>)).toBe(false);
    expect(inv?.credits).toBe(0n);
  });

  it("if Magica returns no creditUsed, settles 0 and logs warning with runId", async () => {
    vi.spyOn(magicaRun, "batchTriggerAndWait").mockResolvedValueOnce({
      runs: [
        {
          id: "child-run-no-credit",
          ok: true,
          output: { ok: true, output: { image_url: "https://example.com/cropped.png" }, creditUsed: undefined },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>);

    const warnSpy = vi.spyOn(logger, "warn");

    const res = await executeTurnTools({
      runId,
      userId,
      traceId: "test-trace-magica-no-credit",
      signal: new AbortController().signal,
      toolCalls: [
        {
          id: "call_magica_no_credit",
          name: "crop_image",
          arguments: JSON.stringify({
            image_url: "https://example.com/input.png",
            x_percent: 0,
            y_percent: 0,
            width_percent: 100,
            height_percent: 100,
          }),
        },
      ],
      toolsMetadata: [],
      assetsMetadata: [],
      onMetadataChange: () => {},
    });

    expect(res.contentBlocks.some((b) => b.type === "tool_result" && !b.error)).toBe(true);

    const inv = await db.toolInvocation.findFirst({ where: { runId, toolCallId: "call_magica_no_credit" } });
    expect(inv?.status).toBe("succeeded");
    expect(inv?.credits).toBe(0n);
    expect(warnSpy).toHaveBeenCalledWith("magica run returned no creditUsed", expect.objectContaining({ runId }));
  });
});

describe("GET /v1/tools", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { clerkUserId: `test_tools_route_${randomUUID()}`, creditBalance: 1_000_000n },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } });
  });

  it("returns the 3 Magica tools with the right shape; internal tools are excluded", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_a",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:4000/v1/tools");
    const res = await getToolsRoute(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const tools = (await res.json()) as ListToolsResponse;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(3);

    const registryTools = getUserFacingTools();
    expect(registryTools).toEqual(tools);

    const names = tools.map((t) => t.name);
    expect(names).toContain("gpt_image_2");
    expect(names).toContain("crop_image");
    expect(names).toContain("merge_videos");

    expect(names).not.toContain("load_skill");
    expect(names).not.toContain("read_skill_asset");
    expect(names).not.toContain("get_model_info");

    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.displayName).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(["image", "video", "util"]).toContain(tool.category);
      expect(typeof tool.estimatedCredits).toBe("number");
      expect(tool.estimatedCredits).toBeGreaterThan(0);
    }

    const gptTool = tools.find((t) => t.name === "gpt_image_2");
    expect(gptTool).toMatchObject({
      name: "gpt_image_2",
      displayName: "GPT Image 2",
      category: "image",
      estimatedCredits: 52_680,
    });

    const cropTool = tools.find((t) => t.name === "crop_image");
    expect(cropTool).toMatchObject({
      name: "crop_image",
      displayName: "Crop Image",
      category: "image",
      estimatedCredits: 5_000,
    });

    const mergeTool = tools.find((t) => t.name === "merge_videos");
    expect(mergeTool).toMatchObject({
      name: "merge_videos",
      displayName: "Merge Videos",
      category: "video",
      estimatedCredits: 50_000,
    });
  });
});
