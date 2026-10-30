import type { Prisma, Waitpoint } from "@prisma/client";
import { metadata, wait } from "@trigger.dev/sdk";
import type { RespondWaitpointInput, WaitpointResponse, WaitpointStatus } from "@/contracts/api";
import type { AnswerItem, Question } from "@/contracts/tools";
import { WAITPOINT_TIMEOUT, WAITPOINT_TIMEOUT_MS } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getOwnedChat } from "@/modules/chats/chats";

export type CreateWaitpointParams = {
  runId: string;
  toolInvocationId: string;
  type?: string;
  input: unknown;
  traceId?: string;
};

export type WaitForWaitpointParams = {
  waitpointId: string;
  tokenId: string;
  runId: string;
  toolInvocationId: string;
  input: unknown;
  traceId?: string;
};

export function formatCreditsM(credits: number): string {
  const m = credits / 1_000_000;
  const s = m.toFixed(4).replace(/\.?0+$/, "");
  return s === "0" ? "0" : s;
}

export function deriveShortTitle(title: string): string {
  if (title.includes("+")) {
    return title
      .split("+")
      .map((part) => part.replace(/\b(product|instagram)\b/gi, "").trim())
      .filter(Boolean)
      .join(" + ");
  }
  return title.slice(0, 30);
}

export function formatWaitpointResponse(waitpoint: Waitpoint): WaitpointResponse {
  const payload = waitpoint.payload as {
    message?: string;
    overview?: string;
    title?: string;
    questions?: unknown[];
    steps?: unknown[];
  } | null;

  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const message = payload?.overview ?? payload?.message ?? payload?.title;

  return {
    id: waitpoint.id,
    type: waitpoint.type,
    status: waitpoint.status as WaitpointStatus,
    message,
    questions,
    payload: (waitpoint.payload as Record<string, unknown>) ?? undefined,
    response: (waitpoint.response as Record<string, unknown>) ?? undefined,
    expiresAt: waitpoint.expiresAt.toISOString(),
  };
}

export async function createWaitpoint(params: CreateWaitpointParams) {
  const { runId, toolInvocationId, type = "options", input, traceId } = params;
  const idempotencyKey = `waitpoint:${runId}:${toolInvocationId}`;

  const existing = await db.waitpoint.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return { waitpoint: existing, tokenId: existing.tokenId };
  }

  const token = await wait.createToken({
    idempotencyKey,
    timeout: WAITPOINT_TIMEOUT,
  });

  const expiresAt = new Date(Date.now() + WAITPOINT_TIMEOUT_MS);

  const waitpoint = await db.waitpoint.create({
    data: {
      runId,
      toolInvocationId,
      type,
      tokenId: token.id,
      status: "pending",
      payload: input as unknown as Prisma.InputJsonValue,
      expiresAt,
      idempotencyKey,
    },
  });

  await db.agentRun.update({
    where: { id: runId },
    data: { status: "waiting" },
  });

  const payload = input as { message?: string; overview?: string; title?: string; questions?: Record<string, unknown>[] } | null;
  const message = payload?.overview ?? payload?.message ?? payload?.title;
  const questions = payload?.questions;

  try {
    metadata.set(
      "waitpoint",
      {
        id: waitpoint.id,
        type,
        message,
        questions: questions ?? [],
        payload: input,
      } as unknown as Parameters<typeof metadata.set>[1],
    );
  } catch {
    // metadata only works inside active Trigger task execution
  }

  logger.info("waitpoint created", {
    runId,
    toolInvocationId,
    waitpointId: waitpoint.id,
    waitpointTokenId: token.id,
    type,
    traceId,
  });

  return { waitpoint, tokenId: token.id };
}

export async function waitForWaitpoint<T = unknown>(params: WaitForWaitpointParams): Promise<T> {
  const { waitpointId, tokenId, runId, toolInvocationId, input, traceId } = params;

  let result: { ok: boolean; output?: Record<string, unknown>; error?: unknown };
  try {
    result = await wait.forToken<Record<string, unknown>>(tokenId);
  } catch (err) {
    result = { ok: false, error: err };
  }

  if (!result.ok) {
    await db.waitpoint.updateMany({
      where: { id: waitpointId, status: "pending" },
      data: { status: "expired" },
    });

    try {
      metadata.del("waitpoint");
    } catch {}

    logger.warn("waitpoint expired", {
      runId,
      toolInvocationId,
      waitpointId,
      waitpointTokenId: tokenId,
      traceId,
    });

    throw new AppError("WAITPOINT_EXPIRED", "Waiting for input timed out. You can reply anytime in the chat to continue.", false);
  }

  const fresh = await db.waitpoint.findUnique({
    where: { id: waitpointId },
  });

  const resData = (fresh?.response as Record<string, unknown> | null) ?? result.output ?? {};

  await db.agentRun.update({
    where: { id: runId },
    data: { status: "running" },
  });

  try {
    metadata.del("waitpoint");
    metadata.set("status", "working");
  } catch {}

  logger.info("waitpoint resumed", {
    runId,
    toolInvocationId,
    waitpointId,
    waitpointTokenId: tokenId,
    status: fresh?.status ?? "answered",
    action: resData.action,
    traceId,
  });

  // If options type or has answers/skip
  if (fresh?.type === "options" || resData.answers || resData.skip) {
    const isSkipped = resData.skip === true || fresh?.status === "skipped";
    let answers: AnswerItem[];
    if (isSkipped) {
      const qList = (input as { questions?: Question[] })?.questions ?? [];
      answers = qList.map((q) => ({
        questionId: q.id,
        question: q.question,
        answer: "skipped",
      }));
    } else {
      answers = (resData.answers as AnswerItem[]) ?? [];
    }
    return { answers } as unknown as T;
  }

  return resData as unknown as T;
}

export async function respondWaitpoint({
  userId,
  chatId,
  waitpointId,
  body,
}: {
  userId: string;
  chatId: string;
  waitpointId: string;
  body: RespondWaitpointInput;
}) {
  await getOwnedChat(userId, chatId);

  const waitpoint = await db.waitpoint.findFirst({
    where: {
      id: waitpointId,
      run: {
        chatId,
        chat: { userId },
      },
    },
    include: {
      run: true,
    },
  });

  if (!waitpoint) {
    throw new AppError("NOT_FOUND", "Waitpoint not found", false);
  }

  if (waitpoint.status === "answered" || waitpoint.status === "skipped") {
    const saved = waitpoint.response as Record<string, unknown> | null;
    const payload = waitpoint.payload as { questions?: Question[] } | null;
    let answers: AnswerItem[] | undefined = (saved?.answers as AnswerItem[]) ?? undefined;
    if (waitpoint.status === "skipped" && (!answers || answers.length === 0) && payload?.questions) {
      answers = payload.questions.map((q) => ({
        questionId: q.id,
        question: q.question,
        answer: "skipped",
      }));
    }
    return {
      id: waitpoint.id,
      status: waitpoint.status as WaitpointStatus,
      action: (saved?.action as string) ?? undefined,
      feedback: (saved?.feedback as string) ?? undefined,
      answers,
    };
  }

  if (waitpoint.status === "expired") {
    throw new AppError("WAITPOINT_EXPIRED", "Waitpoint has expired", false);
  }

  let action: string | undefined;
  let feedback: string | undefined;
  let responseData: Record<string, unknown>;
  const isSkip = body.skip === true;

  if (body.request_changes) {
    action = "request_changes";
    feedback = body.request_changes;
    responseData = { action, feedback, request_changes: body.request_changes };
  } else if (body.action === "run_all") {
    action = "run_all";
    responseData = { action };
  } else if (body.action === "step_by_step") {
    action = "step_by_step";
    responseData = { action };
  } else if (isSkip) {
    action = "skipped";
    const payload = waitpoint.payload as { questions?: Question[] } | null;
    const answers = (payload?.questions ?? []).map((q) => ({
      questionId: q.id,
      question: q.question,
      answer: "skipped",
    }));
    responseData = { skip: true, answers };
  } else {
    action = "answered";
    responseData = { answers: body.answers ?? [] };
  }

  const newStatus: WaitpointStatus = isSkip ? "skipped" : "answered";

  const updated = await db.waitpoint.updateMany({
    where: { id: waitpoint.id, status: "pending" },
    data: {
      status: newStatus,
      response: responseData as unknown as Prisma.InputJsonValue,
    },
  });

  if (updated.count === 1) {
    try {
      await wait.completeToken(waitpoint.tokenId, responseData);
    } catch (err) {
      logger.warn("wait.completeToken threw or token was already completed", {
        waitpointId: waitpoint.id,
        waitpointTokenId: waitpoint.tokenId,
        detail: String(err),
      });
    }
  }

  logger.info("waitpoint responded", {
    chatId,
    runId: waitpoint.runId,
    waitpointId: waitpoint.id,
    waitpointTokenId: waitpoint.tokenId,
    status: newStatus,
    action,
  });

  return {
    id: waitpoint.id,
    status: newStatus,
    action,
    feedback,
    answers: responseData.answers as AnswerItem[] | undefined,
  };
}

export async function getPendingWaitpointForRun(runId: string): Promise<WaitpointResponse | null> {
  const waitpoint = await db.waitpoint.findFirst({
    where: {
      runId,
      status: "pending",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!waitpoint) return null;
  return formatWaitpointResponse(waitpoint);
}
