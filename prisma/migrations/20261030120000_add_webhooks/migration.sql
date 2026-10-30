-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "webhookUrl" TEXT,
ADD COLUMN "webhookSecret" TEXT,
ADD COLUMN "webhookEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "webhookHeaders" JSONB,
ADD COLUMN "webhookMetadata" JSONB;

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN "webhookUrl" TEXT,
ADD COLUMN "webhookSecret" TEXT,
ADD COLUMN "webhookEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "webhookHeaders" JSONB,
ADD COLUMN "webhookMetadata" JSONB;

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT,
    "toolInvocationId" TEXT,
    "event" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_idempotencyKey_key" ON "WebhookDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_agentRunId_idx" ON "WebhookDelivery"("agentRunId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_toolInvocationId_idx" ON "WebhookDelivery"("toolInvocationId");

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
