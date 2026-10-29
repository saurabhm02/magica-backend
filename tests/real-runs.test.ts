import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { metadata } from "@trigger.dev/sdk";
import { db } from "@/lib/db";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";
import { runAgentTurn, textStream } from "@/trigger/agent-turn";
import { executeMagicaRun, magicaRun } from "@/trigger/magica-run";

let userId: string;
const startMs = Date.now();
function logEvent(name: string, data?: unknown) {
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(`[+${elapsedSec}s] ${name}`, data !== undefined ? JSON.stringify(data) : "");
}

beforeAll(async () => {
  vi.spyOn(metadata, "replace").mockImplementation((meta) => {
    logEvent("METADATA_REPLACE", meta);
  });
  vi.spyOn(textStream, "append").mockImplementation(async (text) => {
    logEvent(`STREAM_TEXT (${text.length} chars)`, text.slice(0, 60));
  });
  vi.spyOn(magicaRun, "batchTriggerAndWait").mockImplementation(async (items) => {
    const itemList = items as Array<{ payload: Parameters<typeof executeMagicaRun>[0] }>;
    const runs = await Promise.all(
      itemList.map(async (item) => {
        logEvent(`STARTING MAGICA RUN: ${item.payload.nodeType}`, item.payload.params);
        const res = await executeMagicaRun(item.payload, {
          signal: new AbortController().signal,
        });
        logEvent(`FINISHED MAGICA RUN: ${item.payload.nodeType}`, { creditUsed: res.creditUsed, output: res.output });
        return { id: item.payload.toolInvocationId, ok: true, output: { ok: true, output: res.output, creditUsed: res.creditUsed } };
      }),
    );
    return { runs } as unknown as Awaited<ReturnType<typeof magicaRun.batchTriggerAndWait>>;
  });

  const user = await db.user.create({ data: { clerkUserId: `real_${randomUUID()}` } });
  userId = user.id;
});

afterAll(async () => {
  await db.toolInvocation.deleteMany({ where: { run: { userId } } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe.skipIf(!process.env.RUN_REAL_MAGICA_TESTS)(
  "Real Magica API runs through agent loop",
  () => {
  it("runs crop_image through the agent loop against live Magica API", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content:
        "Please use the crop_image tool to crop this image: image_url: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png', x_percent: 10, y_percent: 10, width_percent: 80, height_percent: 80.",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    await runAgentTurn(sent.run.id, "real_crop_trace");

    const inv = await db.toolInvocation.findFirst({ where: { runId: sent.run.id } });
    console.log("REAL CROP STATUS:", inv?.status);
    console.log("REAL CROP OUTPUT:", JSON.stringify(inv?.output));

    expect(inv?.status).toBe("succeeded");
    expect(inv?.output).toBeDefined();
    const out = inv?.output as { image_url: string };
    expect(typeof out.image_url).toBe("string");
    expect(out.image_url).toMatch(/^https?:\/\//);
  }, 60_000);

  it("runs gpt_image_2 through the agent loop against live Magica API", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content:
        "Please generate an image using gpt_image_2 with prompt 'a red wooden cube on a clean white surface', quality 'Low', size '1024x1024', n 1.",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    await runAgentTurn(sent.run.id, "real_gpt_trace");

    const inv = await db.toolInvocation.findFirst({ where: { runId: sent.run.id } });
    console.log("REAL GPT STATUS:", inv?.status);
    console.log("REAL GPT OUTPUT:", JSON.stringify(inv?.output));

    expect(inv?.status).toBe("succeeded");
    expect(inv?.output).toBeDefined();
    const out = inv?.output as { images?: string[]; result?: string[] };
    const urls = out.images ?? out.result ?? [];
    expect(Array.isArray(urls)).toBe(true);
    expect(urls[0]).toMatch(/^https?:\/\//);
  }, 120_000);

  it("runs merge_videos through the agent loop against live Magica API", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content:
        "Please merge these two videos using merge_videos: video_urls: ['https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'], transition: 'none'.",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    await runAgentTurn(sent.run.id, "real_merge_trace");

    const inv = await db.toolInvocation.findFirst({ where: { runId: sent.run.id } });
    console.log("REAL MERGE STATUS:", inv?.status);
    console.log("REAL MERGE OUTPUT:", JSON.stringify(inv?.output));

    expect(inv?.status).toBe("succeeded");
    expect(inv?.output).toBeDefined();
    const out = inv?.output as { video_url: string };
    expect(typeof out.video_url).toBe("string");
    expect(out.video_url).toMatch(/^https?:\/\//);
  }, 120_000);

  it("runs chained generation then crop through the agent loop", async () => {
    const chat = await createChat(userId);
    logEvent("CREATED CHAT FOR APPLE RUN", { chatId: chat.id });

    let sendMs = 0;
    let firstStepCardMs = 0;
    let firstImageMs = 0;

    vi.spyOn(metadata, "replace").mockImplementation((meta) => {
      logEvent("METADATA_REPLACE", meta);
      const m = meta as { tools?: unknown[]; assets?: unknown[] };
      if (m.tools && m.tools.length > 0 && !firstStepCardMs) {
        firstStepCardMs = Date.now();
      }
      if (m.assets && m.assets.length > 0 && !firstImageMs) {
        firstImageMs = Date.now();
      }
    });

    sendMs = Date.now();
    const sent = await sendMessage(userId, chat.id, {
      content: "generate an image of a red apple, then crop it to a square",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    logEvent("SENT MESSAGE, STARTING AGENT TURN", { runId: sent.run.id });

    await runAgentTurn(sent.run.id, "real_chain_trace");
    logEvent("AGENT TURN FINISHED", { runId: sent.run.id });

    const invs = await db.toolInvocation.findMany({
      where: { runId: sent.run.id },
      orderBy: { order: "asc" },
    });
    console.log("REAL CHAINED INVOCATIONS:", JSON.stringify(invs.map((i) => ({ order: i.order, tool: i.toolName, status: i.status, output: i.output }))));

    const finalRun = await db.agentRun.findUniqueOrThrow({
      where: { id: sent.run.id },
      include: { assistantMessage: true },
    });
    console.log("FINAL ASSISTANT MESSAGE CONTENT:", finalRun.assistantMessage?.content);

    const secondsToFirstStepCard = ((firstStepCardMs - sendMs) / 1000).toFixed(1);
    const secondsToFirstImage = ((firstImageMs - sendMs) / 1000).toFixed(1);
    const failedToolCallsCount = invs.filter((i) => i.status === "failed").length;
    const footerTime = finalRun.assistantMessage?.createdAt
      ? new Date(finalRun.assistantMessage.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false })
      : "";

    console.log("=== REAL RUN MEASUREMENTS ===");
    console.log(`Real clock time shown in footer: ${footerTime}`);
    console.log(`Seconds from send to the first step card: ${secondsToFirstStepCard}s`);
    console.log(`Seconds to the first image: ${secondsToFirstImage}s`);
    console.log(`How many tool calls failed: ${failedToolCallsCount}`);
    console.log("================================");

    expect(invs.length).toBeGreaterThanOrEqual(2);
    expect(invs.some((i) => i.toolName === "gpt_image_2" && i.status === "succeeded")).toBe(true);
    expect(invs.some((i) => i.toolName === "crop_image" && i.status === "succeeded")).toBe(true);
    expect(finalRun.status).toBe("succeeded");
  }, 240_000);
});
