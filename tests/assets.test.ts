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
  await db.attachment.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
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

  it("handles uploads in media library: source filter, merged keyset pagination, and total count", async () => {
    const testUser = await db.user.create({
      data: { clerkUserId: `test_media_lib_${randomUUID()}`, creditBalance: 10_000_000n },
    });
    const chat = await createChat(testUser.id, "Media Chat");
    const msg = await db.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: [] } });
    const run = await db.agentRun.create({
      data: {
        chatId: chat.id,
        userId: testUser.id,
        userMessageId: msg.id,
        status: "succeeded",
        idempotencyKey: `run_${randomUUID()}`,
      },
    });

    const now = Date.now();
    // Interleaved timestamps (newest to oldest):
    // t5: upload 2 (image)
    // t4: tool 2 (video)
    // t3: upload 1 (video)
    // t2: tool 1 (image)
    // t1: expired upload (should be excluded)
    // other: upload from other user (should be excluded)
    const t5 = new Date(now - 1_000);
    const t4 = new Date(now - 2_000);
    const t3 = new Date(now - 3_000);
    const t2 = new Date(now - 4_000);
    const t1 = new Date(now - 100_000);

    const up2 = await db.attachment.create({
      data: {
        userId: testUser.id,
        name: "photo2.png",
        sizeBytes: 2048n,
        mimeType: "image/png",
        kind: "image",
        source: "upload",
        status: "ready",
        url: "https://example.com/photo2.png",
        createdAt: t5,
      },
    });

    await db.toolInvocation.create({
      data: {
        userId: testUser.id,
        runId: run.id,
        toolCallId: "call_vid_2",
        order: 1,
        toolName: "merge_videos",
        status: "succeeded",
        input: { video_urls: ["https://example.com/a.mp4"] },
        output: { video_url: "https://example.com/gen_vid.mp4" },
        createdAt: t4,
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    await db.attachment.create({
      data: {
        userId: testUser.id,
        name: "clip1.mp4",
        sizeBytes: 8192n,
        mimeType: "video/mp4",
        kind: "video",
        source: "upload",
        status: "ready",
        url: "https://example.com/clip1.mp4",
        createdAt: t3,
      },
    });

    const inv1 = await db.toolInvocation.create({
      data: {
        userId: testUser.id,
        runId: run.id,
        toolCallId: "call_img_gen",
        order: 0,
        toolName: "gpt_image_2",
        status: "succeeded",
        input: { prompt: "generated sunset" },
        output: { images: ["https://example.com/gen_sunset.png"] },
        createdAt: t2,
        idempotencyKey: `inv_${randomUUID()}`,
      },
    });

    // Expired upload - should never show up
    await db.attachment.create({
      data: {
        userId: testUser.id,
        name: "expired.png",
        sizeBytes: 100n,
        mimeType: "image/png",
        kind: "image",
        source: "upload",
        status: "ready",
        url: "https://example.com/expired.png",
        createdAt: t1,
        expiresAt: new Date(now - 1_000),
      },
    });

    // Other user's upload - should never show up
    await db.attachment.create({
      data: {
        userId: otherUserId,
        name: "other.png",
        sizeBytes: 100n,
        mimeType: "image/png",
        kind: "image",
        source: "upload",
        status: "ready",
        url: "https://example.com/other.png",
        createdAt: t5,
      },
    });

    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: testUser.id,
      clerkUserId: "mock_test_user",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });

    // 1. source=all returns both uploads and generated media
    const resAll = await getAssetsRoute(new NextRequest("http://localhost:4000/v1/assets?source=all"), {
      params: Promise.resolve({}),
    });
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as ListAssetsResponse;
    expect(bodyAll.total).toBe(4);
    expect(bodyAll.items).toHaveLength(4);
    const allUrls = bodyAll.items.map((i) => i.url);
    expect(allUrls).toEqual([
      "https://example.com/photo2.png",
      "https://example.com/gen_vid.mp4",
      "https://example.com/clip1.mp4",
      "https://example.com/gen_sunset.png",
    ]);

    // Check DTO properties
    const upItem = bodyAll.items.find((i) => i.url === "https://example.com/photo2.png")!;
    expect(upItem.source).toBe("upload");
    expect(upItem.name).toBe("photo2.png");
    expect(upItem.sizeBytes).toBe(2048);
    expect(upItem.attachmentId).toBe(up2.id);
    expect(upItem.toolInvocationId).toBeUndefined();

    const genItem = bodyAll.items.find((i) => i.url === "https://example.com/gen_sunset.png")!;
    expect(genItem.source).toBe("generated");
    expect(genItem.prompt).toBe("generated sunset");
    expect(genItem.sizeBytes).toBeNull();
    expect(genItem.toolInvocationId).toBe(inv1.id);
    expect(genItem.attachmentId).toBeUndefined();

    // 2. source=uploads returns only uploads
    const resUploads = await getAssetsRoute(new NextRequest("http://localhost:4000/v1/assets?source=uploads"), {
      params: Promise.resolve({}),
    });
    const bodyUploads = (await resUploads.json()) as ListAssetsResponse;
    expect(bodyUploads.total).toBe(2);
    expect(bodyUploads.items).toHaveLength(2);
    expect(bodyUploads.items.every((i) => i.source === "upload")).toBe(true);
    expect(bodyUploads.items.map((i) => i.url)).toEqual([
      "https://example.com/photo2.png",
      "https://example.com/clip1.mp4",
    ]);

    // 3. source=generated returns only generated items
    const resGen = await getAssetsRoute(new NextRequest("http://localhost:4000/v1/assets?source=generated"), {
      params: Promise.resolve({}),
    });
    const bodyGen = (await resGen.json()) as ListAssetsResponse;
    expect(bodyGen.total).toBe(2);
    expect(bodyGen.items).toHaveLength(2);
    expect(bodyGen.items.every((i) => i.source === "generated")).toBe(true);
    expect(bodyGen.items.map((i) => i.url)).toEqual([
      "https://example.com/gen_vid.mp4",
      "https://example.com/gen_sunset.png",
    ]);

    // 4. Filter by type=image and source=all
    const resImg = await getAssetsRoute(new NextRequest("http://localhost:4000/v1/assets?source=all&type=image"), {
      params: Promise.resolve({}),
    });
    const bodyImg = (await resImg.json()) as ListAssetsResponse;
    expect(bodyImg.total).toBe(2);
    expect(bodyImg.items.map((i) => i.url)).toEqual([
      "https://example.com/photo2.png",
      "https://example.com/gen_sunset.png",
    ]);

    // 5. Merged keyset pagination: limit=2 across interleaved sources
    const resPage1 = await getAssetsRoute(new NextRequest("http://localhost:4000/v1/assets?source=all&limit=2"), {
      params: Promise.resolve({}),
    });
    const bodyPage1 = (await resPage1.json()) as ListAssetsResponse;
    expect(bodyPage1.items).toHaveLength(2);
    expect(bodyPage1.items.map((i) => i.url)).toEqual([
      "https://example.com/photo2.png",
      "https://example.com/gen_vid.mp4",
    ]);
    expect(bodyPage1.nextCursor).toBeTruthy();

    const resPage2 = await getAssetsRoute(
      new NextRequest(`http://localhost:4000/v1/assets?source=all&limit=2&cursor=${encodeURIComponent(bodyPage1.nextCursor!)}`),
      { params: Promise.resolve({}) },
    );
    const bodyPage2 = (await resPage2.json()) as ListAssetsResponse;
    expect(bodyPage2.items).toHaveLength(2);
    expect(bodyPage2.items.map((i) => i.url)).toEqual([
      "https://example.com/clip1.mp4",
      "https://example.com/gen_sunset.png",
    ]);
    expect(bodyPage2.nextCursor).toBeNull();

    // Cleanup
    await db.attachment.deleteMany({ where: { userId: testUser.id } });
    await db.toolInvocation.deleteMany({ where: { run: { userId: testUser.id } } });
    await db.agentRun.deleteMany({ where: { userId: testUser.id } });
    await db.message.deleteMany({ where: { chat: { userId: testUser.id } } });
    await db.chat.deleteMany({ where: { userId: testUser.id } });
    await db.user.deleteMany({ where: { id: testUser.id } });
  });
});
