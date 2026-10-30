import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { POST as postMessageRoute } from "@/app/api/v1/chats/[chatId]/messages/route";
import { POST as postToolRunRoute } from "@/app/api/v1/tools/[name]/runs/route";
import type { SendMessageResponse, CreateToolRunResponse } from "@/contracts/api";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createChat } from "@/modules/chats/chats";
import * as runsModule from "@/modules/runs/runs";
import { finishToolInvocation } from "@/modules/tools/tools";
import { isPrivateIp, validateWebhookUrl } from "@/modules/webhooks/validate-url";
import { emitWebhook, verifyWebhookSignature } from "@/modules/webhooks/webhooks";
import { deliverWebhook, executeWebhookDelivery } from "@/trigger/deliver-webhook";
import { magicaRun } from "@/trigger/magica-run";

const server = setupServer(
  http.post("https://inference.magica.com/v1/nodes/estimate-credits", () => {
    return HttpResponse.json({ estimates: [{ microcredits: 10_000 }] });
  }),
);

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { clerkUserId: `test_wh_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.webhookDelivery.deleteMany({
    where: {
      subscription: {
        OR: [
          { agentRun: { userId } },
          { toolInvocation: { userId } },
        ],
      },
    },
  });
  await db.webhookSubscription.deleteMany({
    where: {
      OR: [
        { agentRun: { userId } },
        { toolInvocation: { userId } },
      ],
    },
  });
  await db.creditLedger.deleteMany({ where: { userId } });
  await db.toolInvocation.deleteMany({ where: { userId } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

const mockTriggerHandle = { id: "wh_handle_mock" } as unknown as Awaited<
  ReturnType<typeof deliverWebhook.trigger>
>;

describe("Webhook URL & SSRF Validation", () => {
  it("rejects non-HTTPS URLs", async () => {
    await expect(validateWebhookUrl("http://example.com/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("ftp://example.com/webhook")).rejects.toThrow(AppError);
  });

  it("rejects localhost and local/internal hostnames", async () => {
    await expect(validateWebhookUrl("https://localhost/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://app.localhost/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://server.local/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://backend.internal/webhook")).rejects.toThrow(AppError);
  });

  it("rejects loopback and private IPv4 addresses", async () => {
    await expect(validateWebhookUrl("https://127.0.0.1/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://10.0.0.5/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://172.16.0.1/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://172.31.255.255/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://192.168.1.100/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(AppError);
  });

  it("rejects IPv6 loopback and private addresses", async () => {
    await expect(validateWebhookUrl("https://[::1]/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://[fc00::1]/webhook")).rejects.toThrow(AppError);
    await expect(validateWebhookUrl("https://[fe80::1]/webhook")).rejects.toThrow(AppError);
  });

  it("identifies private IPs accurately via isPrivateIp helper", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.20.0.1")).toBe(true);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("fails closed if DNS lookup fails", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(validateWebhookUrl("https://nonexistent-domain.xyz/hook")).rejects.toThrow(AppError);
  });

  it("accepts valid public HTTPS endpoints with mocked DNS lookup", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "93.184.215.14", family: 4 }]) as never);
    const valid = await validateWebhookUrl("https://example.com/api/webhook");
    expect(valid).toBe("https://example.com/api/webhook");
  });
});

describe("Agent Run Webhooks & Security", () => {
  beforeEach(() => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_clerk",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });
    vi.spyOn(runsModule, "dispatchRun").mockResolvedValue({
      runId: "trig_run_mock_123",
      accessToken: "mock_token_abc",
    });
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "93.184.215.14", family: 4 }]) as never);
  });

  it("returns signingSecret once and stores subscription in WebhookSubscription table", async () => {
    const chat = await createChat(userId, "Webhook Agent Chat");
    const clientRequestId = `req_wh_${randomUUID()}`;

    const req = new NextRequest(`http://localhost:4000/api/v1/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Hello with webhook",
        clientRequestId,
        webhook: {
          url: "https://example.com/agent-webhook",
          events: ["run.started", "run.completed"],
          metadata: { customerId: "cust_123" },
          headers: { "X-Test-Header": "custom-val" },
        },
      }),
    });

    const res = await postMessageRoute(req, { params: Promise.resolve({ chatId: chat.id }) });
    expect(res.status).toBe(201);

    const json = (await res.json()) as SendMessageResponse;
    expect(json.runId).toBeDefined();
    expect(json.webhook).toBeDefined();
    expect(json.webhook?.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const sub = await db.webhookSubscription.findUniqueOrThrow({ where: { agentRunId: json.runId } });
    expect(sub.url).toBe("https://example.com/agent-webhook");
    expect(sub.secret).toBe(json.webhook?.signingSecret);
    expect(sub.events).toEqual(["run.started", "run.completed"]);
    expect(sub.metadata).toEqual({ customerId: "cust_123" });
    expect(sub.headers).toEqual({ "X-Test-Header": "custom-val" });
  });

  it("delivers signed payload with Stripe-style signature over t.body and checks replay", async () => {
    let receivedSignature: string | null = null;
    let receivedOldTimestamp: string | null = null;
    let receivedMagicaSignature: string | null = null;
    let receivedRawBody: string | null = null;
    let receivedCustomHeader: string | null = null;

    server.use(
      http.post("https://example.com/receiver", async ({ request }) => {
        receivedSignature = request.headers.get("x-webhook-signature");
        receivedOldTimestamp = request.headers.get("x-webhook-timestamp");
        receivedMagicaSignature = request.headers.get("magica-signature");
        receivedCustomHeader = request.headers.get("x-custom-allowed");
        receivedRawBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    const chat = await createChat(userId, "Webhook Delivery Test");
    const clientRequestId = `req_wh_deliver_${randomUUID()}`;

    const req = new NextRequest(`http://localhost:4000/api/v1/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Test delivery",
        clientRequestId,
        webhook: {
          url: "https://example.com/receiver",
          events: ["run.completed"],
          metadata: { testMetaKey: "metaVal" },
          headers: {
            "Content-Type": "text/xml", // should be dropped!
            "User-Agent": "Attacker/1.0", // should be dropped!
            "X-Webhook-Signature": "fake-sig", // should be dropped!
            "X-Custom-Allowed": "legit-value",
          },
        },
      }),
    });

    const res = await postMessageRoute(req, { params: Promise.resolve({ chatId: chat.id }) });
    const json = (await res.json()) as SendMessageResponse;
    const secret = json.webhook!.signingSecret;

    // Trigger delivery task via emitWebhook
    const triggerSpy = vi.spyOn(deliverWebhook, "trigger").mockResolvedValue(mockTriggerHandle);

    await emitWebhook({
      agentRunId: json.runId,
      event: "run.completed",
      data: {
        status: "succeeded",
        toolName: null,
        output: { text: "Completed reply" },
        creditUsed: 15,
        finishedAt: new Date().toISOString(),
      },
    });

    // Verify task payload contains ONLY { deliveryId } - NO SECRET in task payload!
    expect(triggerSpy).toHaveBeenCalledWith(
      { deliveryId: expect.any(String) },
      expect.anything(),
    );
    const deliveryId = triggerSpy.mock.calls[0]![0].deliveryId;

    // Now execute the delivery
    await executeWebhookDelivery(deliveryId);

    // Verify removed headers: X-Webhook-Timestamp and Magica-Signature must NOT be sent
    expect(receivedOldTimestamp).toBeNull();
    expect(receivedMagicaSignature).toBeNull();

    // Verify single signature header: X-Webhook-Signature: t=<unix>,v1=<hex>
    expect(receivedSignature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(receivedCustomHeader).toBe("legit-value");

    // Verify signature with verifyWebhookSignature
    const isValid = verifyWebhookSignature({
      rawBody: receivedRawBody!,
      signatureHeader: receivedSignature!,
      secret,
    });
    expect(isValid).toBe(true);

    // Verify replay tolerance rejects old timestamp (> 300 seconds)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 350;
    const fakeSignature = `t=${oldTimestamp},v1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
    expect(() =>
      verifyWebhookSignature({
        rawBody: receivedRawBody!,
        signatureHeader: fakeSignature,
        secret,
      }),
    ).toThrow(/tolerance/);
  });

  it("does not follow 3xx redirects and marks delivery failed", async () => {
    server.use(
      http.post("https://example.com/redirect-target", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://example.com/attacker" },
        });
      }),
    );

    const chat = await createChat(userId, "Redirect Test");
    const run = await db.agentRun.create({
      data: {
        chatId: chat.id,
        userId,
        userMessageId: (await db.message.create({
          data: { chatId: chat.id, role: "user", status: "complete", content: [] },
        })).id,
        status: "queued",
        idempotencyKey: randomUUID(),
      },
    });

    const sub = await db.webhookSubscription.create({
      data: {
        agentRunId: run.id,
        url: "https://example.com/redirect-target",
        secret: "whsec_test_redirect",
        events: ["run.started"],
      },
    });

    const delivery = await db.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        event: "run.started",
        payload: { type: "run.started", runId: run.id, data: { status: "running" } },
        idempotencyKey: `${sub.id}:run.started`,
      },
    });

    await executeWebhookDelivery(delivery.id);

    const updated = await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("failed");
    expect(updated.statusCode).toBe(302);
    expect(updated.error).toContain("Redirects are not allowed");
  });
});

describe("Tool Run Webhooks & tool.completed", () => {
  beforeEach(() => {
    vi.spyOn(authModule, "requireUser").mockResolvedValue({
      id: userId,
      clerkUserId: "mock_clerk",
      creditBalance: 10_000_000n,
      createdAt: new Date(),
    });
    vi.spyOn(runsModule, "dispatchRun").mockResolvedValue({
      runId: "mock_run",
      accessToken: "mock_tok",
    });
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "93.184.215.14", family: 4 }]) as never);
    vi.spyOn(magicaRun, "trigger").mockResolvedValue({
      id: `trig_tool_${randomUUID()}`,
      publicAccessToken: "tok_tool",
    } as unknown as Awaited<ReturnType<typeof magicaRun.trigger>>);
  });

  it("creates direct tool run with webhook and returns signingSecret", async () => {
    const triggerSpy = vi.spyOn(deliverWebhook, "trigger").mockResolvedValue(mockTriggerHandle);

    const req = new NextRequest("http://localhost:4000/api/v1/tools/crop_image/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          image_url: "https://example.com/source.jpg",
          crop: { x: 0, y: 0, width: 100, height: 100 },
        },
        webhook: {
          url: "https://example.com/tool-receiver",
          events: ["run.started", "run.completed"],
          metadata: { toolJob: "job_42" },
        },
      }),
    });

    const res = await postToolRunRoute(req, { params: Promise.resolve({ name: "crop_image" }) });
    expect(res.status).toBe(200);

    const json = (await res.json()) as CreateToolRunResponse;
    expect(json.runId).toBeDefined();
    expect(json.webhook).toBeDefined();
    expect(json.webhook?.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const sub = await db.webhookSubscription.findUniqueOrThrow({ where: { toolInvocationId: json.runId } });
    expect(sub.url).toBe("https://example.com/tool-receiver");
    expect(sub.secret).toBe(json.webhook?.signingSecret);
    expect(sub.events).toEqual(["run.started", "run.completed"]);
    expect(sub.metadata).toEqual({ toolJob: "job_42" });

    // Verify task payload contains only { deliveryId }
    expect(triggerSpy).toHaveBeenCalledWith(
      { deliveryId: expect.any(String) },
      expect.anything(),
    );
  });

  it("emits tool.completed to the agent run's webhook when a tool finishes inside an agent run", async () => {
    const triggerSpy = vi.spyOn(deliverWebhook, "trigger").mockResolvedValue(mockTriggerHandle);

    // Create an agent run with a webhook subscribed to tool.completed
    const chat = await createChat(userId, "Agent Run With Tool");
    const agentRun = await db.agentRun.create({
      data: {
        chatId: chat.id,
        userId,
        userMessageId: (await db.message.create({
          data: { chatId: chat.id, role: "user", status: "complete", content: [] },
        })).id,
        status: "running",
        idempotencyKey: randomUUID(),
      },
    });

    const sub = await db.webhookSubscription.create({
      data: {
        agentRunId: agentRun.id,
        url: "https://example.com/agent-tool-webhook",
        secret: "whsec_agent_tool_sub",
        events: ["tool.completed"],
      },
    });

    // Create a tool invocation inside this agent run
    const inv = await db.toolInvocation.create({
      data: {
        userId,
        runId: agentRun.id,
        toolCallId: `call_${randomUUID()}`,
        order: 0,
        toolName: "crop_image",
        status: "running",
        input: { image_url: "https://example.com/source.jpg" },
        idempotencyKey: `tool_turn_${randomUUID()}`,
      },
    });

    // Finish tool invocation
    await finishToolInvocation(inv, {
      ok: true,
      output: { cropped_url: "https://example.com/crop.jpg" },
      creditUsed: 12,
    });

    // Verify tool.completed was emitted to the agent run's webhook
    expect(triggerSpy).toHaveBeenCalledWith(
      { deliveryId: expect.any(String) },
      { idempotencyKey: `${sub.id}:tool.completed` },
    );

    const deliveryId = triggerSpy.mock.calls[0]![0].deliveryId;
    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.subscriptionId).toBe(sub.id);
    expect(delivery.event).toBe("tool.completed");
    expect(delivery.payload).toMatchObject({
      type: "tool.completed",
      runId: agentRun.id,
      data: {
        status: "succeeded",
        toolName: "crop_image",
        output: { cropped_url: "https://example.com/crop.jpg" },
        creditUsed: 12,
      },
    });
  });
});

describe("Trigger.dev Retry Policy & Error Handling", () => {
  beforeEach(() => {
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "93.184.215.14", family: 4 }]) as never);
  });

  it("throws on 500 error so Trigger.dev retries, and records attempt count", async () => {
    server.use(
      http.post("https://example.com/server-error", () => {
        return HttpResponse.json({ error: "Internal crash" }, { status: 500 });
      }),
    );

    const sub = await db.webhookSubscription.create({
      data: {
        url: "https://example.com/server-error",
        secret: "whsec_retry_test",
        events: ["run.completed"],
      },
    });

    const delivery = await db.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        event: "run.completed",
        payload: { type: "run.completed", runId: "r1", data: { status: "succeeded" } },
        idempotencyKey: `idem_500_${randomUUID()}`,
      },
    });

    await expect(executeWebhookDelivery(delivery.id)).rejects.toThrow(/HTTP 500/);

    const updated = await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("failed");
    expect(updated.statusCode).toBe(500);
    expect(updated.attempt).toBe(1);
    expect(updated.error).toContain("HTTP 500");

    // Second retry attempt
    await expect(executeWebhookDelivery(delivery.id)).rejects.toThrow(/HTTP 500/);
    const updated2 = await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated2.attempt).toBe(2);
  });

  it("does not retry 400 Bad Request client errors", async () => {
    server.use(
      http.post("https://example.com/bad-request", () => {
        return HttpResponse.json({ error: "Bad request format" }, { status: 400 });
      }),
    );

    const sub = await db.webhookSubscription.create({
      data: {
        url: "https://example.com/bad-request",
        secret: "whsec_400_test",
        events: ["run.completed"],
      },
    });

    const delivery = await db.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        event: "run.completed",
        payload: { type: "run.completed", runId: "r2", data: { status: "succeeded" } },
        idempotencyKey: `idem_400_${randomUUID()}`,
      },
    });

    // Should NOT throw because 400 is not retryable
    await executeWebhookDelivery(delivery.id);

    const updated = await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("failed");
    expect(updated.statusCode).toBe(400);
    expect(updated.attempt).toBe(1);
  });
});
