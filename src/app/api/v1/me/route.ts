import { NextResponse } from "next/server";
import { MeResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  return NextResponse.json(MeResponse.parse({ id: user.id, createdAt: user.createdAt.toISOString() }));
});
