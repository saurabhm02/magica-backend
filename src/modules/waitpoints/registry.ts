import type { z } from "zod";
import { optionsWaitpointType } from "./types/options";
import { planWaitpointType } from "./types/plan";

export type WaitpointTypeDefinition = {
  type: string;
  displayName: string;
  description: string;
  payloadSchema?: z.ZodType;
};

const waitpointTypeList: WaitpointTypeDefinition[] = [optionsWaitpointType, planWaitpointType];

export const waitpointsRegistry = new Map<string, WaitpointTypeDefinition>(
  waitpointTypeList.map((definition) => [definition.type, definition]),
);

export function getWaitpointType(type: string): WaitpointTypeDefinition | undefined {
  return waitpointsRegistry.get(type);
}

export function getAllWaitpointTypes(): WaitpointTypeDefinition[] {
  return Array.from(waitpointsRegistry.values());
}
