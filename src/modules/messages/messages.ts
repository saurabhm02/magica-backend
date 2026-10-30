import { Prisma, type Message as PrismaMessage } from "@prisma/client";
import { z } from "zod";
import { ContentBlock } from "@/contracts/content-blocks";
import type { Message } from "@/contracts/message";
import type { SendMessageRequest } from "@/contracts/api";
import { getOwnedChat } from "@/modules/chats/chats";
import { recoverStaleRun } from "@/modules/runs/runs";
import { respondWaitpoint } from "@/modules/waitpoints/waitpoints";
import { db } from "@/lib/db";
import { afterCreatedAtIdCursor, CreatedAtIdCursor, decodeCursor, encodeCursor } from "@/lib/cursor";
import { CHAT_TITLE_MAX_CHARS, DEFAULT_CHAT_TITLE } from "@/lib/constants";
import { AppError } from "@/lib/errors";

export function extractSearchText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) {
      parts.push(b.text.trim());
    }
  }
  return parts.join("\n");
}

export async function listMessages(userId: string, chatId: string, { cursor, limit }: { cursor?: string; limit: number }) {
  await getOwnedChat(userId, chatId);
  const decoded = cursor ? decodeCursor(cursor, CreatedAtIdCursor) : undefined;

  const rows = await db.message.findMany({
    where: { chatId, ...(decoded && { OR: afterCreatedAtIdCursor(decoded) }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items, nextCursor };
}

export async function sendMessage(userId: string, chatId: string, body: SendMessageRequest) {
  const [chat, existing] = await Promise.all([
    getOwnedChat(userId, chatId),
    findSentMessage(chatId, body.clientRequestId),
  ]);
  if (existing) return existing;

  const pendingPlanWaitpoint = await db.waitpoint.findFirst({
    where: {
      run: { chatId, status: "waiting" },
      type: "plan",
      status: "pending",
    },
    include: { run: true },
  });

  if (pendingPlanWaitpoint) {
    const message = await db.message.create({
      data: {
        chatId,
        role: "user",
        status: "complete",
        content: [{ type: "text", text: body.content }],
        searchText: body.content.trim(),
        clientRequestId: body.clientRequestId,
      },
    });

    await respondWaitpoint({
      userId,
      chatId,
      waitpointId: pendingPlanWaitpoint.id,
      body: { request_changes: body.content },
    });

    return { message, run: pendingPlanWaitpoint.run };
  }

  const title = chat.title === DEFAULT_CHAT_TITLE ? deriveTitle(body.content) : undefined;

  const createMessageAndRun = () =>
    db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          chatId,
          role: "user",
          status: "complete",
          content: [{ type: "text", text: body.content }],
          searchText: body.content.trim(),
          clientRequestId: body.clientRequestId,
        },
      });
      const run = await tx.agentRun.create({
        data: {
          chatId,
          userId,
          userMessageId: message.id,
          status: "queued",
          idempotencyKey: body.clientRequestId,
          planMode: body.planMode ?? false,
        },
      });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date(), ...(title && { title }) } });
      return { message, run };
    }, { timeout: 20_000, maxWait: 15_000 });

  try {
    return await createMessageAndRun();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const sameSend = await findSentMessage(chatId, body.clientRequestId);
      if (sameSend) return sameSend;

      const recovered = await recoverStaleRun(chatId);
      if (recovered) {
        return await createMessageAndRun();
      }

      throw new AppError("RUN_ALREADY_ACTIVE", "A reply is already in progress in this chat.", false);
    }
    throw error;
  }
}

async function findSentMessage(chatId: string, clientRequestId: string) {
  const message = await db.message.findUnique({ where: { chatId_clientRequestId: { chatId, clientRequestId } } });
  if (!message) return null;
  const run = await db.agentRun.findFirstOrThrow({ where: { userMessageId: message.id }, orderBy: { createdAt: "desc" } });
  if (run.status === "failed" && !run.triggerRunId) {
    const updated = await db.agentRun.update({
      where: { id: run.id },
      data: { status: "queued", error: Prisma.DbNull, finishedAt: null },
    });
    return { message, run: updated };
  }
  return { message, run };
}

export function deriveTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX_CHARS);
}

export function toMessageDTO(message: PrismaMessage): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    status: message.status,
    content: z.array(ContentBlock).parse(message.content),
    clientRequestId: message.clientRequestId,
    suggestion: message.suggestion ?? undefined,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
