import { createHmac } from "node:crypto";
import { task } from "@trigger.dev/sdk";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { validateWebhookUrl } from "@/modules/webhooks/validate-url";

export type DeliverWebhookTaskInput = {
  deliveryId: string;
};

const PROTECTED_HEADERS = ["content-type", "user-agent", "x-webhook-signature"];

/**
 * Sends one queued webhook delivery as a signed POST and records the result.
 *
 * Input:
 * - deliveryId: the webhook delivery row to send
 * - processId: the Trigger.dev run id, for logs
 *
 * Output:
 * - nothing; the delivery row gets the attempt count, status code, status and error
 *
 * Rules it enforces:
 * - Already succeeded → does nothing (safe to run twice).
 * - The URL is checked again before sending (SSRF check); failing it marks the delivery failed.
 * - Signed with HMAC-SHA256 over "<timestamp>.<body>" in X-Webhook-Signature (t=...,v1=...).
 *   Custom headers can't override Content-Type, User-Agent or the signature.
 * - 10 second timeout. Redirects are not followed and count as failed.
 * - Network error, 429 or 5xx → throws so the task retries; other 4xx → failed, no retry.
 */
export async function executeWebhookDelivery(deliveryId: string, processId?: string): Promise<void> {
  logger.info("delivering webhook", { deliveryId, processId });
  const delivery = await db.webhookDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (delivery.status === "succeeded") {
    return;
  }

  const currentAttempt = delivery.attempt + 1;

  try {
    await validateWebhookUrl(delivery.subscription.url);
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempt: currentAttempt,
        status: "failed",
        error: `SSRF check failed: ${errorMsg}`,
      },
    });
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const rawBody = typeof delivery.payload === "string"
    ? delivery.payload
    : JSON.stringify(delivery.payload);

  const signature = createHmac("sha256", delivery.subscription.secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const customHeaders: Record<string, string> = {};
  if (delivery.subscription.headers && typeof delivery.subscription.headers === "object") {
    for (const [key, val] of Object.entries(delivery.subscription.headers as Record<string, string>)) {
      if (!PROTECTED_HEADERS.includes(key.toLowerCase()) && typeof val === "string") {
        customHeaders[key] = val;
      }
    }
  }

  const reqHeaders: Record<string, string> = {
    ...customHeaders,
    "Content-Type": "application/json",
    "User-Agent": "Magica-Webhooks/1.0",
    "X-Webhook-Signature": `t=${timestamp},v1=${signature}`,
  };

  let res: Response;
  try {
    res = await fetch(delivery.subscription.url, {
      method: "POST",
      headers: reqHeaders,
      body: rawBody,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempt: currentAttempt,
        status: "failed",
        error: errorMsg,
      },
    });
    throw err;
  }

  // 3xx redirects count as failed deliveries and must not be followed
  if (res.status >= 300 && res.status < 400) {
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempt: currentAttempt,
        statusCode: res.status,
        status: "failed",
        error: `Redirects are not allowed (HTTP ${res.status})`,
      },
    });
    return;
  }

  if (res.ok) {
    logger.info("webhook delivered successfully", { deliveryId, statusCode: res.status, processId });
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempt: currentAttempt,
        statusCode: res.status,
        status: "succeeded",
        error: null,
      },
    });
    return;
  }

  logger.warn("webhook delivery returned non-2xx", { deliveryId, statusCode: res.status, processId });

  const isRetryable = res.status === 429 || res.status >= 500;
  await db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempt: currentAttempt,
      statusCode: res.status,
      status: "failed",
      error: `HTTP ${res.status}: ${res.statusText}`,
    },
  });

  if (isRetryable) {
    throw new Error(`Webhook delivery failed with HTTP ${res.status}`);
  }
}

/**
 * Trigger.dev task that delivers one webhook (see executeWebhookDelivery).
 * Retries up to 3 attempts with exponential backoff starting at 1 second.
 */
export const deliverWebhook = task<
  "deliver-webhook",
  DeliverWebhookTaskInput,
  void
>({
  id: "deliver-webhook",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
  },
  run: async ({ deliveryId }: DeliverWebhookTaskInput, { ctx }) => {
    await executeWebhookDelivery(deliveryId, ctx.run.id);
  },
});
