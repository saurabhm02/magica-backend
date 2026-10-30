import { NextResponse } from "next/server";
import { EstimateToolRequest, EstimateToolResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { parseInput, readJson, route } from "@/lib/http";
import { estimateTool } from "@/modules/tools/tools";

export const POST = route<{ params: Promise<{ name: string }> }>(async (req, { params }) => {
  await requireUser(req);
  const { name } = await params;
  const body = parseInput(EstimateToolRequest, await readJson(req));
  const res = await estimateTool(name, body.input);
  return NextResponse.json(EstimateToolResponse.parse(res));
});
