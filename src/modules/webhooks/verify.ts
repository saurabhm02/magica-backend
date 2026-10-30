import crypto from "node:crypto";

export function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  toleranceSeconds = 300,
}: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signaturePart = parts.find((p) => p.startsWith("v1="));

  if (!timestampPart || !signaturePart) {
    throw new Error("Invalid signature header format");
  }

  const timestamp = parseInt(timestampPart.slice(2), 10);
  const signature = signaturePart.slice(3);

  if (isNaN(timestamp)) {
    throw new Error("Invalid timestamp");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new Error("Webhook timestamp outside acceptable tolerance window");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expectedSignature, "hex"),
  );
}
