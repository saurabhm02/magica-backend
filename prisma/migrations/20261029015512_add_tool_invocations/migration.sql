-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" "ToolStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "magicaRunId" TEXT,
    "durationMs" INTEGER,
    "error" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_idempotencyKey_key" ON "ToolInvocation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolInvocation_runId_order_idx" ON "ToolInvocation"("runId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_toolCallId_key" ON "ToolInvocation"("runId", "toolCallId");

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
