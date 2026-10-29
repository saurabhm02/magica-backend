-- CreateTable
CREATE TABLE "RunSkill" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunSkill_runId_idx" ON "RunSkill"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunSkill_runId_skillName_key" ON "RunSkill"("runId", "skillName");

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
