import type { WaitpointTypeDefinition } from "../registry";
import { SubmitPlanInput } from "@/contracts/tools";

export const planWaitpointType: WaitpointTypeDefinition = {
  type: "plan",
  displayName: "Plan",
  description: "Execution plan approval (run all, step by step, or request changes)",
  payloadSchema: SubmitPlanInput,
};
