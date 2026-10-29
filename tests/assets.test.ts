import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getAssetsRoute } from "@/app/api/v1/assets/route";
import type { ListAssetsResponse } from "@/contracts/api";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import { createChat } from "@/modules/chats/chats";

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const userA = await db.user.create({
    data: { clerkUserId: `test_user_asset_a_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  const userB = await db.user.create({
    data: { clerkUserId: `test_user_asset_b_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  userId = userA.id;
  otherUserId = userB.id;
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

describe("GET /v1/assets", () => {
  it("returns images and videos across chats, cursor works, filters by type, never leaks another user's assets", async () => {
    const assetUser = await db.user.create({
      data: { clerkUserId: `test_asset_user_${randomUUID()}`, creditBalance: 10_000_000n },
    });
    const chat1 = await createChat(assetUser.id, "Chat With Images");
    const chat2 = await createChat(assetUser.id, "Chat With Videos");
    const otherChat = await createChat(otherUserId, "Other User Chat");

    const t1 = new Date(Date.now() - 30_000);
    const t2 = new Date(Date.now() - 20_000);
    const t3 = new Date(Date.now() - 10_000);

    // Create user messages & runs
    const msg1 = await db.message.create({ data: { chatId: chat1.id, role: "user", status: "complete", content: [] } });
    const run1 = await db.agentRun.create({
      data: {
        chatId: chat1.id,
        userId: assetUser.id,
        userMessageId: msg1.id,
        status: "succeeded",
        idempotencyKey: `run_${randomUUID()}`,
      },
    });

    const msg2 = await db.message.create({ data: { chatId: chat2.id, role: "user", status: "complete", content: [] } });
    const run2 = await db.agentRun.create({
      data: {
        chatId: chat2.id,
        userId: assetUser.id,
        userMessageId: msg2.id,
        status: "succeeded",
        idempotencyKey: `run_${randomUUID()}`,
      },
    });

    const otherMsg = await db.message.create({ data: { chatId: otherChat.id, role: "user", status: "complete", content: [] } });
    const otherRun = await db.agentRun.create({
      data: {
        chatId: otherChat.id,
        userId: otherUserId,
        userMessageId: otherMsg.id,
        status: "succeeded",
        idempotencyKey: `run_${randomUUID()}`,
      },
    });

    // Chat 1 has image 1
    await db.toolInvocation.create({
      data: {
        userId: assetUser.id,
        runId: run1.id,
        toolCallId: "call_img_1",
        order: 0,
        toolName: "gpt_image_2",
        status: "succeeded",
        input: { prompt: "a sunset" },
        output: { images: ["https://example.com/art_1.png"] },
        createdAt: t1,
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    // Chat 1 also has video 1
    await db.toolInvocation.create({
      data: {
        userId: assetUser.id,
        runId: run1.id,
        toolCallId: "call_vid_1",
        order: 1,
        toolName: "merge_videos",
        status: "succeeded",
        input: { video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"] },
        output: { video_url: "https://example.com/clip_1.mp4" },
        createdAt: t2,
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    // Chat 2 has image 2
    await db.toolInvocation.create({
      data: {
        userId: assetUser.id,
        runId: run2.id,
        toolCallId: "call_img_2",
        order: 0,
        toolName: "crop_image",
        status: "succeeded",
        input: { image_url: "https://example.com/in.png" },
        output: { image_url: "https://example.com/art_2.png" },
        createdAt: t3,
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    // Other user has secret assets
    await db.toolInvocation.create({
      data: {
        userId: otherUserId,
        runId: otherRun.id,
        toolCallId: "call_secret",
        order: 0,
        toolName: "gpt_image_2",
        status: "succeeded",
        input: { prompt: "secret" },
        output: { images: ["https://example.com/secret_other_user.png"] },
        createdAt: new Date(),
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: assetUser.id,
      clerkUserId: "mock_asset",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });

    // 1. Returns images and videos generated across chats, never leaks other user's assets
    const reqAll = new NextRequest("http://localhost:4000/v1/assets?limit=10");
    const resAll = await getAssetsRoute(reqAll, { params: Promise.resolve({}) });
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as ListAssetsResponse;

    const urls = bodyAll.items.map((a) => a.url);
    expect(urls).toContain("https://example.com/art_1.png");
    expect(urls).toContain("https://example.com/clip_1.mp4");
    expect(urls).toContain("https://example.com/art_2.png");
    expect(urls).not.toContain("https://example.com/secret_other_user.png");

    const art2 = bodyAll.items.find((a) => a.url === "https://example.com/art_2.png");
    expect(art2).toMatchObject({
      url: "https://example.com/art_2.png",
      type: "image",
      chatId: chat2.id,
      toolName: "crop_image",
    });
    expect(typeof art2?.createdAt).toBe("string");

    // 2. Filter by type=image
    const reqImg = new NextRequest("http://localhost:4000/v1/assets?type=image");
    const resImg = await getAssetsRoute(reqImg, { params: Promise.resolve({}) });
    const bodyImg = (await resImg.json()) as ListAssetsResponse;
    expect(bodyImg.items.every((a) => a.type === "image")).toBe(true);
    const imgUrls = bodyImg.items.map((a) => a.url);
    expect(imgUrls).toContain("https://example.com/art_1.png");
    expect(imgUrls).toContain("https://example.com/art_2.png");
    expect(imgUrls).not.toContain("https://example.com/clip_1.mp4");

    // 3. Filter by type=video
    const reqVid = new NextRequest("http://localhost:4000/v1/assets?type=video");
    const resVid = await getAssetsRoute(reqVid, { params: Promise.resolve({}) });
    const bodyVid = (await resVid.json()) as ListAssetsResponse;
    expect(bodyVid.items.every((a) => a.type === "video")).toBe(true);
    expect(bodyVid.items.map((a) => a.url)).toEqual(["https://example.com/clip_1.mp4"]);

    // 4. Cursor pagination works across pages without duplicates or skipping
    const reqP1 = new NextRequest("http://localhost:4000/v1/assets?limit=2");
    const resP1 = await getAssetsRoute(reqP1, { params: Promise.resolve({}) });
    const bodyP1 = (await resP1.json()) as ListAssetsResponse;
    expect(bodyP1.items).toHaveLength(2);
    expect(bodyP1.nextCursor).toBeTruthy();

    const reqP2 = new NextRequest(`http://localhost:4000/v1/assets?limit=2&cursor=${encodeURIComponent(bodyP1.nextCursor ?? "")}`);
    const resP2 = await getAssetsRoute(reqP2, { params: Promise.resolve({}) });
    const bodyP2 = (await resP2.json()) as ListAssetsResponse;
    expect(bodyP2.items).toHaveLength(1);
    expect(bodyP2.nextCursor).toBeNull();

    const page1Urls = bodyP1.items.map((a) => a.url);
    const page2Urls = bodyP2.items.map((a) => a.url);
    expect(new Set([...page1Urls, ...page2Urls]).size).toBe(3);

    // Cleanup local asset user
    await db.toolInvocation.deleteMany({ where: { run: { userId: assetUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: assetUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: assetUser.id } } });
    await db.chat.deleteMany({ where: { userId: assetUser.id } });
    await db.user.deleteMany({ where: { id: assetUser.id } });
  });
});
