-- AlterTable
ALTER TABLE "Message" ADD COLUMN "searchText" TEXT;

-- Backfill searchText from text blocks in content
UPDATE "Message"
SET "searchText" = (
  SELECT string_agg(elem->>'text', E'\n')
  FROM jsonb_array_elements("content"::jsonb) elem
  WHERE elem->>'type' = 'text' AND (elem->>'text') IS NOT NULL AND length(trim(elem->>'text')) > 0
)
WHERE "searchText" IS NULL AND "content" IS NOT NULL;

-- CreateExtension
CREATE EXTENSION pg_trgm;

-- CreateIndex
CREATE INDEX "Chat_title_trgm_idx" ON "Chat" USING gin ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Message_searchText_trgm_idx" ON "Message" USING gin ("searchText" gin_trgm_ops);
