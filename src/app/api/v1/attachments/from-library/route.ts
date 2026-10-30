import { NextResponse } from "next/server";
import { CreateLibraryAttachmentRequest, CreateLibraryAttachmentResponse } from "@/contracts/attachment";
import { requireUser } from "@/lib/auth";
import { parseInput, readJson, route } from "@/lib/http";
import { createLibraryAttachment } from "@/modules/attachments/attachments";

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const body = parseInput(CreateLibraryAttachmentRequest, await readJson(req));
  const attachment = await createLibraryAttachment(user.id, body);
  return NextResponse.json(CreateLibraryAttachmentResponse.parse(attachment), { status: 201 });
});
