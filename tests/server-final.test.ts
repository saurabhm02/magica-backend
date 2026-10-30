import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as postMessageRoute } from "@/app/api/v1/chats/[chatId]/messages/route";
import { GET as getModelsRoute } from "@/app/api/v1/models/route";
import { GET as getRunRoute } from "@/app/api/v1/runs/[runId]/route";
import { POST as estimateToolRoute } from "@/app/api/v1/tools/[name]/estimate/route";
import { POST as postToolRunRoute } from "@/app/api/v1/tools/[name]/runs/route";
import * as authModule from "@/lib/auth";
import { validateVisionModels, VISION_MODELS } from "@/lib/constants";
import { db } from "@/lib/db";
import { createChat } from "@/modules/chats/chats";
import { magicaRun } from "@/trigger/magica-run";

describe("Final Server Endpoints & Rate Limits", () => {
  let userA: { id: string; clerkUserId: string; creditBalance: bigint };
  let userB: { id: string; clerkUserId: string; creditBalance: bigint };

  beforeAll(async () => {
    const uA = await db.user.create({
      data: { clerkUserId: `test_final_userA_${randomUUID()}`, creditBalance: 10_000_000n },
    });
    const uB = await db.user.create({
      data: { clerkUserId: `test_final_userB_${randomUUID()}`, creditBalance: 10_000_000n },
    });
    userA = { id: uA.id, clerkUserId: uA.clerkUserId, creditBalance: uA.creditBalance };
    userB = { id: uB.id, clerkUserId: uB.clerkUserId, creditBalance: uB.creditBalance };
  });

  afterAll(async () => {
    await db.creditLedger.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.toolInvocation.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.agentRun.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.message.deleteMany({ where: { chat: { userId: { in: [userA.id, userB.id] } } } });
    await db.chat.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await db.$disconnect();
  });

  describe("Item 1: Rate Limiting", () => {
    it("enforces message rate limit (max 20 per minute)", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      const chat = await createChat(userA.id, "Rate Limit Test Chat");

      // Insert 20 user messages in the last 30 seconds
      const now = new Date();
      for (let i = 0; i < 20; i++) {
        await db.message.create({
          data: {
            chatId: chat.id,
            role: "user",
            status: "complete",
            content: [{ type: "text", text: `Message ${i}` }],
            createdAt: new Date(now.getTime() - (20 - i) * 1000),
          },
        });
      }

      // 21st message should trigger 429 RATE_LIMITED
      const req = new NextRequest(`http://localhost:4000/api/v1/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "21st message exceeding limit",
          clientRequestId: randomUUID(),
        }),
      });

      const res = await postMessageRoute(req, { params: Promise.resolve({ chatId: chat.id }) });
      expect(res.status).toBe(429);

      const json = (await res.json()) as { error: { code: string; retryAfterSeconds: number } };
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });

    it("enforces tool run rate limit (max 10 per minute)", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      vi.spyOn(magicaRun, "trigger").mockResolvedValue({
        id: "trig_mock_123",
        publicAccessToken: "tok_mock",
      } as unknown as Awaited<ReturnType<typeof magicaRun.trigger>>);

      // Insert 10 tool invocations in the last 30 seconds
      const now = new Date();
      for (let i = 0; i < 10; i++) {
        await db.toolInvocation.create({
          data: {
            userId: userA.id,
            toolCallId: `call_rate_${i}`,
            order: 0,
            toolName: "crop_image",
            status: "succeeded",
            input: { image_url: "https://example.com/test.png" },
            idempotencyKey: `tool_rate_test_${randomUUID()}`,
            createdAt: new Date(now.getTime() - (10 - i) * 1000),
          },
        });
      }

      // 11th tool run should trigger 429 RATE_LIMITED
      const req = new NextRequest("http://localhost:4000/api/v1/tools/crop_image/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { image_url: "https://example.com/test.png" },
        }),
      });

      const res = await postToolRunRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
      expect(res.status).toBe(429);

      const json = (await res.json()) as { error: { code: string; retryAfterSeconds: number } };
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });
  });

  describe("Item 2: Tool Estimate Endpoint", () => {
    it("returns estimated credits for valid tool input", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      const req = new NextRequest("http://localhost:4000/api/v1/tools/crop_image/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { image_url: "https://example.com/test.png" },
        }),
      });

      const res = await estimateToolRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
      expect(res.status).toBe(200);

      const json = (await res.json()) as { credits: number };
      expect(json.credits).toBe(5_000);
    });

    it("returns 404 for unknown tool", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      const req = new NextRequest("http://localhost:4000/api/v1/tools/nonexistent_tool/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });

      const res = await estimateToolRoute(req, { params: Promise.resolve({ name: "nonexistent_tool" }) });
      expect(res.status).toBe(404);

      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("NOT_FOUND");
    });

    it("returns 400 for invalid tool input", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      const req = new NextRequest("http://localhost:4000/api/v1/tools/crop_image/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { invalid_field: 123 } }),
      });

      const res = await estimateToolRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
      expect(res.status).toBe(400);

      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("TOOL_INPUT_INVALID");
    });
  });

  describe("Item 3: Model Discovery", () => {
    it("returns OpenRouter free model and vision models", async () => {
      const req = new NextRequest("http://localhost:4000/api/v1/models");
      const res = await getModelsRoute(req, {} as Record<string, never>);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        models: Array<{ id: string; label: string; default: boolean }>;
        visionModels: string[];
      };
      expect(json.models).toEqual([
        {
          id: "openrouter/free",
          label: "OpenRouter Free",
          default: true,
        },
      ]);
      expect(json.visionModels).toEqual(VISION_MODELS);
      expect(json.visionModels.length).toBeGreaterThan(0);
    });

    it("validates that all vision models end in :free and throws otherwise", () => {
      expect(() => validateVisionModels(VISION_MODELS)).not.toThrow();

      expect(() => validateVisionModels(["openai/gpt-4o"])).toThrow(
        /Refused vision model "openai\/gpt-4o": must end in ":free"/,
      );
    });
  });

  describe("Item 4: Run Status", () => {
    it("returns run status and metadata for owner", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userA.id,
        clerkUserId: userA.clerkUserId,
        creditBalance: userA.creditBalance,
        createdAt: new Date(),
      });

      const chat = await createChat(userA.id, "Run Status Chat");
      const msg = await db.message.create({
        data: { chatId: chat.id, role: "user", status: "complete", content: [] },
      });
      const run = await db.agentRun.create({
        data: {
          chatId: chat.id,
          userId: userA.id,
          userMessageId: msg.id,
          status: "succeeded",
          chargedCredits: 5000n,
          routedModel: "openrouter/free",
          idempotencyKey: `run_status_${randomUUID()}`,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });

      const req = new NextRequest(`http://localhost:4000/api/v1/runs/${run.id}`);
      const res = await getRunRoute(req, { params: Promise.resolve({ runId: run.id }) });
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        id: string;
        chatId: string;
        status: string;
        chargedCredits: number;
        routedModel?: string;
        startedAt?: string;
        finishedAt?: string;
      };
      expect(json.id).toBe(run.id);
      expect(json.chatId).toBe(chat.id);
      expect(json.status).toBe("succeeded");
      expect(json.chargedCredits).toBe(5000);
      expect(json.routedModel).toBe("openrouter/free");
      expect(json.startedAt).toBeTruthy();
      expect(json.finishedAt).toBeTruthy();
    });

    it("returns 404 NOT_FOUND for non-owner", async () => {
      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        id: userB.id,
        clerkUserId: userB.clerkUserId,
        creditBalance: userB.creditBalance,
        createdAt: new Date(),
      });

      const chat = await createChat(userA.id, "Owner A Chat");
      const msg = await db.message.create({
        data: { chatId: chat.id, role: "user", status: "complete", content: [] },
      });
      const run = await db.agentRun.create({
        data: {
          chatId: chat.id,
          userId: userA.id,
          userMessageId: msg.id,
          status: "succeeded",
          idempotencyKey: `run_status_leak_${randomUUID()}`,
        },
      });

      // UserB requests UserA's run
      const req = new NextRequest(`http://localhost:4000/api/v1/runs/${run.id}`);
      const res = await getRunRoute(req, { params: Promise.resolve({ runId: run.id }) });
      expect(res.status).toBe(404);

      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("NOT_FOUND");
      expect(json.error.code).toBe("NOT_FOUND");
      expect(json.error.code).toBe("NOT_FOUND");
    });
  });
});
