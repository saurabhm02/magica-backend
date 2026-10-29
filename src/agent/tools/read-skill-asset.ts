import { getSkill } from "@/agent/skills/registry";
import { ReadSkillAssetInput, ReadSkillAssetOutput } from "@/contracts/tools";
import { CREDIT_COSTS, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { AppError } from "@/lib/errors";
import type { LocalTool } from "@/lib/types";

export function validateAssetPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("..") || rawPath.includes("/") || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.includes("%")) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }
  return rawPath;
}

export const readSkillAssetTool: LocalTool<ReadSkillAssetInput, ReadSkillAssetOutput> = {
  name: "read_skill_asset",
  displayName: "Read Skill Asset",
  description:
    "Read an asset file (JSON, Markdown, or text) associated with a skill. Call this when a loaded skill references a preset or configuration file.",
  category: "util",
  hidden: true,
  inputSchema: ReadSkillAssetInput,
  renderKey: "model-info",
  estimateCredits: async () => CREDIT_COSTS.read_skill_asset,
  describe: (input) => ({
    label: input?.path ? `Reading asset **${input.path}**` : "Reading skill asset...",
    doneLabel: "read a skill asset",
    detail: input?.path ?? "",
    model: "System",
    fields: [
      { label: "Skill", value: input?.skill ?? "" },
      { label: "Asset", value: input?.path ?? "" },
    ],
  }),
  execute: async (input) => {
    validateAssetPath(input.path);

    const skill = getSkill(input.skill);
    if (!skill) {
      throw new AppError("SKILL_NOT_FOUND", SAFE_ERROR_MESSAGES.SKILL_NOT_FOUND, false);
    }

    const asset = skill.assets.get(input.path);
    if (!asset) {
      throw new AppError("NOT_FOUND", `Asset '${input.path}' not found in skill '${input.skill}'`, false);
    }

    return {
      skill: skill.name,
      path: input.path,
      content: asset.content,
      contentHash: asset.contentHash,
    };
  },
};
