import type { Prisma } from "@prisma/client";
import { getTool } from "@/agent/tools/registry";
import type { AssetItem, AssetSource, AssetType } from "@/contracts/api";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";

function readableNameFromGenerated(output: unknown, url: string): string {
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
    if (typeof record.title === "string" && record.title.trim()) return record.title.trim();
    if (typeof record.filename === "string" && record.filename.trim()) return record.filename.trim();
  }
  const filename = url.split("/").pop()?.split("?")[0] ?? "asset";
  return decodeURIComponent(filename) || "asset";
}

function promptFromInput(input: unknown): string | null {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.prompt === "string" && record.prompt.trim()) {
      return record.prompt;
    }
  }
  return null;
}

function uploadToAssetItem(att: {
  id: string;
  url: string;
  kind: string;
  name: string;
  sizeBytes: bigint;
  createdAt: Date;
}): AssetItem {
  return {
    url: att.url,
    type: att.kind as AssetType,
    source: "upload",
    name: att.name,
    sizeBytes: Number(att.sizeBytes),
    prompt: null,
    attachmentId: att.id,
    createdAt: att.createdAt.toISOString(),
  };
}

function toolToAssetItems(
  inv: {
    id: string;
    toolName: string;
    input: unknown;
    output: unknown;
    createdAt: Date;
    run?: { chatId: string } | null;
  },
  type?: AssetType,
): AssetItem[] {
  const tool = getTool(inv.toolName);
  const assets = tool?.assets && inv.output ? tool.assets(inv.output) : [];
  const items: AssetItem[] = [];
  for (const a of assets) {
    if (type && a.type !== type) continue;
    items.push({
      url: a.url,
      type: a.type as AssetType,
      source: "generated",
      name: readableNameFromGenerated(inv.output, a.url),
      sizeBytes: null,
      prompt: promptFromInput(inv.input),
      toolInvocationId: inv.id,
      chatId: inv.run?.chatId ?? "",
      toolName: inv.toolName,
      createdAt: inv.createdAt.toISOString(),
    });
  }
  return items;
}

function compareByCreatedAtDesc(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return b.id.localeCompare(a.id);
}

export async function listAssets(
  userId: string,
  params: { type?: AssetType; source?: AssetSource; cursor?: string; limit: number },
): Promise<{ items: AssetItem[]; nextCursor: string | null; total: number }> {
  const { type, source = "all", cursor, limit } = params;
  const decoded = cursor ? decodeCursor(cursor, CreatedAtIdCursor) : undefined;
  const now = new Date();

  const toolNames = type === "image"
    ? ["crop_image", "gpt_image_2"]
    : type === "video"
    ? ["merge_videos"]
    : ["crop_image", "gpt_image_2", "merge_videos"];

  const toolBaseConditions: Prisma.ToolInvocationWhereInput[] = [
    { status: "succeeded" },
    { toolName: { in: toolNames } },
    {
      OR: [
        { run: { chat: { userId, deletedAt: null } } },
        { userId, runId: null },
      ],
    },
  ];

  const uploadBaseConditions: Prisma.AttachmentWhereInput[] = [
    { userId },
    { source: "upload" },
    { status: "ready" },
    {
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    type ? { kind: type } : { kind: { in: ["image", "video"] } },
  ];

  const toolWhere: Prisma.ToolInvocationWhereInput = {
    AND: decoded
      ? [...toolBaseConditions, { OR: afterCreatedAtIdCursor(decoded) }]
      : toolBaseConditions,
  };

  const uploadWhere: Prisma.AttachmentWhereInput = {
    AND: decoded
      ? [...uploadBaseConditions, { OR: afterCreatedAtIdCursor(decoded) }]
      : uploadBaseConditions,
  };

  // 1. Calculate total for the requested source and type
  let total = 0;
  if (source === "all") {
    const [genCount, upCount] = await Promise.all([
      db.toolInvocation.count({ where: { AND: toolBaseConditions } }),
      db.attachment.count({ where: { AND: uploadBaseConditions } }),
    ]);
    total = genCount + upCount;
  } else if (source === "generated") {
    total = await db.toolInvocation.count({ where: { AND: toolBaseConditions } });
  } else if (source === "uploads") {
    total = await db.attachment.count({ where: { AND: uploadBaseConditions } });
  }

  // 2. Fetch rows and merge
  if (source === "uploads") {
    const rows = await db.attachment.findMany({
      where: uploadWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;
    return {
      items: pageRows.map(uploadToAssetItem),
      nextCursor,
      total,
    };
  }

  if (source === "generated") {
    const rows = await db.toolInvocation.findMany({
      where: toolWhere,
      include: { run: { select: { chatId: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;
    return {
      items: pageRows.flatMap((inv) => toolToAssetItems(inv, type)),
      nextCursor,
      total,
    };
  }

  // source === "all": read both tables with bounded take and keyset merge
  const [toolRows, uploadRows] = await Promise.all([
    db.toolInvocation.findMany({
      where: toolWhere,
      include: { run: { select: { chatId: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    db.attachment.findMany({
      where: uploadWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
  ]);

  const candidateRows = [
    ...toolRows.map((inv) => ({
      createdAt: inv.createdAt,
      id: inv.id,
      items: toolToAssetItems(inv, type),
    })),
    ...uploadRows.map((att) => ({
      createdAt: att.createdAt,
      id: att.id,
      items: [uploadToAssetItem(att)],
    })),
  ];

  candidateRows.sort(compareByCreatedAtDesc);

  const pageItems: AssetItem[] = [];
  let lastRow: { createdAt: Date; id: string } | null = null;
  let hasMore = false;

  for (let i = 0; i < candidateRows.length; i++) {
    const row = candidateRows[i]!;
    if (row.items.length === 0) continue;
    if (pageItems.length + row.items.length <= limit) {
      pageItems.push(...row.items);
      lastRow = row;
    } else {
      hasMore = true;
      break;
    }
  }

  if (!hasMore && lastRow) {
    const lastIndex = candidateRows.findIndex((r) => r.id === lastRow!.id);
    if (lastIndex !== -1 && lastIndex < candidateRows.length - 1) {
      hasMore = candidateRows.slice(lastIndex + 1).some((r) => r.items.length > 0);
    }
  }

  const nextCursor = hasMore && lastRow
    ? encodeCursor({ createdAt: lastRow.createdAt.toISOString(), id: lastRow.id })
    : null;

  return { items: pageItems, nextCursor, total };
}
