import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { metadata } from "@trigger.dev/sdk";
import {
  clearSkillsRegistryForTesting,
  getAllSkills,
  getSkill,
  getSkillsPromptSummary,
  loadSkillsRegistry,
  parseFrontmatter,
} from "@/agent/skills/registry";
import { loadSkillTool } from "@/agent/tools/load-skill";
import { readSkillAssetTool, validateAssetPath } from "@/agent/tools/read-skill-asset";
import { MAX_SKILL_FILE_SIZE_BYTES } from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createChat } from "@/modules/chats/chats";
import { sendMessage } from "@/modules/messages/messages";
import { runAgentTurn, textStream } from "@/trigger/agent-turn";

describe("Skills Registry & Frontmatter", () => {
  afterEach(() => {
    clearSkillsRegistryForTesting();
  });

  it("parses valid frontmatter and body correctly", () => {
    const raw = `---
name: test-skill
description: A test skill description
---
# Body
This is the body.`;

    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test skill description");
    expect(body).toBe("# Body\nThis is the body.");
  });

  it("rejects missing frontmatter delimiters", () => {
    expect(() => parseFrontmatter("name: test\nbody")).toThrow(/delimiters/);
  });

  it("rejects malformed frontmatter without colon", () => {
    const raw = `---
bad line without colon
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(/Invalid frontmatter line/);
  });

  it("rejects missing required fields (name or description)", () => {
    const missingDesc = `---
name: test-skill
---
body`;
    expect(() => parseFrontmatter(missingDesc)).toThrow(/Malformed frontmatter/);
  });

  it("rejects invalid characters in skill name", () => {
    const badName = `---
name: BAD Skill Name!
description: desc
---
body`;
    expect(() => parseFrontmatter(badName)).toThrow(/Malformed frontmatter/);
  });

  it("discovers the 3 real skills and exposes only names and descriptions", () => {
    const skills = getAllSkills();
    expect(skills.length).toBeGreaterThanOrEqual(3);

    const names = skills.map((s) => s.name);
    expect(names).toContain("product-photo");
    expect(names).toContain("social-crop");
    expect(names).toContain("video-montage");

    const productPhoto = getSkill("product-photo");
    expect(productPhoto).toBeDefined();
    expect(productPhoto?.description).toContain("gpt_image_2");

    const summary = getSkillsPromptSummary();
    expect(summary).toContain("product-photo: ");
    expect(summary).toContain("social-crop: ");
    expect(summary).toContain("video-montage: ");
    // Prompt summary should NEVER include the body content
    expect(summary).not.toContain("Prompt Structure for Product Shots");
  });

  it("rejects duplicate skill names in the directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-dup-test-"));
    try {
      // Create skill 1
      const dir1 = path.join(tempDir, "skill-one");
      fs.mkdirSync(dir1);
      fs.writeFileSync(
        path.join(dir1, "SKILL.md"),
        `---
name: same-name
description: Skill one
---
body 1`,
      );

      // Create skill 2 with same name
      const dir2 = path.join(tempDir, "skill-two");
      fs.mkdirSync(dir2);
      fs.writeFileSync(
        path.join(dir2, "SKILL.md"),
        `---
name: same-name
description: Skill two
---
body 2`,
      );

      expect(() => loadSkillsRegistry(tempDir)).toThrow(/Duplicate skill name found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported file extensions in a skill folder", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ext-test-"));
    try {
      const dir = path.join(tempDir, "bad-ext-skill");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---
name: bad-ext-skill
description: Bad ext
---
body`,
      );
      fs.writeFileSync(path.join(dir, "script.sh"), "echo hello");

      expect(() => loadSkillsRegistry(tempDir)).toThrow(/Unsupported file extension/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects files exceeding max size limit", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-size-test-"));
    try {
      const dir = path.join(tempDir, "large-skill");
      fs.mkdirSync(dir);
      const hugeContent = "A".repeat(MAX_SKILL_FILE_SIZE_BYTES + 10);
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---
name: large-skill
description: Huge
---
${hugeContent}`,
      );

      expect(() => loadSkillsRegistry(tempDir)).toThrow(/exceeds maximum allowed size/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("load_skill tool and Durability", () => {
  let userId: string;
  let testChatId: string;
  let testRunId: string;

  beforeAll(async () => {
    const user = await db.user.create({ data: { clerkUserId: `test_skills_${randomUUID()}` } });
    userId = user.id;
    const chat = await createChat(userId);
    testChatId = chat.id;

    const sent = await sendMessage(userId, testChatId, {
      content: "test",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    testRunId = sent.run.id;
  });

  afterAll(async () => {
    await db.creditLedger.deleteMany({ where: { userId } });
    await db.runSkill.deleteMany({ where: { runId: testRunId } });
    await db.toolInvocation.deleteMany({ where: { run: { userId } } });
    await db.agentRun.deleteMany({ where: { userId } });
    await db.message.deleteMany({ where: { chat: { userId } } });
    await db.chat.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  });

  it("rejects unknown skill with SKILL_NOT_FOUND", async () => {
    await expect(
      loadSkillTool.execute(
        { name: "non-existent-skill" },
        {
          runId: testRunId,
          userId,
          toolInvocationId: "inv_1",
          signal: new AbortController().signal,
          order: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("loads a valid skill, records RunSkill, and provides describe() data", async () => {
    const desc = loadSkillTool.describe({ name: "product-photo" });
    expect(desc.label).toBe("Loading skill **product-photo**");
    expect(desc.doneLabel).toBe("loaded a skill");
    expect(desc.detail).toBe("product-photo");

    const result = await loadSkillTool.execute(
      { name: "product-photo" },
      {
        runId: testRunId,
        userId,
        toolInvocationId: "inv_2",
        signal: new AbortController().signal,
        order: 0,
      },
    );

    expect(result.name).toBe("product-photo");
    expect(result.content).toContain("Product Photography with GPT Image 2");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const savedRow = await db.runSkill.findUnique({
      where: {
        runId_skillName: {
          runId: testRunId,
          skillName: "product-photo",
        },
      },
    });
    expect(savedRow).toBeDefined();
    expect(savedRow?.contentHash).toBe(result.contentHash);
  });

  it("deduplicates repeated loads in the same run without error", async () => {
    const result2 = await loadSkillTool.execute(
      { name: "product-photo" },
      {
        runId: testRunId,
        userId,
        toolInvocationId: "inv_3",
        signal: new AbortController().signal,
        order: 1,
      },
    );

    expect(result2.name).toBe("product-photo");
    const count = await db.runSkill.count({
      where: { runId: testRunId, skillName: "product-photo" },
    });
    expect(count).toBe(1);
  });

  it("reuses recorded hash and content on resume if disk version changed", async () => {
    // Manually mutate recorded hash in DB to simulate recorded version
    const recordedHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const recordedContent = "# Cached content from earlier run";
    await db.runSkill.update({
      where: {
        runId_skillName: {
          runId: testRunId,
          skillName: "product-photo",
        },
      },
      data: {
        contentHash: recordedHash,
        content: recordedContent,
      },
    });

    const resultResumed = await loadSkillTool.execute(
      { name: "product-photo" },
      {
        runId: testRunId,
        userId,
        toolInvocationId: "inv_4",
        signal: new AbortController().signal,
        order: 2,
      },
    );

    expect(resultResumed.contentHash).toBe(recordedHash);
    expect(resultResumed.content).toBe(recordedContent);
  });
});

describe("read_skill_asset tool and Path Traversal Security", () => {
  it("rejects path traversal attempts with SKILL_INVALID_PATH", () => {
    const invalidPaths = [
      "../secret.txt",
      "../../etc/passwd",
      "/etc/passwd",
      "/absolute/path.json",
      "\\windows\\path.txt",
      "C:\\boot.ini",
      "subdir/../../escape.json",
      "..%2fsecret.txt",
      "%2e%2e%2fescape.json",
      "secret.txt\0.md",
    ];

    for (const badPath of invalidPaths) {
      expect(() => validateAssetPath(badPath)).toThrow();
      try {
        validateAssetPath(badPath);
      } catch (err) {
        expect((err as AppError).code).toBe("SKILL_INVALID_PATH");
      }
    }
  });

  it("reads a valid asset file", async () => {
    const desc = readSkillAssetTool.describe({ skill: "social-crop", path: "dimensions.json" });
    expect(desc.label).toBe("Reading asset **dimensions.json**");
    expect(desc.doneLabel).toBe("read a skill asset");

    const result = await readSkillAssetTool.execute(
      { skill: "social-crop", path: "dimensions.json" },
      {
        runId: "dummy_run",
        userId: "dummy_user",
        toolInvocationId: "inv_asset",
        signal: new AbortController().signal,
        order: 0,
      },
    );

    expect(result.skill).toBe("social-crop");
    expect(result.path).toBe("dimensions.json");
    expect(result.content).toContain("instagram_story");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-existent asset in a valid skill", async () => {
    await expect(
      readSkillAssetTool.execute(
        { skill: "social-crop", path: "nonexistent.json" },
        {
          runId: "dummy_run",
          userId: "dummy_user",
          toolInvocationId: "inv_bad_asset",
          signal: new AbortController().signal,
          order: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects asset read for unknown skill", async () => {
    await expect(
      readSkillAssetTool.execute(
        { skill: "unknown-skill", path: "file.json" },
        {
          runId: "dummy_run",
          userId: "dummy_user",
          toolInvocationId: "inv_unk",
          signal: new AbortController().signal,
          order: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});

describe("Selective Loading in Agent Turn", () => {
  let userId: string;

  beforeAll(async () => {
    vi.spyOn(metadata, "replace").mockReturnValue(undefined as unknown as void);
    vi.spyOn(textStream, "append").mockResolvedValue(undefined);
    const user = await db.user.create({ data: { clerkUserId: `sel_${randomUUID()}` } });
    userId = user.id;
  });

  afterAll(async () => {
    await db.creditLedger.deleteMany({ where: { userId } });
    await db.runSkill.deleteMany({ where: { run: { userId } } });
    await db.toolInvocation.deleteMany({ where: { run: { userId } } });
    await db.agentRun.deleteMany({ where: { userId } });
    await db.message.deleteMany({ where: { chat: { userId } } });
    await db.chat.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  });

  it("a plain 'hi' never calls load_skill", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "hi",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    await runAgentTurn(sent.run.id, "test_selective_hi");

    const skillInvocations = await db.toolInvocation.findMany({
      where: { runId: sent.run.id, toolName: "load_skill" },
    });
    expect(skillInvocations.length).toBe(0);

    const loadedSkills = await db.runSkill.findMany({
      where: { runId: sent.run.id },
    });
    expect(loadedSkills.length).toBe(0);
  }, 60_000);
});
