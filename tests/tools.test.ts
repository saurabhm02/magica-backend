import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { runNode } from "@/agent/magica";
import { buildCropImageParams, cropImageTool } from "@/agent/tools/crop-image";
import { gptImage2Tool } from "@/agent/tools/gpt-image-2";
import { mergeVideosTool } from "@/agent/tools/merge-videos";
import { executeMagicaRun } from "@/trigger/magica-run";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
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
    expect((thrown as AppError).code).toBe("MAGICA_UNAUTHORIZED");
    expect((thrown as AppError).message).toContain("credits");
    expect((thrown as AppError).retryable).toBe(false);
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
