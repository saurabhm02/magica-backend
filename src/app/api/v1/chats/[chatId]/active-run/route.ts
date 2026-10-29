import { NextResponse } from "next/server";
import { ActiveRunResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import type { ChatRouteContext } from "@/lib/types";
import { getActiveAgentRun } from "@/modules/runs/runs";

export const GET = route<ChatRouteContext>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  const result = await getActiveAgentRun(user.id, chatId);
  return NextResponse.json(ActiveRunResponse.parse(result));
});
