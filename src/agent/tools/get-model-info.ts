import { GetModelInfoInput, GetModelInfoOutput } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import { env } from "@/lib/env";
import type { LocalTool } from "@/lib/types";

export const getModelInfoTool: LocalTool<GetModelInfoInput, GetModelInfoOutput> = {
  name: "get_model_info",
  displayName: "Get Model Info",
  description: "Get information about the configured model route and runtime status.",
  category: "util",
  hidden: true,
  inputSchema: GetModelInfoInput,
  renderKey: "model-info",
  estimateCredits: async () => CREDIT_COSTS.get_model_info,
  describe: () => ({
    label: "Checking image model settings",
    doneLabel: "looked up a model",
    detail: env.LLM_MODEL,
    model: "OpenRouter Free",
    fields: [{ label: "Model ID", value: env.LLM_MODEL }],
  }),
  execute: async () => {
    return {
      configuredModel: env.LLM_MODEL,
    };
  },
};
