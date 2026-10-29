import type { Prisma } from "@prisma/client";
import { runs } from "@trigger.dev/sdk";
import type { z } from "zod";
import { getTool } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import { CREDIT_RESERVE_MULTIPLIER, GENERIC_SAFE_MESSAGE, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError, toSafeError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  isMagicaTool,
  type LlmMessage,
  type LocalTool,
  type MagicaTool,
  type Tool,
  type ToolCall,
} from "@/lib/types";
import { reserveCredits } from "@/modules/credits/credits";
import { finishToolInvocation } from "@/modules/tools/tools";
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

type Outcome =
  | { ok: true; output: unknown; creditUsed: number }
  | { ok: false; error: SafeError; creditUsed?: number };

type PreparedCall = {
  toolCall: ToolCall;
  order: number;
  record: { id: string };
  tool?: Tool;
  parsedInput?: unknown;
  rawInput: Record<string, unknown>;
  display?: ReturnType<Tool["describe"]>;
  reserveAmount: number;
  durationMs?: number;
  magicaPayload?: { params: Record<string, unknown>; subModelId?: string };
  outcome?: Outcome;
};

const formatZodError = (name: string, err: z.ZodError) =>
  `Invalid input for ${name}: ${err.issues[0]?.path.join(".") || "arguments"}`;

function extractAssets(tool: Tool, output: unknown, toolInvocationId: string, meta: AssetMeta[]) {
  if (!tool.assets || !output) return;
  try {
    for (const a of tool.assets(output)) {
      if (a.url) meta.push({ type: a.type, url: a.url, toolInvocationId });
    }
  } catch (err) {
    logger.warn("failed to extract assets", { toolInvocationId, detail: String(err) });
  }
}

export async function executeTurnTools(params: ExecuteTurnToolsParams): Promise<ExecuteTurnToolsResult> {
  const { runId, userId, traceId, signal, toolCalls, toolsMetadata, assetsMetadata, onMetadataChange } = params;

  if (signal.aborted) return { contentBlocks: [], toolMessages: [] };

  const setStep = (id: string, patch: Partial<ToolMeta>) => {
    const step = toolsMetadata.find((s) => s.id === id);
    if (step) {
      Object.assign(step, patch);
      onMetadataChange();
    }
  };

  async function prepareToolCall(toolCall: ToolCall, index: number): Promise<PreparedCall> {
    let rawInput: Record<string, unknown> = {};
    let jsonError = false;
    if (toolCall.arguments) {
      try {
        rawInput = JSON.parse(toolCall.arguments);
      } catch {
        jsonError = true;
      }
    }

    const tool = getTool(toolCall.name);
    const order = toolCall.order ?? index;
    const display = tool && !jsonError ? tool.describe(rawInput) : undefined;

    const record = await db.toolInvocation.create({
      data: {
        runId,
        userId,
        toolCallId: toolCall.id,
        order,
        toolName: toolCall.name,
        status: "pending",
        input: rawInput as Prisma.InputJsonValue,
        idempotencyKey: `tool:${runId}:${toolCall.id}`,
      },
    });

    toolsMetadata.push({
      id: record.id,
      name: toolCall.name,
      status: "pending",
      startedAt: new Date().toISOString(),
      renderKey: tool?.renderKey ?? toolCall.name,
      label: display?.label,
      doneLabel: display?.doneLabel,
      detail: display?.detail,
      fields: display?.fields,
      model: display?.model,
    });
    onMetadataChange();

    const fail = (error: SafeError, reserveAmount = 0): PreparedCall => ({
      toolCall,
      order,
      record,
      rawInput,
      display,
      reserveAmount,
      outcome: { ok: false, error },
    });

    if (jsonError) return fail({ code: "TOOL_INPUT_INVALID", message: "arguments are not valid JSON", retryable: false });
    if (!tool) {
      logger.warn("unknown tool called", { runId, toolInvocationId: record.id, name: toolCall.name });
      return fail({ code: "TOOL_INPUT_INVALID", message: `Unknown tool: ${toolCall.name}`, retryable: false });
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) return fail({ code: "TOOL_INPUT_INVALID", message: formatZodError(toolCall.name, parsed.error), retryable: false });

    const estimate = await tool.estimateCredits(parsed.data);
    const reserveAmount = Math.round(estimate * CREDIT_RESERVE_MULTIPLIER);
    if (reserveAmount > 0) {
      try {
        await reserveCredits({ userId, runId, toolInvocationId: record.id, amount: reserveAmount });
      } catch (err) {
        if (err instanceof AppError && err.code === "INSUFFICIENT_CREDITS") {
          logger.warn("insufficient credits for tool", { runId, toolInvocationId: record.id, name: toolCall.name });
          return fail({ code: "INSUFFICIENT_CREDITS", message: err.message, retryable: false });
        }
        throw err;
      }
    }

    if (isMagicaTool(tool)) {
      try {
        return {
          toolCall,
          order,
          record,
          tool,
          parsedInput: parsed.data,
          rawInput,
          display,
          reserveAmount,
          magicaPayload: { params: tool.magica.buildInput(parsed.data), subModelId: tool.magica.subModelId?.(parsed.data) },
        };
      } catch (err) {
        logger.error("tool buildInput failed", { runId, toolInvocationId: record.id, detail: String(err) });
        return fail(toSafeError(err, "TOOL_INPUT_INVALID"), reserveAmount);
      }
    }

    return { toolCall, order, record, tool, parsedInput: parsed.data, rawInput, display, reserveAmount };
  }

  async function runCalls(calls: PreparedCall[], creditError?: SafeError): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    for (const c of calls) {
      if (c.outcome) outcomes.set(c.record.id, c.outcome);
      else if (creditError) outcomes.set(c.record.id, { ok: false, error: creditError });
      else if (signal.aborted) outcomes.set(c.record.id, { ok: false, error: { code: "CANCELLED", message: "Run cancelled", retryable: false } });
    }

    const runnable = calls.filter((c) => !outcomes.has(c.record.id));
    if (!runnable.length) return outcomes;

    for (const call of runnable.filter((c) => c.tool && !isMagicaTool(c.tool))) {
      const localTool = call.tool as LocalTool;
      setStep(call.record.id, { status: "running" });
      await db.toolInvocation.update({ where: { id: call.record.id }, data: { status: "running" } });
      const t0 = Date.now();
      try {
        const output = await localTool.execute(call.parsedInput, { runId, userId, toolInvocationId: call.record.id, signal, traceId, order: call.order });
        call.durationMs = Date.now() - t0;
        outcomes.set(call.record.id, { ok: true, output, creditUsed: await localTool.estimateCredits(call.parsedInput) });
      } catch (err) {
        call.durationMs = Date.now() - t0;
        logger.error("local tool failed", { runId, toolInvocationId: call.record.id, detail: String(err) });
        outcomes.set(call.record.id, { ok: false, error: toSafeError(err) });
      }
    }

    const magicaCalls = runnable.filter((c) => c.tool && isMagicaTool(c.tool) && c.magicaPayload);
    if (magicaCalls.length) {
      for (const c of magicaCalls) setStep(c.record.id, { status: "running" });
      await db.toolInvocation.updateMany({ where: { id: { in: magicaCalls.map((c) => c.record.id) } }, data: { status: "running" } });

      const t0 = Date.now();
      const payloads = magicaCalls.map((c) => ({
        payload: { toolInvocationId: c.record.id, nodeType: (c.tool as MagicaTool).magica.nodeType, subModelId: c.magicaPayload?.subModelId, params: c.magicaPayload?.params ?? {} },
      }));

      let batchRuns: Array<{ ok: boolean; output?: Record<string, unknown>; creditUsed?: number; error?: unknown }>;
      try {
        const batch = await magicaRun.batchTriggerAndWait(payloads);
        if (signal.aborted) {
          for (const r of batch.runs) {
            if (!r.ok) runs.cancel(r.id).catch(() => {});
          }
        }
        batchRuns = batch.runs.map((r) => {
          if (!r.ok) return { ok: false, error: r.error };
          const out = r.output as { ok: boolean; output?: Record<string, unknown>; creditUsed?: number; error?: SafeError } | undefined;
          return !out?.ok ? { ok: false, error: out?.error } : { ok: true, output: out.output, creditUsed: out.creditUsed };
        });
      } catch (err) {
        logger.error("magicaRun.batchTriggerAndWait threw", { runId, detail: String(err) });
        batchRuns = magicaCalls.map(() => ({ ok: false, error: toSafeError(err, "MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED) }));
      }

      const durationMs = Date.now() - t0;
      for (const [i, c] of magicaCalls.entries()) {
        c.durationMs = durationMs;
        const res = batchRuns[i];
        if (!res?.ok) {
          logger.error("magica tool run failed", { runId, toolInvocationId: c.record.id, detail: String(res?.error) });
          outcomes.set(c.record.id, { ok: false, error: toSafeError(res?.error, "MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED) });
          continue;
        }
        const parsed = (c.tool as MagicaTool).magica.outputSchema.safeParse(res.output ?? {});
        if (!parsed.success) {
          logger.error("magica output shape mismatch", { runId, toolInvocationId: c.record.id, detail: JSON.stringify(parsed.error.format()) });
          outcomes.set(c.record.id, { ok: false, error: { code: "MAGICA_RUN_FAILED", message: SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, retryable: false } });
          continue;
        }

        let creditUsed = 0;
        if (typeof res.creditUsed === "number") {
          creditUsed = res.creditUsed;
        } else {
          logger.warn("magica run returned no creditUsed", { runId, toolInvocationId: c.record.id, toolName: c.toolCall.name });
        }
        outcomes.set(c.record.id, { ok: true, output: parsed.data, creditUsed });
      }
    }

    return outcomes;
  }

  async function finishToolCall(call: PreparedCall, outcome: Outcome) {
    const isCancelled = signal.aborted && !outcome.ok;
    const { invocation: updated, assets } = await finishToolInvocation(
      { id: call.record.id, userId, runId, toolName: call.toolCall.name },
      {
        ok: outcome.ok,
        output: outcome.ok ? outcome.output : undefined,
        creditUsed: outcome.ok ? outcome.creditUsed : undefined,
        error: !outcome.ok ? outcome.error : undefined,
        durationMs: call.durationMs,
        cancelled: isCancelled,
      },
    );

    setStep(call.record.id, {
      status: updated.status as ToolMeta["status"],
      finishedAt: new Date().toISOString(),
      credits: outcome.ok ? outcome.creditUsed : undefined,
    });
    if (outcome.ok && call.tool) extractAssets(call.tool, outcome.output, call.record.id, assetsMetadata);

    return {
      toolUseBlock: {
        type: "tool_use" as const,
        id: call.toolCall.id,
        name: call.toolCall.name,
        input: call.rawInput,
        renderKey: call.tool?.renderKey,
        label: call.display?.label,
        doneLabel: call.display?.doneLabel,
        detail: call.display?.detail,
        fields: call.display?.fields,
        model: call.display?.model,
      },
      toolResultBlock: {
        type: "tool_result" as const,
        toolUseId: call.toolCall.id,
        output: outcome.ok ? outcome.output : undefined,
        error: !outcome.ok ? outcome.error : undefined,
        credits: outcome.ok ? outcome.creditUsed : undefined,
        durationMs: call.durationMs,
        assets: assets && assets.length > 0 ? assets : undefined,
      },
      toolMessage: { role: "tool" as const, tool_call_id: call.toolCall.id, content: !outcome.ok ? JSON.stringify({ error: outcome.error.message }) : JSON.stringify(outcome.output ?? {}) },
    };
  }

  const calls: PreparedCall[] = [];
  let insufficientCreditsError: SafeError | undefined;

  for (const [index, toolCall] of toolCalls.entries()) {
    if (insufficientCreditsError) break;
    const call = await prepareToolCall(toolCall, index);
    calls.push(call);
    if (call.outcome && !call.outcome.ok && call.outcome.error.code === "INSUFFICIENT_CREDITS") {
      insufficientCreditsError = call.outcome.error;
    }
  }

  const outcomes = await runCalls(calls, insufficientCreditsError);

  const contentBlocks: ContentBlock[] = [];
  const toolMessages: LlmMessage[] = [];

  const sortedCalls = [...calls].sort((a, b) => a.order - b.order);
  for (const call of sortedCalls) {
    const outcome = outcomes.get(call.record.id) ?? {
      ok: false,
      error: { code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, retryable: false },
    };
    const finished = await finishToolCall(call, outcome);
    contentBlocks.push(finished.toolUseBlock, finished.toolResultBlock);
    toolMessages.push(finished.toolMessage);
  }

  onMetadataChange();
  return { contentBlocks, toolMessages, insufficientCreditsError };
}
