import { NextResponse } from "next/server";
import { ListAssetsQuery, ListAssetsResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { parseInput, queryOf, route } from "@/lib/http";
import { listAssets } from "@/modules/assets/assets";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const query = parseInput(ListAssetsQuery, queryOf(req));
  const result = await listAssets(user.id, query);
  return NextResponse.json(ListAssetsResponse.parse(result));
});
