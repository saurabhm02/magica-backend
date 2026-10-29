import path from "node:path";
import { getSkill } from "@/agent/skills/registry";
import { ReadSkillAssetInput, ReadSkillAssetOutput } from "@/contracts/tools";
import { CREDIT_COSTS, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { AppError } from "@/lib/errors";
import type { LocalTool } from "@/lib/types";

export function validateAssetPath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  if (decoded.includes("\0") || rawPath.includes("\0")) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  if (
    decoded.includes("..") ||
    rawPath.includes("..") ||
    rawPath.includes("%2e%2e") ||
    rawPath.includes("%2E%2E")
  ) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  if (
    path.isAbsolute(rawPath) ||
    path.isAbsolute(decoded) ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    decoded.startsWith("/") ||
    decoded.startsWith("\\") ||
    /^[a-zA-Z]:/.test(rawPath) ||
    /^[a-zA-Z]:/.test(decoded)
  ) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  const normalized = path.normalize(decoded).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    throw new AppError("SKILL_INVALID_PATH", SAFE_ERROR_MESSAGES.SKILL_INVALID_PATH, false);
  }

  return normalized;
}

export const readSkillAssetTool: LocalTool<ReadSkillAssetInput, ReadSkillAssetOutput> = {
  name: "read_skill_asset",
  description:
    "Read an asset file (JSON, Markdown, or text) associated with a skill. Call this when a loaded skill references a preset or configuration file.",
  inputSchema: ReadSkillAssetInput,
  renderKey: "model-info",
  estimateCredits: () => CREDIT_COSTS.read_skill_asset,
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
    const normalizedPath = validateAssetPath(input.path);
    const skill = getSkill(input.skill);
    if (!skill) {
      throw new AppError("SKILL_NOT_FOUND", SAFE_ERROR_MESSAGES.SKILL_NOT_FOUND, false);
    }

    const asset = skill.assets.get(normalizedPath) || skill.assets.get(path.basename(normalizedPath));
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
