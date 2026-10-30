-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT,
    "toolInvocationId" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headers" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSubscription_agentRunId_key" ON "WebhookSubscription"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSubscription_toolInvocationId_key" ON "WebhookSubscription"("toolInvocationId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_agentRunId_idx" ON "WebhookSubscription"("agentRunId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_toolInvocationId_idx" ON "WebhookSubscription"("toolInvocationId");

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Clean existing WebhookDelivery records
TRUNCATE TABLE "WebhookDelivery";

-- Drop old foreign keys and columns on WebhookDelivery
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT IF EXISTS "WebhookDelivery_agentRunId_fkey";
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT IF EXISTS "WebhookDelivery_toolInvocationId_fkey";
DROP INDEX IF EXISTS "WebhookDelivery_agentRunId_idx";
DROP INDEX IF EXISTS "WebhookDelivery_toolInvocationId_idx";
ALTER TABLE "WebhookDelivery" DROP COLUMN IF EXISTS "agentRunId",
DROP COLUMN IF EXISTS "toolInvocationId",
DROP COLUMN IF EXISTS "url";

-- Add subscriptionId and payload columns to WebhookDelivery
ALTER TABLE "WebhookDelivery" ADD COLUMN "subscriptionId" TEXT NOT NULL,
ADD COLUMN "payload" JSONB NOT NULL;

-- Default attempt to 0
ALTER TABLE "WebhookDelivery" ALTER COLUMN "attempt" SET DEFAULT 0;

-- AddForeignKey for subscriptionId
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");

-- Drop 5 columns from AgentRun
ALTER TABLE "AgentRun" DROP COLUMN IF EXISTS "webhookUrl",
DROP COLUMN IF EXISTS "webhookSecret",
DROP COLUMN IF EXISTS "webhookEvents",
DROP COLUMN IF EXISTS "webhookHeaders",
DROP COLUMN IF EXISTS "webhookMetadata";

-- Drop 5 columns from ToolInvocation
ALTER TABLE "ToolInvocation" DROP COLUMN IF EXISTS "webhookUrl",
DROP COLUMN IF EXISTS "webhookSecret",
DROP COLUMN IF EXISTS "webhookEvents",
DROP COLUMN IF EXISTS "webhookHeaders",
DROP COLUMN IF EXISTS "webhookMetadata";
