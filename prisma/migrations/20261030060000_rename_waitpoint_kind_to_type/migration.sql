-- Keep existing rows: rename the column instead of drop + add.
ALTER TABLE "Waitpoint" RENAME COLUMN "kind" TO "type";
