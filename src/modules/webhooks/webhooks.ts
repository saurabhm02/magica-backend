import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { WEBHOOK_EVENTS, type WebhookData, type WebhookEvent, type WebhookPayload } from "@/contracts/webhook";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { deliverWebhook } from "@/trigger/deliver-webhook";

export { validateWebhookUrl } from "./validate-url";
export { verifyWebhookSignature } from "./verify";

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export type EmitWebhookParams = {
  agentRunId?: string;
  toolInvocationId?: string;
  event: WebhookEvent;
  data: WebhookData;
};

/**
 * Queues a webhook for a run event, if the run has a webhook subscribed to that event.
 *
 * Input:
 * - agentRunId or toolInvocationId: what the event is about
 * - event: e.g. run.started, run.completed, run.failed, run.canceled
 * - data: the event body (status, output, credits used, finish time)
 *
 * Output:
 * - nothing; delivery happens in the deliver-webhook task
 *
 * Notes:
 * - One delivery per subscription + event (key <subscriptionId>:<event>), so emitting the same
 *   event twice sends it once.
 * - Never throws: a webhook problem must not break the run. Errors are only logged.
 */
export async function emitWebhook({
  agentRunId,
  toolInvocationId,
  event,
  data,
}: EmitWebhookParams): Promise<void> {
  const runId = agentRunId ?? toolInvocationId;
  if (!runId) return;

  try {
    const subscription = await db.webhookSubscription.findFirst({
      where: {
        OR: [
          ...(agentRunId ? [{ agentRunId }] : []),
          ...(toolInvocationId ? [{ toolInvocationId }] : []),
        ],
      },
    });

    if (!subscription) return;

    const subscribedEvents = subscription.events && subscription.events.length > 0
      ? (subscription.events as WebhookEvent[])
      : WEBHOOK_EVENTS;

    if (!subscribedEvents.includes(event)) return;

    const payload: WebhookPayload = {
      type: event,
      runId,
      data,
      metadata: (subscription.metadata as Record<string, unknown>) ?? {},
    };

    const idempotencyKey = `${subscription.id}:${event}`;

    const delivery = await db.webhookDelivery.upsert({
      where: { idempotencyKey },
      create: {
        subscriptionId: subscription.id,
        event,
        payload: payload as Prisma.InputJsonValue,
        idempotencyKey,
        status: "pending",
      },
      update: {},
    });

    await deliverWebhook.trigger({ deliveryId: delivery.id }, { idempotencyKey });
  } catch (err) {
    logger.warn("emitWebhook error", { runId, event, err: String(err) });
  }
}
