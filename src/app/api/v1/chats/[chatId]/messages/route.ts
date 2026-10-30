import { NextResponse } from "next/server";
import { ListMessagesQuery, ListMessagesResponse, SendMessageRequest, SendMessageResponse } from "@/contracts/api";
import { listMessages, sendMessage, toMessageDTO } from "@/modules/messages/messages";
import { dispatchRun } from "@/modules/runs/runs";
import { requireUser } from "@/lib/auth";
import type { ChatRouteContext } from "@/lib/types";
import { parseInput, queryOf, readJson, route } from "@/lib/http";

export const GET = route<ChatRouteContext>(async (req, { params }) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  const query = parseInput(ListMessagesQuery, queryOf(req));
  const { items, nextCursor } = await listMessages(user.id, chatId, query);
  return NextResponse.json(ListMessagesResponse.parse({ items: items.map(toMessageDTO), nextCursor }));
});

export const POST = route<ChatRouteContext>(async (req, { params }, traceId) => {
  const user = await requireUser(req);
  const { chatId } = await params;
  const body = parseInput(SendMessageRequest, await readJson(req));
  const { message, run, signingSecret } = await sendMessage(user.id, chatId, body);
  const { runId, accessToken } = await dispatchRun(run, traceId);
  return NextResponse.json(
    SendMessageResponse.parse({
      chatId,
      messageId: message.id,
      runId: run.id,
      realtime: { runId, accessToken },
      webhook: signingSecret ? { signingSecret } : undefined,
    }),
    { status: 201 },
  );
});
