import { NextResponse } from "next/server";
import { CompleteUploadRequest, CompleteUploadResponse } from "@/contracts/attachment";
import { requireUser } from "@/lib/auth";
import { parseInput, readJson, route } from "@/lib/http";
import { completeUpload } from "@/modules/attachments/attachments";

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const body = parseInput(CompleteUploadRequest, await readJson(req));
  const result = await completeUpload(user.id, body.assemblyId);
  return NextResponse.json(CompleteUploadResponse.parse(result));
});
