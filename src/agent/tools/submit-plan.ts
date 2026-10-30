import { getTool } from "@/agent/tools/registry";
import { SubmitPlanInput, SubmitPlanOutput } from "@/contracts/tools";
import { logger } from "@/lib/logger";
import type { LocalTool } from "@/lib/types";
import { createWaitpoint, waitForWaitpoint } from "@/modules/waitpoints/waitpoints";

export const submitPlanTool: LocalTool<SubmitPlanInput, SubmitPlanOutput> = {
  name: "submit_plan",
  displayName: "Submit Plan",
  description:
    "Submit an execution plan with steps, tools, and parameters for user review before running paid tools. Required when in plan mode.",
  category: "util",
  hidden: true,
  inputSchema: SubmitPlanInput,
  renderKey: "plan",
  estimateCredits: async () => 0,
  describe: (input) => {
    const title = input?.title ?? "";
    const stepCount = input?.steps?.length ?? 0;
    const label = title ? `Submitting plan… ${title} (${stepCount} steps)` : "Submitting plan…";
    const detail = input?.overview ?? "";
    const fields = [
      ...(title ? [{ label: "Title", value: title }] : []),
      ...(detail ? [{ label: "Overview", value: detail }] : []),
      ...(input?.steps ?? []).map((s, i) => ({
        label: `Step ${i + 1}`,
        value: s.title ? `${s.title}: ${s.description}` : s.description,
      })),
    ];

    return {
      label,
      doneLabel: "made a plan",
      detail,
      fields,
    };
  },
  execute: async (input, ctx) => {
    let totalEstimatedCredits = 0;
    const enrichedSteps = await Promise.all(
      input.steps.map(async (step) => {
        const tool = getTool(step.tool);
        let estimatedCredits = 0;
        if (tool) {
          try {
            estimatedCredits = await tool.estimateCredits(step.input);
          } catch (err) {
            logger.warn("failed to estimate credits for plan step", {
              tool: step.tool,
              detail: String(err),
            });
          }
        }
        totalEstimatedCredits += estimatedCredits;
        return {
          ...step,
          estimatedCredits,
        };
      }),
    );

    const planPayload: SubmitPlanInput = {
      title: input.title,
      overview: input.overview,
      steps: enrichedSteps,
      totalEstimatedCredits,
    };

    const { waitpoint, tokenId } = await createWaitpoint({
      runId: ctx.runId,
      toolInvocationId: ctx.toolInvocationId,
      type: "plan",
      input: planPayload,
      traceId: ctx.traceId,
    });

    const response = await waitForWaitpoint<{ action?: string; feedback?: string; request_changes?: string }>({
      waitpointId: waitpoint.id,
      tokenId,
      runId: ctx.runId,
      toolInvocationId: ctx.toolInvocationId,
      input: planPayload,
      traceId: ctx.traceId,
    });

    const action = (response.action ?? (response.request_changes ? "request_changes" : "run_all")) as
      | "run_all"
      | "step_by_step"
      | "request_changes";
    const feedback = response.feedback ?? response.request_changes;

    return {
      action,
      feedback,
      status: action === "request_changes" ? "changes_requested" : "approved",
      steps: enrichedSteps,
    };
  },
};
