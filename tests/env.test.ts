import { describe, expect, it } from "vitest";
import { serverEnvSchema, serverOnlyEnvSchema, taskEnvSchema } from "@/lib/env";

describe("Environment schema splitting", () => {
  const validTaskVars = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    LLM_API_KEY: "test-llm-key",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_MODEL: "openrouter/free" as const,
    MAGICA_BASE_URL: "https://api.magica.ai",
    MAGICA_API_KEY: "test-magica-key",
    MAX_AGENT_TURNS: "10",
  };

  const validServerVars = {
    ...validTaskVars,
    DIRECT_URL: "postgresql://user:pass@localhost:5432/direct_db",
    CLERK_SECRET_KEY: "sk_test_123",
    TRIGGER_SECRET_KEY: "tr_test_123",
    CLIENT_ORIGIN: "http://localhost:3000",
    TRANSLOADIT_KEY: "test_key",
    TRANSLOADIT_SECRET: "test_secret",
  };

  it("taskEnvSchema parses successfully with only the 7 task variables", () => {
    const result = taskEnvSchema.safeParse(validTaskVars);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MAX_AGENT_TURNS).toBe(10);
      expect(result.data.LLM_MODEL).toBe("openrouter/free");
    }
  });

  it("taskEnvSchema fails if a required task variable is missing", () => {
    const incomplete = { ...validTaskVars };
    delete (incomplete as Record<string, unknown>).DATABASE_URL;
    const result = taskEnvSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("serverEnvSchema requires all server variables", () => {
    const resultWithAll = serverEnvSchema.safeParse(validServerVars);
    expect(resultWithAll.success).toBe(true);

    const resultMissingClerk = serverEnvSchema.safeParse(validTaskVars);
    expect(resultMissingClerk.success).toBe(false);
  });

  it("serverOnlyEnvSchema isolates server-only variables", () => {
    const keys = Object.keys(serverOnlyEnvSchema.shape);
    expect(keys).toEqual([
      "DIRECT_URL",
      "CLERK_SECRET_KEY",
      "TRIGGER_SECRET_KEY",
      "CLIENT_ORIGIN",
      "TRANSLOADIT_KEY",
      "TRANSLOADIT_SECRET",
      "S3_BUCKET",
      "S3_KEY",
      "S3_SECRET",
      "S3_REGION",
      "S3_ENDPOINT",
    ]);
  });
});
