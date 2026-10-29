import { NextResponse } from "next/server";
import { CancelRunResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import type { RunRouteContext } from "@/lib/types";
import { cancelAgentRun } from "@/modules/runs/runs";

export const POST = route<RunRouteContext>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId, runId } = await params;
  const result = await cancelAgentRun(user.id, chatId, runId);
  return NextResponse.json(CancelRunResponse.parse(result));
});
