-- Ensure any orphaned rows have a valid userId from AgentRun or are cleaned up
UPDATE "ToolInvocation" ti SET "userId" = ar."userId" FROM "AgentRun" ar WHERE ti."runId" = ar.id AND ti."userId" IS NULL;
DELETE FROM "ToolInvocation" WHERE "userId" IS NULL;

-- AlterTable
ALTER TABLE "ToolInvocation" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "ToolInvocation" ADD COLUMN IF NOT EXISTS "triggerRunId" TEXT;
