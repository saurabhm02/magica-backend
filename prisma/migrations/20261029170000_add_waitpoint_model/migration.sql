-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('pending', 'answered', 'skipped', 'expired');

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolInvocationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_tokenId_key" ON "Waitpoint"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_idempotencyKey_key" ON "Waitpoint"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Waitpoint_runId_status_idx" ON "Waitpoint"("runId", "status");

-- CreateIndex
CREATE INDEX "Waitpoint_tokenId_idx" ON "Waitpoint"("tokenId");

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
