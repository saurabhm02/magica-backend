import type { WaitpointTypeDefinition } from "../registry";
import { RequestUserOptionsInput } from "@/contracts/tools";

export const optionsWaitpointType: WaitpointTypeDefinition = {
  type: "options",
  displayName: "Options",
  description: "User option selection or text prompt input",
  payloadSchema: RequestUserOptionsInput,
};
