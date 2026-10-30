import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { metadata } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import { executeTurnTools } from "@/agent/run-tools";
import { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import { SAFE_ERROR_MESSAGES, VISION_MODELS } from "@/lib/constants";
import { db } from "@/lib/db";
import type { LlmEvent, LlmMessage, ToolCall } from "@/lib/types";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";
import { reasoningStream, runAgentTurn, textStream } from "@/trigger/agent-turn";
import { executeMagicaRun, magicaRun } from "@/trigger/magica-run";

const baseUrl = process.env.MAGICA_BASE_URL?.replace(/\/$/, "") || "https://inference.magica.com";

const mswServer = setupServer();

beforeAll(() => mswServer.listen());
afterEach(() => {
  mswServer.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => mswServer.close());

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { clerkUserId: `test_loop_${randomUUID()}` } });
  userId = user.id;
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId } });
  await db.runSkill.deleteMany({ where: { run: { userId } } });
  await db.toolInvocation.deleteMany({ where: { run: { userId } } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.attachment.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function readAll(body: ReadableStream<string>) {
  let text = "";
  for await (const part of body) text += part;
  return text;
}

describe("Agent turn loop with chained tools", () => {
  it("plain text reply -> metadata goes thinking -> working -> complete", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Hello there",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    async function* textStreamGen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Hello" };
      yield { type: "text-delta", text: " world!" };
      yield { type: "done", model: "test-model" };
    }

    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => textStreamGen());

    const metadataStates: string[] = [];
    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      if (data && typeof data === "object" && "status" in data && typeof data.status === "string") {
        metadataStates.push(data.status);
      }
    });

    await runAgentTurn(runId, "test-plain-text-trace");

    expect(metadataStates).toEqual(["thinking", "working", "complete"]);
  });

  it("thinking before a tool call becomes a titled reasoning step, saved before the tool_use", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, { content: "Make a sunset", clientRequestId: randomUUID(), planMode: false });

    mswServer.use(
      http.post(`${baseUrl}/v1/nodes/gpt_image_2/run`, () => HttpResponse.json({ runId: "gpt-run-r" }, { status: 202 })),
      http.get(`${baseUrl}/v1/nodes/runs/gpt-run-r`, () =>
        HttpResponse.json({ id: "gpt-run-r", status: "COMPLETED", output: { images: ["https://example.com/r.png"] } }),
      ),
    );

    async function* toolTurn(): AsyncGenerator<LlmEvent> {
      yield { type: "reasoning-delta", text: "The user wants a sunset, so I will make an image." };
      yield { type: "tool-call-delta", index: 0, id: "call_r", name: "gpt_image_2", arguments: JSON.stringify({ prompt: "sunset" }) };
      yield { type: "done", model: "test-model" };
    }
    async function* textTurn(): AsyncGenerator<LlmEvent> {
      yield { type: "reasoning-delta", text: "Now answer." };
      yield { type: "text-delta", text: "Here it is." };
      yield { type: "done", model: "test-model" };
    }
    let turn = 0;
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => (turn++ === 0 ? toolTurn() : textTurn()));
    vi.spyOn(llmModule, "summarizeReasoning").mockResolvedValue("Decided to make the image");
    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValue(undefined);
    let lastMeta: RunMetadata | undefined;
    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      lastMeta = data as RunMetadata;
    });
    let titledTools: RunMetadata["tools"];
    vi.spyOn(metadata, "set").mockImplementation((key, value) => {
      if (key === "tools") titledTools = JSON.parse(JSON.stringify(value));
      return metadata;
    });
    vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async (items) => {
      const itemList = items as Array<{ payload: Parameters<typeof executeMagicaRun>[0] }>;
      const runs = await Promise.all(
        itemList.map(async (item) => {
          const res = await executeMagicaRun(item.payload, { signal: new AbortController().signal, sleep: async () => {} });
          return { id: item.payload.toolInvocationId, ok: true, output: { ok: true, output: res.output, creditUsed: res.creditUsed } };
        }),
      );
      return { runs } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
    });

    await runAgentTurn(sent.run.id, "test-reasoning-step");

    // Only the thinking that led to a tool call becomes a step. Its title arrives through
    // a tools-only update, so a showing question card is never wiped.
    expect(titledTools?.[0]).toMatchObject({ renderKey: "reasoning", label: "Decided to make the image" });
    expect(lastMeta?.tools?.map((t) => [t.renderKey, t.label])).toEqual([
      ["reasoning", "Decided to make the image"],
      ["image-result", expect.any(String)],
    ]);
    const reply = await db.message.findFirstOrThrow({ where: { chatId: chat.id, role: "assistant" } });
    const types = (reply.content as ContentBlock[]).map((b) => b.type);
    expect(types).toEqual(["reasoning", "tool_use", "tool_result", "reasoning", "text"]);
    expect((reply.content as ContentBlock[])[0]).toMatchObject({ type: "reasoning", title: "Decided to make the image" });
  });

  it("streams the reply and the thinking through one open stream each, not a request per token", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, { content: "Hello", clientRequestId: randomUUID(), planMode: false });

    async function* reply(): AsyncGenerator<LlmEvent> {
      yield { type: "reasoning-delta", text: "The user " };
      yield { type: "reasoning-delta", text: "says hello." };
      yield { type: "text-delta", text: "Hello" };
      yield { type: "text-delta", text: " world!" };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => reply());
    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValue(undefined);
    vi.spyOn(metadata, "replace").mockReturnValue(undefined as unknown as void);

    // Read what each stream's single pipe receives.
    const received: Record<string, Promise<string>> = {};
    const capture = (stream: typeof textStream) =>
      vi.spyOn(stream, "pipe").mockImplementation((body) => {
        received[stream.id] = readAll(body as ReadableStream<string>);
        return { stream: body, waitUntilComplete: () => received[stream.id]! } as unknown as ReturnType<typeof stream.pipe>;
      });
    const textPipe = capture(textStream);
    const reasoningPipe = capture(reasoningStream);

    await runAgentTurn(sent.run.id, "test-live-streams");

    expect(textPipe).toHaveBeenCalledTimes(1);
    expect(reasoningPipe).toHaveBeenCalledTimes(1);
    expect(await received[textStream.id]).toBe("Hello world!");
    expect(await received[reasoningStream.id]).toBe("The user says hello.");
  });

  it("an image turn uses the free vision models, and says sorry when they all fail", async () => {
    const chat = await createChat(userId);
    mswServer.use(http.get("https://example.com/photo.png", () => new HttpResponse(new Uint8Array([1, 2, 3]))));
    const image = await db.attachment.create({
      data: { userId, name: "photo.png", sizeBytes: 3n, mimeType: "image/png", kind: "image", source: "upload", status: "ready", url: "https://example.com/photo.png" },
    });
    const sent = await sendMessage(userId, chat.id, { content: "describe this", clientRequestId: randomUUID(), planMode: false, attachmentIds: [image.id] });

    async function* allModelsBusy(): AsyncGenerator<LlmEvent> {
      yield { type: "error", code: "LLM_RATE_LIMITED", message: "busy", retryable: true };
    }
    const llm = vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => allModelsBusy());
    vi.spyOn(metadata, "replace").mockReturnValue(undefined as unknown as void);

    await runAgentTurn(sent.run.id, "test-vision");

    expect(llm.mock.calls[0]![0]).toEqual(VISION_MODELS);
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: sent.run.id } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "VISION_UNAVAILABLE", message: SAFE_ERROR_MESSAGES.VISION_UNAVAILABLE });
  });

  it("chains gpt_image_2 -> crop_image -> text answer with correct message formats and block ordering", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Make a sunset and crop it",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    mswServer.use(
      http.post(`${baseUrl}/v1/nodes/gpt_image_2/run`, () => {
        return HttpResponse.json({ runId: "gpt-run-1" }, { status: 202 });
      }),
      http.get(`${baseUrl}/v1/nodes/runs/gpt-run-1`, () => {
        return HttpResponse.json({
          id: "gpt-run-1",
          status: "COMPLETED",
          output: { images: ["https://example.com/sunset.png"] },
        });
      }),
      http.post(`${baseUrl}/v1/nodes/crop_image/run`, () => {
        return HttpResponse.json({ runId: "crop-run-2" }, { status: 202 });
      }),
      http.get(`${baseUrl}/v1/nodes/runs/crop-run-2`, () => {
        return HttpResponse.json({
          id: "crop-run-2",
          status: "COMPLETED",
          output: { image_url: "https://example.com/sunset_cropped.png" },
        });
      }),
    );

    const capturedPromptHistory: LlmMessage[][] = [];

    async function* turn1Stream(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_gpt_1",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "sunset photo" }),
      };
      yield { type: "done", model: "test-model" };
    }

    async function* turn2Stream(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_crop_2",
        name: "crop_image",
        arguments: JSON.stringify({
          image_url: "https://example.com/sunset.png",
          crop: { x: 0, y: 0, width: 500, height: 500 },
        }),
      };
      yield { type: "done", model: "test-model" };
    }

    async function* turn3Stream(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Here is your cropped sunset!" };
      yield { type: "done", model: "test-model" };
    }

    let turnCount = 0;
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation((_models: string[], messages: LlmMessage[]) => {
      capturedPromptHistory.push(JSON.parse(JSON.stringify(messages)));
      turnCount++;
      if (turnCount === 1) return turn1Stream();
      if (turnCount === 2) return turn2Stream();
      return turn3Stream();
    });

    vi.spyOn(metadata, "replace").mockReturnValue(undefined as unknown as void);
    vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async (items) => {
      const itemList = items as Array<{ payload: Parameters<typeof executeMagicaRun>[0] }>;
      const runs = await Promise.all(
        itemList.map(async (item) => {
          const res = await executeMagicaRun(item.payload, {
            signal: new AbortController().signal,
            sleep: async () => {},
          });
          return { id: item.payload.toolInvocationId, ok: true, output: { ok: true, output: res.output, creditUsed: res.creditUsed } };
        }),
      );
      return { runs } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
    });

    await runAgentTurn(runId, "test-trace-loop");

    expect(capturedPromptHistory.length).toBe(3);

    // Turn 2 check: assistant has tool_calls in OpenAI shape, and tool message follows
    const turn2Messages = capturedPromptHistory[1];
    expect(turn2Messages).toBeDefined();
    const t2Assistant = turn2Messages?.find(
      (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    ) as { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    expect(t2Assistant).toBeDefined();
    expect(t2Assistant.tool_calls).toEqual([
      {
        id: "call_gpt_1",
        type: "function",
        function: {
          name: "gpt_image_2",
          arguments: JSON.stringify({ prompt: "sunset photo" }),
        },
      },
    ]);

    const t2ToolMsg = turn2Messages?.find((m) => m.role === "tool") as {
      role: string;
      tool_call_id: string;
      content: string;
    };
    expect(t2ToolMsg).toBeDefined();
    expect(t2ToolMsg.tool_call_id).toBe("call_gpt_1");
    expect(JSON.parse(t2ToolMsg.content)).toEqual({
      images: ["https://example.com/sunset.png"],
    });

    // Turn 3 check: includes second tool call and result
    const turn3Messages = capturedPromptHistory[2];
    expect(turn3Messages).toBeDefined();
    const t3CropAssistant = turn3Messages?.filter((m) => m.role === "assistant")[1] as {
      role: string;
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(t3CropAssistant).toBeDefined();
    expect(t3CropAssistant.tool_calls).toEqual([
      {
        id: "call_crop_2",
        type: "function",
        function: {
          name: "crop_image",
          arguments: JSON.stringify({
            image_url: "https://example.com/sunset.png",
            crop: { x: 0, y: 0, width: 500, height: 500 },
          }),
        },
      },
    ]);

    const t3ToolMsg = turn3Messages?.filter((m) => m.role === "tool")[1] as {
      role: string;
      tool_call_id: string;
      content: string;
    };
    expect(t3ToolMsg).toBeDefined();
    expect(t3ToolMsg.tool_call_id).toBe("call_crop_2");
    expect(JSON.parse(t3ToolMsg.content)).toEqual({
      image_url: "https://example.com/sunset_cropped.png",
    });

    // Check saved assistant message content blocks in DB
    const finalRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(finalRun.status).toBe("succeeded");
    expect(finalRun.assistantMessageId).toBeTruthy();

    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    expect(assistantMsg.status).toBe("complete");

    const blocks = assistantMsg.content as Array<{ type: string; [k: string]: unknown }>;
    expect(blocks.length).toBe(5);
    expect(blocks[0]?.type).toBe("tool_use");
    expect(blocks[0]?.name).toBe("gpt_image_2");
    expect(blocks[1]?.type).toBe("tool_result");
    expect(blocks[1]?.output).toEqual({ images: ["https://example.com/sunset.png"] });

    expect(blocks[2]?.type).toBe("tool_use");
    expect(blocks[2]?.name).toBe("crop_image");
    expect(blocks[3]?.type).toBe("tool_result");
    expect(blocks[3]?.output).toEqual({ image_url: "https://example.com/sunset_cropped.png" });

    expect(blocks[4]?.type).toBe("text");
    expect(blocks[4]?.text).toBe("Here is your cropped sunset!");
  }, 90_000);

  it("model sends no tool call ids: computes one id and uses it across assistant tool_calls, ToolInvocation row, tool message and content blocks across 2 steps", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Make an apple and crop it without tool ids",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    mswServer.use(
      http.post(`${baseUrl}/v1/nodes/gpt_image_2/run`, () => {
        return HttpResponse.json({ runId: "gpt-noid-1" }, { status: 202 });
      }),
      http.get(`${baseUrl}/v1/nodes/runs/gpt-noid-1`, () => {
        return HttpResponse.json({
          id: "gpt-noid-1",
          status: "COMPLETED",
          output: { result: ["https://example.com/apple.png"] },
        });
      }),
      http.post(`${baseUrl}/v1/nodes/crop_image/run`, () => {
        return HttpResponse.json({ runId: "crop-noid-2" }, { status: 202 });
      }),
      http.get(`${baseUrl}/v1/nodes/runs/crop-noid-2`, () => {
        return HttpResponse.json({
          id: "crop-noid-2",
          status: "COMPLETED",
          output: { image_url: "https://example.com/apple_cropped.png" },
        });
      }),
    );

    const capturedPromptHistory: LlmMessage[][] = [];

    // Model sends empty string id in both turns
    async function* turn1Stream(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "apple" }),
      };
      yield { type: "done", model: "test-model" };
    }

    async function* turn2Stream(): AsyncGenerator<LlmEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "",
        name: "crop_image",
        arguments: JSON.stringify({
          image_url: "https://example.com/apple.png",
          crop: { x: 0, y: 0, width: 200, height: 200 },
        }),
      };
      yield { type: "done", model: "test-model" };
    }

    async function* turn3Stream(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Finished cropping apple!" };
      yield { type: "done", model: "test-model" };
    }

    let turnCount = 0;
    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation((_models: string[], messages: LlmMessage[]) => {
      capturedPromptHistory.push(JSON.parse(JSON.stringify(messages)));
      turnCount++;
      if (turnCount === 1) return turn1Stream();
      if (turnCount === 2) return turn2Stream();
      return turn3Stream();
    });

    vi.spyOn(metadata, "replace").mockReturnValue(undefined as unknown as void);
    vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async (items) => {
      const itemList = items as Array<{ payload: Parameters<typeof executeMagicaRun>[0] }>;
      const runs = await Promise.all(
        itemList.map(async (item) => {
          const res = await executeMagicaRun(item.payload, {
            signal: new AbortController().signal,
            sleep: async () => {},
          });
          return { id: item.payload.toolInvocationId, ok: true, output: { ok: true, output: res.output, creditUsed: res.creditUsed } };
        }),
      );
      return { runs } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
    });

    await runAgentTurn(runId, "test-noid-trace");

    // Check Turn 1 tool call ID (expected: call_0)
    const turn2Messages = capturedPromptHistory[1];
    const t1Assistant = turn2Messages?.find(
      (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    ) as { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    expect(t1Assistant.tool_calls[0]?.id).toBe("call_0");

    const t1ToolMsg = turn2Messages?.find((m) => m.role === "tool") as {
      role: string;
      tool_call_id: string;
    };
    expect(t1ToolMsg.tool_call_id).toBe("call_0");

    // Check Turn 2 tool call ID (expected: call_1)
    const turn3Messages = capturedPromptHistory[2];
    const t2Assistant = turn3Messages?.filter(
      (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    )[1] as { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    expect(t2Assistant.tool_calls[0]?.id).toBe("call_1");

    const t2ToolMsg = turn3Messages?.filter((m) => m.role === "tool")[1] as {
      role: string;
      tool_call_id: string;
    };
    expect(t2ToolMsg.tool_call_id).toBe("call_1");

    // Check DB ToolInvocation rows have exact same IDs
    const invocations = await db.toolInvocation.findMany({
      where: { runId },
      orderBy: { order: "asc" },
    });
    expect(invocations.length).toBe(2);
    expect(invocations[0]?.toolCallId).toBe("call_0");
    expect(invocations[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(invocations[1]?.toolCallId).toBe("call_1");
    expect(invocations[1]?.durationMs).toBeGreaterThanOrEqual(0);

    // Check DB Message content blocks have exact same IDs
    const finalRun = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    const assistantMsg = await db.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMsg.content as Array<{ type: string; [k: string]: unknown }>;
    expect(blocks[0]?.type).toBe("tool_use");
    expect(blocks[0]?.id).toBe("call_0");
    expect(blocks[1]?.type).toBe("tool_result");
    expect(blocks[1]?.toolUseId).toBe("call_0");

    expect(blocks[2]?.type).toBe("tool_use");
    expect(blocks[2]?.id).toBe("call_1");
    expect(blocks[3]?.type).toBe("tool_result");
    expect(blocks[3]?.toolUseId).toBe("call_1");
  }, 90_000);

  it("text + tool call + insufficient credits has text once, not duplicated", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "Generate an image please",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    // Set user balance to 0 so tool call fails with insufficient credits
    await db.user.update({ where: { id: userId }, data: { creditBalance: 0n } });

    async function* mockStream(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Generating your requested artwork now." };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_abc",
        name: "gpt_image_2",
        arguments: JSON.stringify({ prompt: "A cozy cabin" }),
      };
      yield { type: "usage", promptTokens: 10, completionTokens: 10, totalTokens: 20 };
      yield { type: "done", model: "openrouter/free" };
    }

    vi.spyOn(llmModule, "streamChatWithFallback").mockImplementation(() => mockStream());
    vi.spyOn(metadata, "replace").mockImplementation(() => {});

    await runAgentTurn(runId, "trace_no_dupe");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect((run.error as unknown as SafeError).code).toBe("INSUFFICIENT_CREDITS");

    const reply = await db.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
    const content = reply.content as unknown as ContentBlock[];
    const textBlocks = content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");

    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0]?.text).toBe("Generating your requested artwork now.");

    // Restore user balance
    await db.user.update({ where: { id: userId }, data: { creditBalance: 1_000_000n } });
  });

  it("a saved message has renderKey and assets matching the live metadata", async () => {
    const chat = await createChat(userId, "Display Data Chat");
    const sent = await sendMessage(userId, chat.id, {
      content: "Generate an image",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    const toolCalls: ToolCall[] = [
      {
        id: "call_test_crop",
        name: "crop_image",
        arguments: JSON.stringify({
          image_url: "https://example.com/source.png",
          width_px: 500,
          height_px: 500,
        }),
      },
    ];

    type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
    type AssetMeta = NonNullable<RunMetadata["assets"]>[number];

    const toolsMetadata: ToolMeta[] = [];
    const assetsMetadata: AssetMeta[] = [];

    vi.spyOn(magicaRun, "batchTriggerAndWait").mockResolvedValueOnce({
      runs: [
        {
          id: "m_run_1",
          ok: true,
          output: {
            ok: true,
            output: { image_url: "https://example.com/cropped_asset.png" },
            creditUsed: 5_000,
          },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>);

    const exec = await executeTurnTools({
      runId,
      userId,
      traceId: "test_trace_1",
      signal: new AbortController().signal,
      toolCalls,
      toolsMetadata,
      assetsMetadata,
      onMetadataChange: () => {},
    });

    const toolUse = exec.contentBlocks.find((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const toolResult = exec.contentBlocks.find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");

    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();

    expect(toolUse?.renderKey).toBe("image-result");
    expect(toolUse?.renderKey).toBe(toolsMetadata[0]?.renderKey);

    expect(toolResult?.assets).toEqual([{ type: "image", url: "https://example.com/cropped_asset.png" }]);
    expect(assetsMetadata[0]?.url).toBe("https://example.com/cropped_asset.png");

    const savedMsg = await db.message.create({
      data: {
        chatId: chat.id,
        role: "assistant",
        status: "complete",
        content: exec.contentBlocks as unknown as object[],
      },
    });

    const loadedMsg = await db.message.findUniqueOrThrow({ where: { id: savedMsg.id } });
    const loadedBlocks = (loadedMsg.content as unknown[]) ?? [];
    const parsedBlocks = loadedBlocks.map((b) => ContentBlock.parse(b));
    const loadedUse = parsedBlocks.find((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const loadedResult = parsedBlocks.find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");

    expect(loadedUse?.renderKey).toBe("image-result");
    expect(loadedResult?.assets).toEqual([{ type: "image", url: "https://example.com/cropped_asset.png" }]);
  });
});
