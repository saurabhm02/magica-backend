import { NextResponse } from "next/server";
import { Chat } from "@/contracts/chat";
import { DeleteChatResponse, UpdateChatRequest } from "@/contracts/api";
import { softDeleteChat, toChatDTO, updateChat } from "@/modules/chats/chats";
import { requireUser } from "@/lib/auth";
import { parseInput, readJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ chatId: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  const body = parseInput(UpdateChatRequest, await readJson(req));
  const chat = await updateChat(user.id, chatId, body);
  return NextResponse.json(Chat.parse(toChatDTO(chat)));
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  await softDeleteChat(user.id, chatId);
  return NextResponse.json(DeleteChatResponse.parse({ id: chatId }));
});
