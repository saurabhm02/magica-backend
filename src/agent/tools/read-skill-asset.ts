import { getSkill } from "@/agent/skills/registry";
import { ReadSkillAssetInput, ReadSkillAssetOutput } from "@/contracts/tools";
import { CREDIT_COSTS, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { AppError } from "@/lib/errors";
import type { LocalTool } from "@/lib/types";

/**
 * Checks that an asset path is a plain file name, to block path tricks.
 *
 * Input:
 * - rawPath: the path the model asked for
 *
 * Output:
 * - the same path if it is safe; otherwise throws SKILL_INVALID_PATH
 *   (empty, "..", slashes, backslashes, null bytes or "%" are all rejected)
 */
export function validateAssetPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("..") || rawPath.includes("/") || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.includes("%")) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }
  return rawPath;
}

/**
 * read_skill_asset tool: returns one asset file (JSON, Markdown or text) from a skill.
 *
 * Input:
 * - skill: the skill name
 * - path: the asset's file name inside that skill
 *
 * Output:
 * - { skill, path, content, contentHash }
 *
 * Notes:
 * - Assets come from the in-memory registry only, never read from disk by path.
 * - Bad path → SKILL_INVALID_PATH, unknown skill → SKILL_NOT_FOUND, unknown asset → NOT_FOUND.
 */
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
