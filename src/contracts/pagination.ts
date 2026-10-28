import { z } from "zod";

export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 50;
export const DEFAULT_PAGE_LIMIT = 20;

export const CursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(MIN_PAGE_LIMIT).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export function Page<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
