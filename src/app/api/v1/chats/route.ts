import { NextResponse } from "next/server";
import { Chat } from "@/contracts/chat";
import { CreateChatRequest, ListChatsQuery, ListChatsResponse } from "@/contracts/api";
import { createChat, listChats, toChatDTO } from "@/modules/chats/chats";
import { requireUser } from "@/lib/auth";
import { parseInput, queryOf, readJson, route } from "@/lib/http";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const query = parseInput(ListChatsQuery, queryOf(req));
  const { items, nextCursor } = await listChats(user.id, query);
  return NextResponse.json(ListChatsResponse.parse({ items: items.map(toChatDTO), nextCursor }));
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const body = parseInput(CreateChatRequest, await readJson(req));
  const chat = await createChat(user.id, body.title);
  return NextResponse.json(Chat.parse(toChatDTO(chat)), { status: 201 });
});
