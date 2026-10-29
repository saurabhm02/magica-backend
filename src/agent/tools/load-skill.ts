import { getSkill } from "@/agent/skills/registry";
import { LoadSkillInput, LoadSkillOutput } from "@/contracts/tools";
import { CREDIT_COSTS, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { LocalTool } from "@/lib/types";

export const loadSkillTool: LocalTool<LoadSkillInput, LoadSkillOutput> = {
  name: "load_skill",
  description: "load the full instructions and guidance for an available skill. Call this when specialized domain guidance (e.g. product-photo, social-crop, video-montage) is needed.",
  inputSchema: LoadSkillInput,
  renderKey: "model-info",
  estimateCredits: () => CREDIT_COSTS.load_skill,
  describe: (input) => ({
    label: input?.name ? `Loading skill **${input.name}**` : "Loading skill...",
    doneLabel: "loaded a skill",
    detail: input?.name ?? "",
    model: "System",
    fields: [{ label: "Skill", value: input?.name ?? "" }],
  }),
  execute: async (input, ctx) => {
    const skill = getSkill(input.name);
    if (!skill) {
      throw new AppError("SKILL_NOT_FOUND", SAFE_ERROR_MESSAGES.SKILL_NOT_FOUND, false);
    }

    if (ctx.runId) {
      const existing = await db.runSkill.findUnique({
        where: {
          runId_skillName: {
            runId: ctx.runId,
            skillName: skill.name,
          },
        },
      });

      if (existing) {
        if (existing.contentHash !== skill.contentHash) {
          logger.warn("skill file changed on disk since run loaded it; returning recorded version", {
            runId: ctx.runId,
            skillName: skill.name,
            recordedHash: existing.contentHash,
            currentHash: skill.contentHash,
          });
        }
        return {
          name: existing.skillName,
          content: existing.content,
          contentHash: existing.contentHash,
        };
      }

      try {
        const created = await db.runSkill.create({
          data: {
            runId: ctx.runId,
            skillName: skill.name,
            contentHash: skill.contentHash,
            content: skill.body,
          },
        });
        return {
          name: created.skillName,
          content: created.content,
          contentHash: created.contentHash,
        };
      } catch (err) {
        const fallback = await db.runSkill.findUnique({
          where: {
            runId_skillName: {
              runId: ctx.runId,
              skillName: skill.name,
            },
          },
        });
        if (fallback) {
          return {
            name: fallback.skillName,
            content: fallback.content,
            contentHash: fallback.contentHash,
          };
        }
        throw err;
      }
    }

    return {
      name: skill.name,
      content: skill.body,
      contentHash: skill.contentHash,
    };
  },
};
