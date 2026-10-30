import { NextResponse } from "next/server";
import { GetRunResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getRun } from "@/modules/runs/runs";

export const GET = route<{ params: Promise<{ runId: string }> }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { runId } = await params;
  const res = await getRun(user.id, runId);
  return NextResponse.json(GetRunResponse.parse(res));
});
