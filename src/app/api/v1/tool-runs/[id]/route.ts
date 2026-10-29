import { NextResponse } from "next/server";
import { ToolRunResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getToolRun } from "@/modules/tools/tools";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const res = await getToolRun(user.id, id);
  return NextResponse.json(ToolRunResponse.parse(res));
});
