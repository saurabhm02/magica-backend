-- CreateEnum
CREATE TYPE "ToolRunSource" AS ENUM ('ui', 'api');

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN "source" "ToolRunSource" NOT NULL DEFAULT 'ui';

-- Backfill merge_videos api run from Mintlify docs
UPDATE "ToolInvocation" SET "source" = 'api' WHERE "id" = 'cmvwju4ms000008k0m1d09aww';
