import { NextResponse } from "next/server";
import { ListToolsResponse } from "@/contracts/api";
import { listPublicTools } from "@/agent/tools/registry";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const GET = route(async (req) => {
  await requireUser(req);
  const tools = listPublicTools();
  return NextResponse.json(ListToolsResponse.parse(tools));
});
