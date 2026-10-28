import { NextResponse } from "next/server";
import { ListMessagesQuery, ListMessagesResponse } from "@/contracts/api";
import { listMessages, toMessageDTO } from "@/modules/messages/messages";
import { requireUser } from "@/lib/auth";
import { parseInput, queryOf, route } from "@/lib/http";

type Ctx = { params: Promise<{ chatId: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  const query = parseInput(ListMessagesQuery, queryOf(req));
  const { items, nextCursor } = await listMessages(user.id, chatId, query);
  return NextResponse.json(ListMessagesResponse.parse({ items: items.map(toMessageDTO), nextCursor }));
});
