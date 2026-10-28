import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  DIRECT_URL: z.url(),
  CLERK_SECRET_KEY: z.string().min(1),
  TRIGGER_SECRET_KEY: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.url(),
  LLM_MODEL: z.literal("openrouter/free"),
  MAGICA_BASE_URL: z.url(),
  MAGICA_API_KEY: z.string().min(1),
  TRANSLOADIT_KEY: z.string().min(1),
  TRANSLOADIT_SECRET: z.string().min(1),
  CLIENT_ORIGIN: z.url(),
  STARTING_CREDITS: z.coerce.number().int().positive(),
  MAX_AGENT_TURNS: z.coerce.number().int().positive(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
