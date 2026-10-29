import { NextResponse } from "next/server";
import { ListLedgerQuery, ListLedgerResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { parseInput, queryOf, route } from "@/lib/http";
import { getLedger } from "@/modules/credits/credits";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const query = parseInput(ListLedgerQuery, queryOf(req));
  const result = await getLedger(user.id, query);
  return NextResponse.json(ListLedgerResponse.parse(result));
});
