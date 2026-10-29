import type OpenAI from "openai";
import { z } from "zod";
import type { Tool } from "@/lib/types";
import { cropImageTool } from "./crop-image";
import { getModelInfoTool } from "./get-model-info";
import { gptImage2Tool } from "./gpt-image-2";
import { loadSkillTool } from "./load-skill";
import { mergeVideosTool } from "./merge-videos";
import { readSkillAssetTool } from "./read-skill-asset";

const toolList: Tool[] = [
  cropImageTool,
  gptImage2Tool,
  mergeVideosTool,
  getModelInfoTool,
  loadSkillTool,
  readSkillAssetTool,
];

export const toolsRegistry = new Map<string, Tool>(toolList.map((tool) => [tool.name, tool]));

export function getTool(name: string): Tool | undefined {
  return toolsRegistry.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(toolsRegistry.values());
}

export function getLlmTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return getAllTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    },
  }));
}
