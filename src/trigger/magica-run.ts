import type { SafeError } from "@/contracts/errors";
import type { MagicaRunResult } from "@/contracts/tools";
import { task, wait } from "@trigger.dev/sdk";
import { getRun, runNode } from "@/agent/magica";
import {
  MAGICA_INITIAL_POLL_DELAY_S,
  MAGICA_MAX_POLL_DELAY_S,
  MAGICA_TIMEOUT_MS,
  SAFE_ERROR_MESSAGES,
} from "@/lib/constants";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export type MagicaRunPayload = {
  toolInvocationId: string;
  nodeType: string;
  subModelId?: string;
  params: Record<string, unknown>;
};

export async function executeMagicaRun(
  { toolInvocationId, nodeType, subModelId, params }: MagicaRunPayload,
  options?: {
    signal?: AbortSignal;
    sleep?: (seconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ output: Record<string, unknown>; creditUsed?: number }> {
  const invocation = await db.toolInvocation.findUniqueOrThrow({
    where: { id: toolInvocationId },
  });

  let magicaRunId = invocation.magicaRunId;

  const fetchOptions = {
    signal: options?.signal,
  };

  if (!magicaRunId) {
    const res = await runNode(nodeType, { subModelId, input: params }, fetchOptions);
    magicaRunId = res.runId;
    await db.toolInvocation.update({
      where: { id: toolInvocationId },
      data: { magicaRunId, status: "running" },
    });
  }

  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? MAGICA_TIMEOUT_MS;
  const sleepFn = options?.sleep ?? ((s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000)));
  let delaySeconds = MAGICA_INITIAL_POLL_DELAY_S;

  while (Date.now() - startTime < timeoutMs) {
    if (options?.signal?.aborted) {
      throw new AppError("INTERNAL", "Operation aborted", false);
    }

    await sleepFn(delaySeconds);
    delaySeconds = Math.min(delaySeconds * 2, MAGICA_MAX_POLL_DELAY_S);

    const run = await getRun(magicaRunId, fetchOptions);

    if (run.status === "COMPLETED") {
      return {
        output: run.output ?? {},
        creditUsed: run.creditUsed,
      };
    }

    if (run.status === "FAILED" || run.status === "CANCELED") {
      if (run.userMessage) {
        logger.warn("magica run failed with provider message", {
          runId: magicaRunId,
          userMessage: run.userMessage,
        });
      }
      throw new AppError("MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, false);
    }
  }

  throw new AppError("MAGICA_TIMEOUT", SAFE_ERROR_MESSAGES.MAGICA_TIMEOUT, false);
}

export { type MagicaRunResult } from "@/contracts/tools";

export const magicaRun = task({
  id: "magica-run",
  retry: { maxAttempts: 1 },
  run: async (payload: MagicaRunPayload, { signal }): Promise<MagicaRunResult> => {
    try {
      const res = await executeMagicaRun(payload, {
        signal,
        sleep: (seconds) => wait.for({ seconds }),
      });
      return { ok: true, output: res.output, creditUsed: res.creditUsed };
    } catch (err) {
      const error: SafeError =
        err instanceof AppError
          ? { code: err.code, message: err.message, retryable: err.retryable }
          : { code: "INTERNAL", message: SAFE_ERROR_MESSAGES.INTERNAL, retryable: false };
      return { ok: false, error };
    }
  },
});
