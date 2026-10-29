import { NextResponse } from "next/server";
import { CreateToolRunRequest, CreateToolRunResponse, ListToolRunsQuery, ListToolRunsResponse } from "@/contracts/api";
import { parseInput, queryOf, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { listToolRuns, startToolRun } from "@/modules/tools/tools";

export const POST = route<{ params: Promise<{ name: string }> }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { name } = await params;
  const body = parseInput(CreateToolRunRequest, await readJson(req));
  const res = await startToolRun(user, name, body.input);
  return NextResponse.json(CreateToolRunResponse.parse(res));
});

export const GET = route<{ params: Promise<{ name: string }> }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { name } = await params;
  const query = parseInput(ListToolRunsQuery, queryOf(req));
  const res = await listToolRuns(user.id, name, query);
  return NextResponse.json(ListToolRunsResponse.parse(res));
});
