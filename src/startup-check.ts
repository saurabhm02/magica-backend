import { inspect } from "node:util";
import { runs } from "@trigger.dev/sdk";
import { STARTUP_CHECK_TIMEOUT_MS } from "@/lib/constants";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function checkConnections() {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, "database");
    logger.info("database connected");

    await withTimeout(runs.list({ limit: 1 }), "trigger.dev");
    logger.info("trigger.dev connected");
  } catch (error) {
    logger.error("startup check failed, server not started", { error: inspect(error, { depth: 2 }) });
    process.exit(1);
  }
}

function withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${name} did not answer in ${STARTUP_CHECK_TIMEOUT_MS}ms`)), STARTUP_CHECK_TIMEOUT_MS),
    ),
  ]);
}
