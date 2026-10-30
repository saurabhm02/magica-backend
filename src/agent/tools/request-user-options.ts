import { RequestUserOptionsInput, RequestUserOptionsOutput } from "@/contracts/tools";
import type { LocalTool } from "@/lib/types";
import { createWaitpoint, waitForWaitpoint } from "@/modules/waitpoints/waitpoints";

export const requestUserOptionsTool: LocalTool<RequestUserOptionsInput, RequestUserOptionsOutput> = {
  name: "request_user_options",
  displayName: "Request User Options",
  description:
    "Ask the user everything you need in one card: 1-4 questions, multiple choice (3-6 options, each with a short description) or short text (names, colors). " +
    "Start the message with one friendly line, like \"Happy to make your logo! Before I start, a few quick questions so it fits you.\" " +
    "Call it once per task. After the answers, start the work; a skipped answer means pick a sensible default.",
  category: "util",
  hidden: true,
  inputSchema: RequestUserOptionsInput,
  renderKey: "request-user-options",
  estimateCredits: async () => 0,
  describe: (input) => ({
    label: "Asking for input…",
    doneLabel: "asked for input",
    detail: input?.message ? `${input.message} (${questionCount(input.questions?.length ?? 0)})` : "",
    fields: [],
  }),
  execute: async (input, ctx) => {
    const { waitpoint, tokenId } = await createWaitpoint({
      runId: ctx.runId,
      toolInvocationId: ctx.toolInvocationId,
      type: "options",
      input,
      traceId: ctx.traceId,
    });

    return waitForWaitpoint({
      waitpointId: waitpoint.id,
      tokenId,
      runId: ctx.runId,
      toolInvocationId: ctx.toolInvocationId,
      input,
      traceId: ctx.traceId,
    });
  },
};

// "(4 questions)" after the message, like Magica's step row.
function questionCount(n: number) {
  return n === 1 ? "1 question" : `${n} questions`;
}
