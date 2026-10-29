import { z } from "zod";

export const taskEnvSchema = z.object({
  DATABASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.url(),
  LLM_MODEL: z.literal("openrouter/free"),
  MAGICA_BASE_URL: z.url(),
  MAGICA_API_KEY: z.string().min(1),
  MAX_AGENT_TURNS: z.coerce.number().int().positive(),
});

export const serverOnlyEnvSchema = z.object({
  DIRECT_URL: z.url(),
  CLERK_SECRET_KEY: z.string().min(1),
  TRIGGER_SECRET_KEY: z.string().min(1),
  CLIENT_ORIGIN: z.url(),
});

export const serverEnvSchema = taskEnvSchema.extend(serverOnlyEnvSchema.shape);

export type TaskEnv = z.infer<typeof taskEnvSchema>;
export type ServerOnlyEnv = z.infer<typeof serverOnlyEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

function parseEnv<T>(schema: z.ZodType<T>, source: unknown, label: string): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ${label} environment variables:\n${issues}`);
  }
  return parsed.data;
}

function loadTaskEnv(): TaskEnv {
  return parseEnv(taskEnvSchema, process.env, "task");
}

let cachedServerEnv: ServerEnv | null = null;
export function getServerEnv(): ServerEnv {
  if (!cachedServerEnv) {
    cachedServerEnv = parseEnv(serverEnvSchema, process.env, "server");
  }
  return cachedServerEnv;
}

export const taskEnv = loadTaskEnv();

export const serverEnv = new Proxy({} as ServerEnv, {
  get(_target, prop: string | symbol) {
    return getServerEnv()[prop as keyof ServerEnv];
  },
});

export const env = new Proxy({} as ServerEnv, {
  get(_target, prop: string | symbol) {
    if (typeof prop === "string" && prop in taskEnv) {
      return taskEnv[prop as keyof TaskEnv];
    }
    return getServerEnv()[prop as keyof ServerEnv];
  },
  has(_target, prop: string | symbol) {
    if (typeof prop === "string" && prop in taskEnv) {
      return true;
    }
    return prop in getServerEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(taskEnv);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === "string" && prop in taskEnv) {
      return {
        value: taskEnv[prop as keyof TaskEnv],
        writable: false,
        enumerable: true,
        configurable: true,
      };
    }
    return Reflect.getOwnPropertyDescriptor(getServerEnv(), prop);
  },
});
