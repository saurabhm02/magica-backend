import { NextResponse } from "next/server";
import { UploadParamsRequest, UploadParamsResponse } from "@/contracts/attachment";
import { requireUser } from "@/lib/auth";
import { parseInput, readJson, route } from "@/lib/http";
import { createUploadParams } from "@/modules/attachments/attachments";

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const body = parseInput(UploadParamsRequest, await readJson(req));
  const result = createUploadParams(user.id, body.files);
  return NextResponse.json(UploadParamsResponse.parse(result));
});
