-- AlterTable
ALTER TABLE "ToolInvocation" ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE "ToolInvocation" ADD COLUMN "userId" TEXT;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill userId from AgentRun for existing rows
UPDATE "ToolInvocation" ti SET "userId" = ar."userId" FROM "AgentRun" ar WHERE ti."runId" = ar.id;

-- CreateIndex
CREATE INDEX "ToolInvocation_userId_toolName_createdAt_id_idx" ON "ToolInvocation"("userId", "toolName", "createdAt" DESC, "id" DESC);
