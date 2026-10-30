import type OpenAI from "openai";
import { z } from "zod";
import { isMagicaTool, type Tool } from "@/lib/types";
import { cropImageTool } from "./crop-image";
import { getModelInfoTool } from "./get-model-info";
import { gptImage2Tool } from "./gpt-image-2";
import { loadSkillTool } from "./load-skill";
import { mergeVideosTool } from "./merge-videos";
import { readSkillAssetTool } from "./read-skill-asset";
import { requestUserOptionsTool } from "./request-user-options";
import { submitPlanTool } from "./submit-plan";

const toolList: Tool[] = [
  cropImageTool,
  gptImage2Tool,
  mergeVideosTool,
  getModelInfoTool,
  loadSkillTool,
  readSkillAssetTool,
  requestUserOptionsTool,
  submitPlanTool,
];

/**
 * The single tool registry: every tool the agent can call, by name.
 * Add a new tool to toolList above and it is available everywhere.
 */
export const toolsRegistry = new Map<string, Tool>(toolList.map((tool) => [tool.name, tool]));

/**
 * Finds a tool by name.
 *
 * Input:
 * - name: the tool name the model called
 *
 * Output:
 * - the tool, or undefined if there is no tool with that name
 */
export function getTool(name: string): Tool | undefined {
  return toolsRegistry.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(toolsRegistry.values());
}

/**
 * Builds the tool definitions sent to the model, with each input schema turned into JSON Schema.
 *
 * Output:
 * - every registered tool (hidden ones included) in OpenAI function-tool format
 */
export function getLlmTools({ withoutPaidTools = false } = {}): OpenAI.Chat.Completions.ChatCompletionTool[] {
  // In plan mode the paid Magica tools are left out until the plan is approved, so the model can only plan.
  const tools = withoutPaidTools ? getAllTools().filter((tool) => !isMagicaTool(tool)) : getAllTools();
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    },
  }));
}

export async function listPublicTools() {
  const tools = getAllTools().filter((tool) => !tool.hidden);
  return Promise.all(
    tools.map(async (tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.tagline ?? tool.description,
      category: tool.category,
      estimatedCredits: await tool.estimateCredits({}),
    })),
  );
}

export const getUserFacingTools = listPublicTools;
