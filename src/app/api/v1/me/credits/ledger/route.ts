import { NextResponse } from "next/server";
import { ListLedgerQuery, ListLedgerResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getLedger } from "@/modules/credits/credits";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const { searchParams } = new URL(req.url);
  const parsed = ListLedgerQuery.safeParse({
    cursor: searchParams.get("cursor") ?? undefined,
    limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid query", retryable: false } },
      { status: 400 },
    );
  }

  const result = await getLedger(user.id, parsed.data);
  return NextResponse.json(ListLedgerResponse.parse(result));
});
