import { getSkill } from "@/agent/skills/registry";
import { LoadSkillInput, LoadSkillOutput } from "@/contracts/tools";
import { CREDIT_COSTS, SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { LocalTool } from "@/lib/types";

/**
 * load_skill tool: gives the model the full instructions of one skill from the system prompt list.
 *
 * Input:
 * - name: the skill name
 *
 * Output:
 * - { name, content, contentHash }
 *
 * Notes:
 * - Unknown name → SKILL_NOT_FOUND.
 * - The first load in a run is saved (one row per run + skill); loading it again in the same run
 *   returns that saved copy, so the run keeps seeing the same version even if the file changes.
 */
export const loadSkillTool: LocalTool<LoadSkillInput, LoadSkillOutput> = {
  name: "load_skill",
  displayName: "Load Skill",
  description:
    "Load the full instructions for one of the Available Skills listed in the system prompt. Call it before other tools when a skill matches the task.",
  category: "util",
  hidden: true,
  inputSchema: LoadSkillInput,
  renderKey: "model-info",
  estimateCredits: async () => CREDIT_COSTS.load_skill,
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

    const row = await db.runSkill.upsert({
      where: {
        runId_skillName: {
          runId: ctx.runId,
          skillName: skill.name,
        },
      },
      create: {
        runId: ctx.runId,
        skillName: skill.name,
        contentHash: skill.contentHash,
        content: skill.body,
      },
      update: {},
    });

    return {
      name: row.skillName,
      content: row.content,
      contentHash: row.contentHash,
    };
  },
};
