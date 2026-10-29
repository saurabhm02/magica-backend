import { z } from "zod";
import { AppError } from "@/lib/errors";

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor", false);
  }
}

export const CreatedAtIdCursor = z.object({
  createdAt: z.iso.datetime(),
  id: z.string(),
});
export type CreatedAtIdCursor = z.infer<typeof CreatedAtIdCursor>;

export function afterCreatedAtIdCursor(cursor: CreatedAtIdCursor) {
  const createdAt = new Date(cursor.createdAt);
  return [
    { createdAt: { lt: createdAt } },
    { createdAt, id: { lt: cursor.id } },
  ];
}
