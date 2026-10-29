-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('grant', 'reserve', 'settle', 'refund');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "chargedCredits" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN     "credits" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditBalance" BIGINT NOT NULL DEFAULT 30000000;

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "toolInvocationId" TEXT,
    "type" "LedgerType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_id_idx" ON "CreditLedger"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "CreditLedger_runId_idx" ON "CreditLedger"("runId");

-- CreateIndex
CREATE INDEX "CreditLedger_toolInvocationId_idx" ON "CreditLedger"("toolInvocationId");

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
