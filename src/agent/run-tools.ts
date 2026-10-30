import type { Prisma } from "@prisma/client";
import { metadata, runs } from "@trigger.dev/sdk";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { getTool } from "@/agent/tools/registry";
import type { ContentBlock } from "@/contracts/content-blocks";
import type { SafeError } from "@/contracts/errors";
import type { RunMetadata } from "@/contracts/run";
import type { AnswerItem } from "@/contracts/tools";
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
import { createWaitpoint, deriveShortTitle, formatCreditsM, waitForWaitpoint } from "@/modules/waitpoints/waitpoints";
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
  planMode?: boolean;
  planApproved?: boolean;
  onMetadataChange: () => void;
};

export type ExecuteTurnToolsResult = {
  contentBlocks: ContentBlock[];
  toolMessages: LlmMessage[];
  insufficientCreditsError?: SafeError;
  waitpointExpiredError?: SafeError;
  planApproved?: boolean;
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

/**
 * Runs all the tool calls the model asked for in one step and turns the results into
 * saved content blocks and tool messages for the next model call.
 *
 * Input:
 * - params.runId, userId, traceId: the run, its owner, and the trace id for logs
 * - params.signal: aborts the run
 * - params.toolCalls: the tool calls from this model step
 * - params.toolsMetadata, assetsMetadata: live step and asset lists, updated in place
 * - params.planMode, planApproved: whether paid tools are blocked until a plan is approved
 * - params.onMetadataChange: called whenever a step changes, to push it to the client
 *
 * Output:
 * - { contentBlocks, toolMessages, insufficientCreditsError?, waitpointExpiredError?, planApproved? }
 *
 * Rules it enforces:
 * - Every call gets a tool invocation row first (idempotency key tool:<runId>:<toolCallId>).
 * - Bad JSON, unknown tool or invalid input → that call fails with TOOL_INPUT_INVALID; others still run.
 * - In plan mode, paid (Magica) tools fail until the plan is approved.
 * - Credits are held before running (estimate x CREDIT_RESERVE_MULTIPLIER). Not enough → no more
 *   calls run, and the turn reports INSUFFICIENT_CREDITS.
 * - Local tools run one by one; Magica tools run in parallel as child tasks.
 * - Results are saved in the model's call order. An approved plan runs its steps right after.
 */
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

    if (params.planMode && !params.planApproved && isMagicaTool(tool)) {
      return fail({
        code: "TOOL_INPUT_INVALID",
        message: "Plan mode is active. You must submit a plan with submit_plan and receive approval before executing paid tools.",
        retryable: false,
      });
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

    let displayLabel = call.display?.label;
    let displayDoneLabel = call.display?.doneLabel;
    let displayDetail = call.display?.detail;
    let displayFields = call.display?.fields;

    if (call.toolCall.name === "request_user_options") {
      if (outcome.ok && outcome.output) {
        const answers = (outcome.output as { answers?: Array<{ questionId?: string; question?: string; answer: string }> }).answers;
        if (answers && Array.isArray(answers)) {
          displayLabel = "User input received";
          displayDoneLabel = "User input received";
          displayFields = answers.map((a, i) => ({
            label: a.question || `Q${i + 1}`,
            value: a.answer,
          }));
        }
      } else if (!outcome.ok && outcome.error.code === "WAITPOINT_EXPIRED") {
        displayDetail = outcome.error.message;
      }
    }

    if (call.toolCall.name === "submit_plan") {
      if (outcome.ok && outcome.output) {
        const planOut = outcome.output as {
          action?: "run_all" | "step_by_step" | "request_changes";
          feedback?: string;
          steps?: Array<{ title: string; description: string; estimatedCredits?: number }>;
        };
        const rawInput = call.parsedInput as {
          title?: string;
          overview?: string;
          steps?: Array<{ title: string; description: string; estimatedCredits?: number }>;
          totalEstimatedCredits?: number;
        };
        const steps = planOut.steps ?? rawInput?.steps ?? [];
        const totalEst = rawInput?.totalEstimatedCredits ?? steps.reduce((sum, s) => sum + (s.estimatedCredits ?? 0), 0);

        if (planOut.action === "run_all" || planOut.action === "step_by_step") {
          displayLabel = `Plan approved ${rawInput?.title ?? ""} (${steps.length} steps)`.trim();
          displayDoneLabel = displayLabel;
          displayFields = [
            { label: "Title", value: rawInput?.title ?? "" },
            { label: "Overview", value: rawInput?.overview ?? "" },
            ...steps.map((s, idx) => ({
              label: `Step ${idx + 1} (~${formatCreditsM(s.estimatedCredits ?? 0)}M)`,
              value: s.title ? `${s.title}: ${s.description}` : s.description,
            })),
            { label: "Total estimated", value: `~${formatCreditsM(totalEst)}M credits` },
          ];
        } else if (planOut.action === "request_changes") {
          displayLabel = "Plan changes requested";
          displayDoneLabel = "made a plan";
          displayDetail = planOut.feedback ?? "";
        }
      }
    }

    setStep(call.record.id, {
      status: updated.status as ToolMeta["status"],
      finishedAt: new Date().toISOString(),
      credits: outcome.ok ? outcome.creditUsed : undefined,
      label: displayLabel,
      doneLabel: displayDoneLabel,
      detail: displayDetail,
      fields: displayFields,
    });
    if (outcome.ok && call.tool) extractAssets(call.tool, outcome.output, call.record.id, assetsMetadata);

    return {
      toolUseBlock: {
        type: "tool_use" as const,
        id: call.toolCall.id,
        name: call.toolCall.name,
        input: call.rawInput,
        renderKey: call.tool?.renderKey,
        label: displayLabel,
        doneLabel: displayDoneLabel,
        detail: displayDetail,
        fields: displayFields,
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
  let waitpointExpiredError: SafeError | undefined;
  let planApproved = params.planApproved ?? false;

  const sortedCalls = [...calls].sort((a, b) => a.order - b.order);
  for (const call of sortedCalls) {
    const outcome = outcomes.get(call.record.id) ?? {
      ok: false,
      error: { code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, retryable: false },
    };
    if (!outcome.ok && outcome.error.code === "WAITPOINT_EXPIRED") {
      waitpointExpiredError = outcome.error;
    }
    const finished = await finishToolCall(call, outcome);
    contentBlocks.push(finished.toolUseBlock, finished.toolResultBlock);
    toolMessages.push(finished.toolMessage);

    if (call.toolCall.name === "submit_plan" && outcome.ok && outcome.output) {
      const planOut = outcome.output as {
        action?: "run_all" | "step_by_step" | "request_changes";
        steps?: Array<{ title: string; description: string; tool: string; input: Record<string, unknown>; estimatedCredits?: number }>;
      };
      if (planOut.action === "run_all" || planOut.action === "step_by_step") {
        planApproved = true;
        const rawInput = call.parsedInput as {
          title: string;
          overview: string;
          steps: Array<{ title: string; description: string; tool: string; input: Record<string, unknown>; estimatedCredits?: number }>;
        };
        const stepsToRun = planOut.steps ?? rawInput?.steps ?? [];
        if (stepsToRun.length > 0) {
          const planExec = await executePlanSteps({
            runId,
            userId,
            traceId,
            signal,
            plan: {
              title: rawInput.title,
              overview: rawInput.overview,
              steps: stepsToRun,
            },
            mode: planOut.action,
            toolsMetadata,
            assetsMetadata,
            onMetadataChange,
            startOrder: sortedCalls.length,
          });
          contentBlocks.push(...planExec.contentBlocks);
          toolMessages.push(...planExec.toolMessages);
        }
      }
    }
  }

  onMetadataChange();
  return { contentBlocks, toolMessages, insufficientCreditsError, waitpointExpiredError, planApproved };
}

async function executePlanSteps(params: {
  runId: string;
  userId: string;
  traceId: string;
  signal: AbortSignal;
  plan: {
    title: string;
    overview: string;
    steps: Array<{ title: string; description: string; tool: string; input: Record<string, unknown>; estimatedCredits?: number }>;
  };
  mode: "run_all" | "step_by_step";
  toolsMetadata: ToolMeta[];
  assetsMetadata: AssetMeta[];
  onMetadataChange: () => void;
  startOrder: number;
}): Promise<{ contentBlocks: ContentBlock[]; toolMessages: LlmMessage[] }> {
  const { runId, userId, traceId, signal, plan, mode, toolsMetadata, assetsMetadata, onMetadataChange, startOrder } = params;
  const contentBlocks: ContentBlock[] = [];
  const toolMessages: LlmMessage[] = [];

  const shortTitle = deriveShortTitle(plan.title);
  const planMeta: NonNullable<RunMetadata["plan"]> = {
    title: plan.title,
    shortTitle,
    steps: plan.steps.map((s) => ({ title: s.title, status: "pending" })),
    done: 0,
    total: plan.steps.length,
  };

  try {
    metadata.set("plan", planMeta);
  } catch {}
  onMetadataChange();

  let lastAssetUrl: string | undefined;
  let order = startOrder;

  for (const [i, step] of plan.steps.entries()) {
    if (signal.aborted) break;

    const currentStepMeta = planMeta.steps[i];
    if (currentStepMeta) currentStepMeta.status = "running";
    try {
      metadata.set("plan", planMeta);
    } catch {}
    onMetadataChange();

    const tool = getTool(step.tool);
    if (!tool) {
      if (currentStepMeta) currentStepMeta.status = "failed";
      try {
        metadata.set("plan", planMeta);
      } catch {}
      onMetadataChange();
      continue;
    }

    const stepInput = { ...step.input };
    if (step.tool === "crop_image" && lastAssetUrl && (!stepInput.image_url || typeof stepInput.image_url !== "string" || stepInput.image_url.startsWith("$"))) {
      stepInput.image_url = lastAssetUrl;
    }

    const toolCallId = `plan_step_${i}_${randomUUID().slice(0, 8)}`;
    const stepOrder = order++;
    const display = tool.describe(stepInput);

    const record = await db.toolInvocation.create({
      data: {
        runId,
        userId,
        toolCallId,
        order: stepOrder,
        toolName: step.tool,
        status: "running",
        input: stepInput as Prisma.InputJsonValue,
        idempotencyKey: `tool:${runId}:${toolCallId}`,
      },
    });

    toolsMetadata.push({
      id: record.id,
      name: step.tool,
      status: "running",
      startedAt: new Date().toISOString(),
      renderKey: tool.renderKey,
      label: display.label,
      doneLabel: display.doneLabel,
      detail: display.detail,
      fields: display.fields,
      model: display.model,
    });
    onMetadataChange();

    const estimate = await tool.estimateCredits(stepInput);
    const reserveAmount = Math.round(estimate * CREDIT_RESERVE_MULTIPLIER);
    if (reserveAmount > 0) {
      await reserveCredits({ userId, runId, toolInvocationId: record.id, amount: reserveAmount });
    }

    let output: unknown;
    let creditUsed = estimate;
    const t0 = Date.now();

    try {
      if (isMagicaTool(tool)) {
        const magicaTool = tool as MagicaTool;
        const magicaPayload = {
          params: magicaTool.magica.buildInput(stepInput),
          subModelId: magicaTool.magica.subModelId?.(stepInput),
        };
        const batch = await magicaRun.batchTriggerAndWait([
          {
            payload: {
              toolInvocationId: record.id,
              nodeType: magicaTool.magica.nodeType,
              subModelId: magicaPayload.subModelId,
              params: magicaPayload.params,
            },
          },
        ]);
        const runRes = batch.runs[0];
        if (!runRes?.ok) {
          throw new Error("Magica step execution failed");
        }
        const runOut = runRes.output as { ok: boolean; output?: Record<string, unknown>; creditUsed?: number; error?: SafeError } | undefined;
        if (!runOut?.ok || !runOut.output) {
          throw new Error(runOut?.error?.message ?? "Magica step execution failed");
        }
        output = runOut.output;
        if (typeof runOut.creditUsed === "number") creditUsed = runOut.creditUsed;
      } else {
        output = await (tool as LocalTool).execute(stepInput, {
          runId,
          userId,
          toolInvocationId: record.id,
          signal,
          traceId,
          order: stepOrder,
        });
      }

      const durationMs = Date.now() - t0;
      const { assets } = await finishToolInvocation(
        { id: record.id, userId, runId, toolName: step.tool },
        { ok: true, output, creditUsed, durationMs },
      );

      const stepMeta = toolsMetadata.find((s) => s.id === record.id);
      if (stepMeta) {
        stepMeta.status = "succeeded";
        stepMeta.finishedAt = new Date().toISOString();
        stepMeta.credits = creditUsed;
      }

      if (assets && assets.length > 0) {
        for (const a of assets) {
          if (a.url) {
            assetsMetadata.push({ type: a.type, url: a.url, toolInvocationId: record.id });
            lastAssetUrl = a.url;
          }
        }
      }

      if (currentStepMeta) currentStepMeta.status = "done";
      planMeta.done = i + 1;
      try {
        metadata.set("plan", planMeta);
      } catch {}
      onMetadataChange();

      contentBlocks.push(
        {
          type: "tool_use" as const,
          id: toolCallId,
          name: step.tool,
          input: stepInput,
          renderKey: tool.renderKey,
          label: display.label,
          doneLabel: display.doneLabel,
          detail: display.detail,
          fields: display.fields,
          model: display.model,
        },
        {
          type: "tool_result" as const,
          toolUseId: toolCallId,
          output,
          credits: creditUsed,
          durationMs,
          assets: assets && assets.length > 0 ? assets : undefined,
        },
      );
      toolMessages.push({
        role: "tool" as const,
        tool_call_id: toolCallId,
        content: JSON.stringify(output ?? {}),
      });

      if (mode === "step_by_step" && i < plan.steps.length - 1) {
        const stepWp = await createWaitpoint({
          runId,
          toolInvocationId: record.id,
          type: "options",
          input: {
            message: `Step ${i + 1} (${step.title}) completed. Continue to next step?`,
            questions: [
              {
                id: "step_continuation",
                question: "Continue execution?",
                type: "choice",
                options: [
                  { id: "continue", label: "Continue", recommended: true },
                  { id: "stop", label: "Stop" },
                ],
              },
            ],
          },
          traceId,
        });
        const decision = await waitForWaitpoint<{ answers?: AnswerItem[] }>({
          waitpointId: stepWp.waitpoint.id,
          tokenId: stepWp.tokenId,
          runId,
          toolInvocationId: record.id,
          input: stepWp.waitpoint.payload,
          traceId,
        });
        const selected = decision?.answers?.[0]?.answer?.toLowerCase();
        if (selected === "stop") {
          break;
        }
      }
    } catch (err) {
      if (currentStepMeta) currentStepMeta.status = "failed";
      try {
        metadata.set("plan", planMeta);
      } catch {}
      onMetadataChange();
      await finishToolInvocation(
        { id: record.id, userId, runId, toolName: step.tool },
        { ok: false, error: toSafeError(err) },
      );
      break;
    }
  }

  return { contentBlocks, toolMessages };
}
