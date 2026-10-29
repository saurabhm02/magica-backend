import type { AssetItem, AssetType } from "@/contracts/api";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { getTool } from "@/agent/tools/registry";

export async function listAssets(
  userId: string,
  params: { type?: AssetType; cursor?: string; limit: number },
): Promise<{ items: AssetItem[]; nextCursor: string | null }> {
  const { type, cursor, limit } = params;
  const decoded = cursor ? decodeCursor(cursor, CreatedAtIdCursor) : undefined;

  const rows = await db.toolInvocation.findMany({
    where: {
      status: "succeeded",
      run: { chat: { userId, deletedAt: null } },
      ...(decoded && { OR: afterCreatedAtIdCursor(decoded) }),
    },
    include: {
      run: { select: { chatId: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageItems = hasMore ? rows.slice(0, limit) : rows;
  const last = pageItems.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  const items: AssetItem[] = [];
  for (const inv of pageItems) {
    const tool = getTool(inv.toolName);
    const assets = tool?.assets && inv.output ? tool.assets(inv.output) : [];
    for (const a of assets) {
      if (type && a.type !== type) continue;
      items.push({
        url: a.url,
        type: a.type as AssetType,
        chatId: inv.run?.chatId ?? "",
        toolName: inv.toolName,
        createdAt: inv.createdAt.toISOString(),
      });
    }
  }

  return { items, nextCursor };
}
