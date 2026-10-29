import type { Prisma } from "@prisma/client";
import { runs } from "@trigger.dev/sdk";
import type { z } from "zod";
import { getTool } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import { CREDIT_RESERVE_MULTIPLIER, GENERIC_SAFE_MESSAGE, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  isMagicaTool,
  type LlmMessage,
  type MagicaTool,
  type Tool,
  type ToolCall,
  type ToolContext,
} from "@/lib/types";
import { refundCredits, reserveCredits, settleCredits } from "@/modules/credits/credits";
import { magicaRun } from "@/trigger/magica-run";

type ToolMeta = NonNullable<RunMetadata["tools"]>[number];
type AssetMeta = NonNullable<RunMetadata["assets"]>[number];

export type ExecuteTurnToolsParams = {
  runId: string;
  userId: string;
  traceId: string;
  signal: AbortSignal;
  toolCalls: ToolCall[];
  toolsMetadata: ToolMeta[];
  assetsMetadata: AssetMeta[];
  onMetadataChange: () => void;
};

export type ExecuteTurnToolsResult = {
  contentBlocks: ContentBlock[];
  toolMessages: LlmMessage[];
  insufficientCreditsError?: SafeError;
};

function formatZodError(toolName: string, error: z.ZodError): string {
  const first = error.issues[0];
  const field = first?.path.length ? first.path.join(".") : "arguments";
  return `Invalid input for ${toolName}: ${field}`;
}

function extractAssets(tool: Tool, output: unknown, toolInvocationId: string, assetsMetadata: AssetMeta[]) {
  if (!tool.assets || !output) return;
  try {
    const assets = tool.assets(output);
    for (const asset of assets) {
      if (asset.url) {
        assetsMetadata.push({ type: asset.type, url: asset.url, toolInvocationId });
      }
    }
  } catch (err) {
    logger.warn("failed to extract assets from tool output", { toolInvocationId, detail: String(err) });
  }
}

export async function executeTurnTools(params: ExecuteTurnToolsParams): Promise<ExecuteTurnToolsResult> {
  const { runId, userId, traceId, signal, toolCalls, toolsMetadata, assetsMetadata, onMetadataChange } = params;

  if (signal.aborted) {
    return { contentBlocks: [], toolMessages: [] };
  }

  const prepared = await Promise.all(
    toolCalls.map(async (tc, index) => {
      let rawInput: Record<string, unknown> = {};
      try {
        rawInput = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        //noting for now
        console.log("Error while prepareing the tools");
      }

      const tool = getTool(tc.name);
      const renderKey = tool?.renderKey ?? tc.name;
      const order = tc.order ?? index;
      const desc = tool ? tool.describe(rawInput) : undefined;

      const record = await db.toolInvocation.create({
        data: {
          runId,
          toolCallId: tc.id,
          order,
          toolName: tc.name,
          status: "pending",
          input: rawInput as Prisma.InputJsonValue,
          idempotencyKey: `tool:${runId}:${tc.id}`,
        },
      });

      toolsMetadata.push({
        id: record.id,
        name: tc.name,
        status: "pending",
        startedAt: new Date().toISOString(),
        renderKey,
        label: desc?.label,
        doneLabel: desc?.doneLabel,
        detail: desc?.detail,
        fields: desc?.fields,
        model: desc?.model,
      });

      return { tc, rawInput, record, tool, order, desc };
    }),
  );

  onMetadataChange();

  type PreparedItem = (typeof prepared)[number];
  type InvocationResult = {
    tc: ToolCall;
    rawInput: Record<string, unknown>;
    output?: unknown;
    toolError?: SafeError;
    order: number;
    credits?: number;
    durationMs?: number;
    desc?: NonNullable<PreparedItem["desc"]>;
  };

  const results: InvocationResult[] = [];
  const magicaBatch: Array<{
    item: PreparedItem;
    tool: MagicaTool;
    params: Record<string, unknown>;
    subModelId?: string;
    estimate: number;
    reserveAmount: number;
  }> = [];

  let insufficientCreditsError: SafeError | undefined;

  for (const p of prepared) {
    const { tc, rawInput, record, tool, order } = p;
    if (!tool) {
      logger.warn("unknown tool called", { runId, toolInvocationId: record.id, name: tc.name });
      results.push({
        tc,
        rawInput,
        order,
        toolError: { code: "TOOL_INPUT_INVALID", message: `Unknown tool: ${tc.name}`, retryable: false },
      });
      continue;
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const message = formatZodError(tc.name, parsed.error);
      results.push({
        tc,
        rawInput,
        order,
        toolError: { code: "TOOL_INPUT_INVALID", message, retryable: false },
      });
      continue;
    }

    const estimate = tool.estimateCredits(parsed.data);
    const reserveAmount = Math.round(estimate * CREDIT_RESERVE_MULTIPLIER);

    try {
      if (reserveAmount > 0) {
        await reserveCredits({
          userId,
          runId,
          toolInvocationId: record.id,
          amount: reserveAmount,
        });
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "INSUFFICIENT_CREDITS") {
        logger.warn("insufficient credits for tool", { runId, toolInvocationId: record.id, name: tc.name });
        const toolError: SafeError = { code: "INSUFFICIENT_CREDITS", message: err.message, retryable: false };
        await db.toolInvocation.update({
          where: { id: record.id },
          data: { status: "failed", error: toolError as unknown as Prisma.InputJsonValue },
        });
        const meta = toolsMetadata.find((m) => m.id === record.id);
        if (meta) {
          meta.status = "failed";
          meta.finishedAt = new Date().toISOString();
        }
        results.push({ tc, rawInput, order, toolError, desc: p.desc });
        insufficientCreditsError = toolError;
        break;
      }
      throw err;
    }

    if (isMagicaTool(tool)) {
      try {
        const subModelId = tool.magica.subModelId?.(parsed.data);
        const inputParams = tool.magica.buildInput(parsed.data);
        magicaBatch.push({ item: p, tool, params: inputParams, subModelId, estimate, reserveAmount });
      } catch (err) {
        logger.error("tool buildInput failed", { runId, toolInvocationId: record.id, detail: String(err) });
        if (reserveAmount > 0) {
          await refundCredits({ userId, runId, toolInvocationId: record.id, amount: reserveAmount });
        }
        const toolError: SafeError =
          err instanceof AppError
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : { code: "TOOL_INPUT_INVALID", message: GENERIC_SAFE_MESSAGE, retryable: false };
        results.push({ tc, rawInput, order, toolError });
      }
    } else {
      const startTime = Date.now();
      await db.toolInvocation.update({ where: { id: record.id }, data: { status: "running" } });
      const meta = toolsMetadata.find((m) => m.id === record.id);
      if (meta) meta.status = "running";
      onMetadataChange();

      try {
        const ctx: ToolContext = { runId, userId, toolInvocationId: record.id, signal, traceId, order };
        const output = await tool.execute(parsed.data, ctx);
        const durationMs = Date.now() - startTime;
        if (reserveAmount > 0 || estimate > 0) {
          await settleCredits({
            userId,
            runId,
            toolInvocationId: record.id,
            estimate: reserveAmount,
            actualCreditUsed: estimate,
          });
        }
        await db.toolInvocation.update({
          where: { id: record.id },
          data: { status: "succeeded", output: output as Prisma.InputJsonValue, durationMs, credits: BigInt(estimate) },
        });
        if (meta) {
          meta.status = "succeeded";
          meta.finishedAt = new Date().toISOString();
          meta.credits = estimate;
        }
        extractAssets(tool, output, record.id, assetsMetadata);
        results.push({ tc, rawInput, order, output, credits: estimate, durationMs, desc: p.desc });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        logger.error("local tool failed", { runId, toolInvocationId: record.id, detail: String(err) });
        if (reserveAmount > 0) {
          await refundCredits({
            userId,
            runId,
            toolInvocationId: record.id,
            amount: reserveAmount,
          });
        }
        const toolError: SafeError =
          err instanceof AppError
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : { code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, retryable: false };
        await db.toolInvocation.update({
          where: { id: record.id },
          data: { status: "failed", error: toolError as unknown as Prisma.InputJsonValue, durationMs },
        });
        if (meta) {
          meta.status = "failed";
          meta.finishedAt = new Date().toISOString();
        }
        results.push({ tc, rawInput, order, toolError, durationMs, desc: p.desc });
      }
    }
  }

  if (insufficientCreditsError && magicaBatch.length > 0) {
    for (const b of magicaBatch) {
      if (b.reserveAmount > 0) {
        await refundCredits({ userId, runId, toolInvocationId: b.item.record.id, amount: b.reserveAmount });
      }
      await db.toolInvocation.update({
        where: { id: b.item.record.id },
        data: { status: "failed", error: insufficientCreditsError as unknown as Prisma.InputJsonValue },
      });
      const m = toolsMetadata.find((meta) => meta.id === b.item.record.id);
      if (m) {
        m.status = "failed";
        m.finishedAt = new Date().toISOString();
      }
      results.push({
        tc: b.item.tc,
        rawInput: b.item.rawInput,
        order: b.item.order,
        toolError: insufficientCreditsError,
        desc: b.item.desc,
      });
    }
    magicaBatch.length = 0;
  }

  if (magicaBatch.length > 0) {
    for (const batchItem of magicaBatch) {
      const meta = toolsMetadata.find((m) => m.id === batchItem.item.record.id);
      if (meta) meta.status = "running";
    }
    await db.toolInvocation.updateMany({
      where: { id: { in: magicaBatch.map((b) => b.item.record.id) } },
      data: { status: "running" },
    });
    onMetadataChange();

    const batchStart = Date.now();
    const batchPayloads = magicaBatch.map((b) => ({
      payload: {
        toolInvocationId: b.item.record.id,
        nodeType: b.tool.magica.nodeType,
        subModelId: b.subModelId,
        params: b.params,
      },
    }));

    let batchRuns: Array<{ id: string; ok: boolean; output?: Record<string, unknown>; creditUsed?: number; error?: unknown }>;
    try {
      const batch = await magicaRun.batchTriggerAndWait(batchPayloads);
      if (signal.aborted && batch?.runs) {
        for (const r of batch.runs) {
          if (!r.ok) {
            runs.cancel(r.id).catch(() => {});
          }
        }
      }
      batchRuns = batch.runs.map((r) => {
        if (!r.ok) {
          return { id: r.id, ok: false, error: r.error };
        }
        const taskResult = r.output as { ok: boolean; output?: Record<string, unknown>; creditUsed?: number; error?: SafeError };
        if (!taskResult || !taskResult.ok) {
          return { id: r.id, ok: false, error: taskResult?.error };
        }
        return { id: r.id, ok: true, output: taskResult.output, creditUsed: taskResult.creditUsed };
      });
    } catch (batchErr) {
      logger.error("magicaRun.batchTriggerAndWait threw", { runId, detail: String(batchErr) });
      const safeMsg =
        batchErr instanceof AppError ? batchErr.message : SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED;
      batchRuns = batchPayloads.map((p) => ({
        id: p.payload.toolInvocationId,
        ok: false,
        error: new AppError("MAGICA_RUN_FAILED", safeMsg, false),
      }));
    }

    const durationMs = Date.now() - batchStart;

    for (const [i, batchItem] of magicaBatch.entries()) {
      const runRes = batchRuns[i];
      const { item, tool, estimate, reserveAmount } = batchItem;
      const meta = toolsMetadata.find((m) => m.id === item.record.id);

      let output: unknown;
      let toolError: SafeError | undefined;

      if (!runRes || !runRes.ok) {
        const err = runRes?.error;
        logger.error("magica tool run failed", { runId, toolInvocationId: item.record.id, detail: String(err) });
        if (err && typeof err === "object" && "code" in err && "message" in err) {
          toolError = err as SafeError;
        } else if (err instanceof AppError) {
          toolError = { code: err.code, message: err.message, retryable: err.retryable };
        } else {
          toolError = { code: "MAGICA_RUN_FAILED", message: SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, retryable: false };
        }
      } else {
        const parsedOutput = tool.magica.outputSchema.safeParse(runRes.output ?? {});
        if (!parsedOutput.success) {
          logger.error("magica output shape mismatch", {
            runId,
            toolInvocationId: item.record.id,
            detail: JSON.stringify(parsedOutput.error.format()),
          });
          toolError = {
            code: "MAGICA_RUN_FAILED",
            message: SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED,
            retryable: false,
          };
        } else {
          output = parsedOutput.data;
        }
      }

      const creditUsed = runRes?.ok && typeof runRes.creditUsed === "number" ? runRes.creditUsed : (output ? estimate : 0);
      const isCancelled = signal.aborted && (!runRes || !runRes.ok);
      const finalStatus = isCancelled ? "cancelled" : toolError ? "failed" : "succeeded";

      if (finalStatus === "succeeded") {
        if (reserveAmount > 0 || creditUsed > 0) {
          await settleCredits({
            userId,
            runId,
            toolInvocationId: item.record.id,
            estimate: reserveAmount,
            actualCreditUsed: creditUsed,
          });
        }
      } else {
        if (reserveAmount > 0) {
          await refundCredits({
            userId,
            runId,
            toolInvocationId: item.record.id,
            amount: reserveAmount,
          });
        }
      }

      const savedOutput =
        output && typeof output === "object"
          ? ({ ...(output as Record<string, unknown>), ...(creditUsed !== undefined ? { creditUsed } : {}) } as Prisma.InputJsonValue)
          : (output as Prisma.InputJsonValue);

      await db.toolInvocation.update({
        where: { id: item.record.id },
        data: {
          status: finalStatus,
          output: output ? savedOutput : undefined,
          error: toolError ? (toolError as unknown as Prisma.InputJsonValue) : undefined,
          durationMs,
          credits: finalStatus === "succeeded" ? BigInt(creditUsed) : 0n,
        },
      });

      if (meta) {
        meta.status = finalStatus;
        meta.finishedAt = new Date().toISOString();
        if (finalStatus === "succeeded") {
          meta.credits = creditUsed;
        }
      }

      if (output) {
        extractAssets(tool, output, item.record.id, assetsMetadata);
      }

      results.push({
        tc: item.tc,
        rawInput: item.rawInput,
        order: item.order,
        output,
        toolError,
        credits: finalStatus === "succeeded" ? creditUsed : undefined,
        durationMs,
        desc: item.desc,
      });
    }
  }

  results.sort((a, b) => a.order - b.order);

  const contentBlocks: ContentBlock[] = [];
  const toolMessages: LlmMessage[] = [];

  for (const res of results) {
    contentBlocks.push({
      type: "tool_use",
      id: res.tc.id,
      name: res.tc.name,
      input: res.rawInput,
      label: res.desc?.label,
      doneLabel: res.desc?.doneLabel,
      detail: res.desc?.detail,
      fields: res.desc?.fields,
      model: res.desc?.model,
    });
    contentBlocks.push({
      type: "tool_result",
      toolUseId: res.tc.id,
      output: res.output,
      error: res.toolError,
      credits: res.credits,
      durationMs: res.durationMs,
    });
    toolMessages.push({
      role: "tool",
      tool_call_id: res.tc.id,
      content: res.toolError ? JSON.stringify({ error: res.toolError.message }) : JSON.stringify(res.output ?? {}),
    });
  }

  onMetadataChange();

  return { contentBlocks, toolMessages, insufficientCreditsError };
}
