
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { inspect } = await import("node:util");
  const { logger } = await import("@/lib/logger");

  try {
    await import("@/lib/env"); 
    const { STARTUP_CHECK_TIMEOUT_MS } = await import("@/lib/constants");
    const { db } = await import("@/lib/db");
    const { runs } = await import("@trigger.dev/sdk");

    await withTimeout(db.$queryRaw`SELECT 1`, STARTUP_CHECK_TIMEOUT_MS, "database");
    logger.info("database connected");

    await withTimeout(runs.list({ limit: 1 }), STARTUP_CHECK_TIMEOUT_MS, "trigger.dev");
    logger.info("trigger.dev connected");
  } catch (error) {
    logger.error("startup check failed, server not started", { error: inspect(error, { depth: 2 }) });
    process.exit(1);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} did not answer in ${ms}ms`)), ms)),
  ]);
}
