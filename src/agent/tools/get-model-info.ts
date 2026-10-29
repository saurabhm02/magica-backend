import { GetModelInfoInput, GetModelInfoOutput } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import { env } from "@/lib/env";
import type { LocalTool } from "@/lib/types";

export const getModelInfoTool: LocalTool<GetModelInfoInput, GetModelInfoOutput> = {
  name: "get_model_info",
  description: "Get information about the configured model route and runtime status.",
  inputSchema: GetModelInfoInput,
  renderKey: "model-info",
  estimateCredits: () => CREDIT_COSTS.get_model_info,
  describe: () => ({
    label: "Checking image model settings",
    doneLabel: "looked up a model",
    detail: "gpt-image-2.5-flare-text",
    model: "OpenRouter Free",
    fields: [{ label: "Model ID", value: "gpt-image-2.5-flare-text" }],
  }),
  execute: async () => {
    return {
      configuredModel: env.LLM_MODEL,
    };
  },
};
