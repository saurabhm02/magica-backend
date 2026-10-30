import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import { clearEstimateCache, estimateNodeCredits, runNode } from "@/agent/magica";
import { executeTurnTools } from "@/agent/run-tools";
import { buildCropImageParams, cropImageTool } from "@/agent/tools/crop-image";
import { gptImage2Tool } from "@/agent/tools/gpt-image-2";
import { mergeVideosTool } from "@/agent/tools/merge-videos";
import { getUserFacingTools } from "@/agent/tools/registry";
import { GET as getToolRunRoute } from "@/app/api/v1/tool-runs/[id]/route";
import { GET as getToolDetailRoute } from "@/app/api/v1/tools/[name]/route";
import { GET as getToolRunsRoute, POST as postToolRunRoute } from "@/app/api/v1/tools/[name]/runs/route";
import { GET as getToolsRoute } from "@/app/api/v1/tools/route";
import type { ListToolsResponse } from "@/contracts/api";
import type { SafeError } from "@/contracts/errors";
import { CropImageInput, GptImage2Input, MergeVideosInput } from "@/contracts/tools";
import { auth } from "@trigger.dev/sdk";
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

  it("CropImageInput JSON schema shows schema-only defaults on percentage fields without polluting parse", () => {
    const jsonSchema = z.toJSONSchema(CropImageInput) as {
      properties?: Record<string, { default?: unknown }>;
    };
    expect(jsonSchema.properties?.x_percent?.default).toBe(0);
    expect(jsonSchema.properties?.y_percent?.default).toBe(0);
    expect(jsonSchema.properties?.width_percent?.default).toBe(100);
    expect(jsonSchema.properties?.height_percent?.default).toBe(100);

    // Parsing without percentage fields must NOT fill in defaults (would collide with pixel crop mode)
    const parsed = CropImageInput.parse({
      image_url: "https://example.com/pic.jpg",
      width_px: 200,
      height_px: 200,
    });
    expect(parsed.x_percent).toBeUndefined();
    expect(parsed.y_percent).toBeUndefined();
    expect(parsed.width_percent).toBeUndefined();
    expect(parsed.height_percent).toBeUndefined();
  });

  it("input schemas include Magica-matching title metadata for form labels", () => {
    const cropSchema = z.toJSONSchema(CropImageInput) as {
      properties?: Record<string, { title?: string }>;
    };
    expect(cropSchema.properties?.image_url?.title).toBe("Input Image");
    expect(cropSchema.properties?.x_percent?.title).toBe("X Position (%)");
    expect(cropSchema.properties?.y_percent?.title).toBe("Y Position (%)");
    expect(cropSchema.properties?.width_percent?.title).toBe("Width (%)");
    expect(cropSchema.properties?.height_percent?.title).toBe("Height (%)");

    const gptSchema = z.toJSONSchema(GptImage2Input) as {
      properties?: Record<string, { title?: string }>;
    };
    expect(gptSchema.properties?.prompt?.title).toBe("Prompt");
    expect(gptSchema.properties?.size?.title).toBe("Size");
    expect(gptSchema.properties?.quality?.title).toBe("Quality");
    expect(gptSchema.properties?.n?.title).toBe("Number of Images");
    expect(gptSchema.properties?.background?.title).toBe("Background");
    expect(gptSchema.properties?.output_format?.title).toBe("Output Format");

    const mergeSchema = z.toJSONSchema(MergeVideosInput) as {
      properties?: Record<string, { title?: string }>;
    };
    expect(mergeSchema.properties?.video_urls?.title).toBe("Videos");
    expect(mergeSchema.properties?.transition?.title).toBe("Transition");
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
      userId: "user-1",
      triggerRunId: null,
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
      userId: "user-1",
      triggerRunId: null,
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
      userId: "user-1",
      triggerRunId: null,
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

    const registryTools = await getUserFacingTools();
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
      estimatedCredits: 68_484,
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
      estimatedCredits: 40_000,
    });
  });
});

describe("Live pricing with Magica estimate-credits", () => {
  beforeEach(() => {
    clearEstimateCache();
  });

  it("fetches live estimate from Magica and caches it for 1 hour", async () => {
    let callCount = 0;
    server.use(
      http.post(`${baseUrl}/v1/nodes/estimate-credits`, async ({ request }) => {
        callCount++;
        const body = (await request.json()) as { nodes: Array<{ type: string; data?: { quality?: string } }> };
        if (body.nodes[0]?.data?.quality === "High") {
          return HttpResponse.json({ estimates: [{ microcredits: 273_936 }] });
        }
        return HttpResponse.json({ estimates: [{ microcredits: 68_484 }] });
      }),
    );

    const highEstimate = await estimateNodeCredits({
      nodeType: "gpt_image_2",
      data: { quality: "High", size: "1024x1024" },
      fallback: 273_936,
    });
    expect(highEstimate).toBe(273_936);
    expect(callCount).toBe(1);

    // Second call with same parameters should return cached value without fetching
    const cachedEstimate = await estimateNodeCredits({
      nodeType: "gpt_image_2",
      data: { quality: "High", size: "1024x1024" },
      fallback: 999_999,
    });
    expect(cachedEstimate).toBe(273_936);
    expect(callCount).toBe(1);
  });

  it("falls back to constant and logs warning when Magica call fails", async () => {
    server.use(
      http.post(`${baseUrl}/v1/nodes/estimate-credits`, () => {
        return HttpResponse.json({ error: "Service unavailable" }, { status: 500 });
      }),
    );

    const warnSpy = vi.spyOn(logger, "warn");

    const fallbackEstimate = await estimateNodeCredits({
      nodeType: "crop_image",
      data: {},
      fallback: 5_000,
    });

    expect(fallbackEstimate).toBe(5_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("falling back to constant"),
      expect.objectContaining({ nodeType: "crop_image" }),
    );
  });
});

describe("GET /v1/tools/:name", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { clerkUserId: `test_tool_detail_${randomUUID()}`, creditBalance: 1_000_000n },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await db.user.delete({ where: { id: userId } });
  });

  it("returns tool details with inputs schema, pricing lines, and default estimate", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_detail",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:4000/v1/tools/gpt_image_2");
    const res = await getToolDetailRoute(req, { params: Promise.resolve({ name: "gpt_image_2" }) });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      name: string;
      displayName: string;
      description: string;
      category: string;
      inputs: { properties: Record<string, unknown> };
      pricingLines: string[];
      defaultEstimate: number;
    };
    expect(data).toMatchObject({
      name: "gpt_image_2",
      displayName: "GPT Image 2",
      description: expect.any(String),
      category: "image",
      inputs: expect.any(Object),
      pricingLines: expect.arrayContaining(["Quality High + Size 1024x1024: 0.273936M credits"]),
      defaultEstimate: expect.any(Number),
    });
    expect(data.inputs.properties).toHaveProperty("prompt");
  });

  it("returns 404 for hidden or unknown tools", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_detail",
      creditBalance: 1_000_000n,
      createdAt: new Date(),
    });

    const reqHidden = new NextRequest("http://localhost:4000/v1/tools/get_model_info");
    const resHidden = await getToolDetailRoute(reqHidden, { params: Promise.resolve({ name: "get_model_info" }) });
    expect(resHidden.status).toBe(404);

    const reqUnknown = new NextRequest("http://localhost:4000/v1/tools/unknown_tool");
    const resUnknown = await getToolDetailRoute(reqUnknown, { params: Promise.resolve({ name: "unknown_tool" }) });
    expect(resUnknown.status).toBe(404);
  });
});

describe("Direct tool runs (POST /v1/tools/:name/runs, GET /v1/tools/:name/runs, GET /v1/tool-runs/:id)", () => {
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    userA = await db.user.create({
      data: { clerkUserId: `test_runs_userA_${randomUUID()}`, creditBalance: 500_000n },
    });
    userB = await db.user.create({
      data: { clerkUserId: `test_runs_userB_${randomUUID()}`, creditBalance: 500_000n },
    });
  });

  afterAll(async () => {
    await db.creditLedger.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.toolInvocation.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("POST /v1/tools/:name/runs validates input, reserves credits, triggers magica-run, and returns { runId } fast", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userA.id,
      clerkUserId: "mock_a",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const triggerSpy = vi.spyOn(magicaRun, "trigger").mockResolvedValue({
      id: "trig_run_direct_123",
      publicAccessToken: "tok_123",
    } as unknown as Awaited<ReturnType<typeof magicaRun.trigger>>);

    const req = new NextRequest("http://localhost:4000/v1/tools/crop_image/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          image_url: "https://example.com/source.jpg",
          crop: { x: 0, y: 0, width: 200, height: 200 },
        },
      }),
    });

    const res = await postToolRunRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { runId: string; realtime: { runId: string; accessToken: string } };
    expect(json).toMatchObject({
      runId: expect.any(String),
      realtime: {
        runId: "trig_run_direct_123",
        accessToken: "tok_123",
      },
    });

    expect(triggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInvocationId: json.runId,
        nodeType: "crop_image",
      }),
    );

    const inv = await db.toolInvocation.findUnique({ where: { id: json.runId } });
    expect(inv).toBeDefined();
    expect(inv?.userId).toBe(userA.id);
    expect(inv?.runId).toBeNull();
    expect(inv?.triggerRunId).toBe("trig_run_direct_123");
    expect(inv?.status).toBe("pending");

    // Hold should be reserved
    const ledger = await db.creditLedger.findUnique({
      where: { idempotencyKey: `reserve:${json.runId}` },
    });
    expect(ledger).toBeDefined();
    expect(ledger?.amount).toBe(-7_500n); // 5000 * 1.5 multiplier
  });

  it("POST refunds credits and marks invocation failed if trigger throws", async () => {
    const beforeBal = (await db.user.findUniqueOrThrow({ where: { id: userA.id } })).creditBalance;

    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userA.id,
      clerkUserId: "mock_a",
      creditBalance: beforeBal,
      createdAt: new Date(),
    });

    vi.spyOn(magicaRun, "trigger").mockRejectedValue(new Error("Trigger service down"));

    const req = new NextRequest("http://localhost:4000/v1/tools/crop_image/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          image_url: "https://example.com/source.jpg",
          crop: { x: 0, y: 0, width: 200, height: 200 },
        },
      }),
    });

    const res = await postToolRunRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
    expect(res.status).toBe(500);

    const inv = await db.toolInvocation.findFirst({
      where: { userId: userA.id, status: "failed" },
      orderBy: { createdAt: "desc" },
    });
    expect(inv).toBeDefined();
    expect(inv?.status).toBe("failed");

    const refund = await db.creditLedger.findUnique({
      where: { idempotencyKey: `refund:${inv?.id}` },
    });
    expect(refund).toBeDefined();
    expect(refund?.amount).toBe(7_500n);

    const balance = await db.user.findUnique({ where: { id: userA.id } });
    expect(balance?.creditBalance).toBe(beforeBal);
  });

  it("POST rejects invalid input with 400", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userA.id,
      clerkUserId: "mock_a",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:4000/v1/tools/crop_image/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { image_url: "not-a-valid-url" },
      }),
    });

    const res = await postToolRunRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
    expect(res.status).toBe(400);
  });

  it("GET /v1/tools/:name/runs lists the user's history and isolates other users", async () => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userA.id,
      clerkUserId: "mock_a",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const reqA = new NextRequest("http://localhost:4000/v1/tools/crop_image/runs");
    const resA = await getToolRunsRoute(reqA, { params: Promise.resolve({ name: "crop_image" }) });
    expect(resA.status).toBe(200);

    const bodyA = (await resA.json()) as { items: Array<Record<string, unknown>> };
    expect(bodyA.items.length).toBeGreaterThanOrEqual(1);
    expect(bodyA.items[0]).toMatchObject({
      toolName: "crop_image",
    });

    // User B should not see User A's runs
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userB.id,
      clerkUserId: "mock_b",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const reqB = new NextRequest("http://localhost:4000/v1/tools/crop_image/runs");
    const resB = await getToolRunsRoute(reqB, { params: Promise.resolve({ name: "crop_image" }) });
    expect(resB.status).toBe(200);

    const bodyB = (await resB.json()) as { items: Array<Record<string, unknown>> };
    expect(bodyB.items.length).toBe(0);
  });

  it("GET /v1/tool-runs/:id returns run status, mints reload token, and enforces ownership", async () => {
    const inv = await db.toolInvocation.create({
      data: {
        userId: userA.id,
        runId: null,
        triggerRunId: "trig_reload_test_1",
        toolCallId: "direct_test_ownership",
        order: 0,
        toolName: "crop_image",
        status: "succeeded",
        input: { image_url: "https://example.com/pic.jpg" },
        output: { image_url: "https://example.com/cropped.jpg" },
        credits: 5_000n,
        durationMs: 1200,
        idempotencyKey: `idem_ownership_${randomUUID()}`,
      },
    });

    const tokenSpy = vi.spyOn(auth, "createPublicToken").mockResolvedValue("tok_reload_fresh");

    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userA.id,
      clerkUserId: "mock_a",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const reqOwner = new NextRequest(`http://localhost:4000/v1/tool-runs/${inv.id}`);
    const resOwner = await getToolRunRoute(reqOwner, { params: Promise.resolve({ id: inv.id }) });
    expect(resOwner.status).toBe(200);

    const data = await resOwner.json();
    expect(data).toMatchObject({
      id: inv.id,
      toolName: "crop_image",
      status: "succeeded",
      credits: 5_000,
      durationMs: 1200,
      triggerRunId: "trig_reload_test_1",
      accessToken: "tok_reload_fresh",
      realtime: {
        runId: "trig_reload_test_1",
        accessToken: "tok_reload_fresh",
      },
      assets: [{ type: "image", url: "https://example.com/cropped.jpg" }],
    });
    expect(tokenSpy).toHaveBeenCalledWith({
      scopes: { read: { runs: ["trig_reload_test_1"] } },
    });

    // Another user requesting the run gets 404
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userB.id,
      clerkUserId: "mock_b",
      creditBalance: 500_000n,
      createdAt: new Date(),
    });

    const reqOther = new NextRequest(`http://localhost:4000/v1/tool-runs/${inv.id}`);
    const resOther = await getToolRunRoute(reqOther, { params: Promise.resolve({ id: inv.id }) });
    expect(resOther.status).toBe(404);
  });
});
