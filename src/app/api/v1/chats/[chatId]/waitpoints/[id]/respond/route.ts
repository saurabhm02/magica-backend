import { NextResponse } from "next/server";
import { RespondWaitpointInput, RespondWaitpointResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { respondWaitpoint } from "@/modules/waitpoints/waitpoints";

export const POST = route<{ params: Promise<{ chatId: string; id: string }> }>(
  async (req, { params }) => {
    const user = await requireUser(req);
    const { chatId, id } = await params;
    const body = RespondWaitpointInput.parse(await req.json());
    const result = await respondWaitpoint({
      userId: user.id,
      chatId,
      waitpointId: id,
      body,
    });
    return NextResponse.json(RespondWaitpointResponse.parse(result));
  },
);
