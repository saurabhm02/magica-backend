import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ALLOWED_SKILL_EXTENSIONS, MAX_SKILL_FILE_SIZE_BYTES } from "@/lib/constants";

export const SkillFrontmatter = z.object({
  name: z
    .string()
    .min(1, "Skill name must not be empty")
    .regex(/^[a-z0-9_-]+$/, "Skill name must contain only lowercase letters, numbers, hyphens, and underscores"),
  description: z.string().min(1, "Skill description must not be empty").max(500, "Skill description too long"),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

export type SkillAsset = {
  relativePath: string;
  content: string;
  contentHash: string;
  byteLength: number;
};

export type Skill = {
  name: string;
  description: string;
  body: string;
  contentHash: string;
  dirPath: string;
  assets: Map<string, SkillAsset>;
};

let cachedRegistry: Map<string, Skill> | null = null;

export function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing or invalid YAML frontmatter delimiters (---)");
  }

  const yamlContent = match[1] ?? "";
  const body = match[2]?.trim() ?? "";
  const rawFields: Record<string, string> = {};

  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid frontmatter line: ${trimmed}`);
    }
    const key = trimmed.slice(0, colonIndex).trim();
    let val = trimmed.slice(colonIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    rawFields[key] = val;
  }

  const parsed = SkillFrontmatter.safeParse(rawFields);
  if (!parsed.success) {
    const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Malformed frontmatter: ${err}`);
  }

  return { frontmatter: parsed.data, body };
}

export function getSkillsDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "agent-skills"),
    path.resolve(process.cwd(), "server/agent-skills"),
    path.resolve(__dirname, "../../../agent-skills"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "agent-skills");
}

/**
 * Reads every skill folder from disk and builds the skills registry.
 * Each folder needs a SKILL.md with name + description frontmatter; other files become assets.
 *
 * Input:
 * - dirPath: the skills folder (defaults to agent-skills)
 *
 * Output:
 * - a map of skill name → skill (body, content hash, assets); also cached for later calls
 *
 * Rules it enforces (any break throws, so a bad skill fails loudly at startup):
 * - Missing folder, missing SKILL.md, or bad frontmatter.
 * - Two skills with the same name.
 * - An asset that isn't .md, .txt or .json, or any file over MAX_SKILL_FILE_SIZE_BYTES.
 * - Hidden files and sub-folders inside a skill are ignored.
 */
export function loadSkillsRegistry(dirPath = getSkillsDirectory()): Map<string, Skill> {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Skills directory not found: ${dirPath}`);
  }

  const registry = new Map<string, Skill>();
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillDir = path.join(dirPath, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillMdPath)) {
      throw new Error(`Skill directory "${entry.name}" is missing SKILL.md`);
    }

    const stat = fs.statSync(skillMdPath);
    if (stat.size > MAX_SKILL_FILE_SIZE_BYTES) {
      throw new Error(
        `SKILL.md in "${entry.name}" exceeds maximum allowed size of ${MAX_SKILL_FILE_SIZE_BYTES} bytes (${stat.size} bytes)`,
      );
    }

    const rawContent = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(rawContent);

    if (registry.has(frontmatter.name)) {
      throw new Error(`Duplicate skill name found: "${frontmatter.name}"`);
    }

    const contentHash = createHash("sha256").update(body).digest("hex");
    const assets = new Map<string, SkillAsset>();

    const dirFiles = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const file of dirFiles) {
      if (file.isDirectory() || file.name === "SKILL.md" || file.name.startsWith(".")) continue;

      const ext = path.extname(file.name).toLowerCase();
      if (!ALLOWED_SKILL_EXTENSIONS.includes(ext as (typeof ALLOWED_SKILL_EXTENSIONS)[number])) {
        throw new Error(
          `Unsupported file extension "${ext}" for asset "${file.name}" in skill "${frontmatter.name}". Only .md, .txt, .json are allowed.`,
        );
      }

      const assetPath = path.join(skillDir, file.name);
      const assetStat = fs.statSync(assetPath);
      if (assetStat.size > MAX_SKILL_FILE_SIZE_BYTES) {
        throw new Error(
          `Asset "${file.name}" in skill "${frontmatter.name}" exceeds maximum size of ${MAX_SKILL_FILE_SIZE_BYTES} bytes`,
        );
      }

      const assetContent = fs.readFileSync(assetPath, "utf-8");
      const assetHash = createHash("sha256").update(assetContent).digest("hex");

      assets.set(file.name, {
        relativePath: file.name,
        content: assetContent,
        contentHash: assetHash,
        byteLength: assetStat.size,
      });
    }

    registry.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      body,
      contentHash,
      dirPath: skillDir,
      assets,
    });
  }

  cachedRegistry = registry;
  return registry;
}

export function getSkillsRegistry(): Map<string, Skill> {
  if (!cachedRegistry) {
    cachedRegistry = loadSkillsRegistry();
  }
  return cachedRegistry;
}

export function getSkill(name: string): Skill | undefined {
  return getSkillsRegistry().get(name);
}

export function getAllSkills(): Skill[] {
  return Array.from(getSkillsRegistry().values());
}

/**
 * Builds the short skill list for the system prompt, one "- name: description" line per skill.
 * The model then calls load_skill to get the full instructions.
 *
 * Output:
 * - the list as text, or "" when there are no skills
 */
export function getSkillsPromptSummary(): string {
  const skills = getAllSkills();
  if (skills.length === 0) return "";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

export function clearSkillsRegistryForTesting(): void {
  cachedRegistry = null;
}
