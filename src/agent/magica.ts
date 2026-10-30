import { SAFE_ERROR_MESSAGES } from "@/lib/constants";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export type MagicaRunResponse = {
  id: string;
  nodeType: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | string;
  subModelId?: string | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
  userMessage?: string | null;
  creditUsed?: number;
  source?: string | null;
  createdAt?: string;
};

export type MagicaFetchOptions = {
  signal?: AbortSignal;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

function magicaHeaders() {
  return {
    Authorization: `Bearer ${env.MAGICA_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function baseUrl() {
  return env.MAGICA_BASE_URL.replace(/\/$/, "");
}

function checkStatus(res: Response) {
  if (res.status === 401) {
    throw new AppError("MAGICA_UNAUTHORIZED", SAFE_ERROR_MESSAGES.MAGICA_UNAUTHORIZED, false);
  }
  if (res.status === 403) {
    throw new AppError("CREDITS_EXHAUSTED", SAFE_ERROR_MESSAGES.CREDITS_EXHAUSTED, false);
  }
  if (res.status === 429) {
    throw new AppError("MAGICA_RATE_LIMITED", SAFE_ERROR_MESSAGES.MAGICA_RATE_LIMITED, true);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: MagicaFetchOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 2;
  const sleepFn = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options?.signal?.aborted) {
      throw new AppError("INTERNAL", "Operation aborted", false);
    }
    const res = await fetch(url, { ...init, signal: options?.signal });
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterMs = res.headers.get("retry-after-ms");
      const retryAfter = res.headers.get("retry-after");
      let waitMs = 500 * Math.pow(2, attempt);
      if (retryAfterMs) {
        waitMs = parseInt(retryAfterMs, 10) || waitMs;
      } else if (retryAfter) {
        waitMs = (parseFloat(retryAfter) || 1) * 1000;
      }
      await sleepFn(waitMs);
      continue;
    }
    return res;
  }
  return fetch(url, { ...init, signal: options?.signal });
}

/**
 * Starts a Magica node run.
 *
 * Input:
 * - nodeType: the Magica node to run
 * - params: { subModelId?, input } sent as the request body
 * - options: an abort signal, or fetch options (signal, maxRetries, sleep)
 *
 * Output:
 * - { runId }: the Magica run id to poll with getRun
 *
 * Notes:
 * - 429 is retried with backoff (honours retry-after headers), up to maxRetries (default 2).
 * - 401 → MAGICA_UNAUTHORIZED, 403 → CREDITS_EXHAUSTED, 429 → MAGICA_RATE_LIMITED.
 * - 400 → TOOL_INPUT_INVALID with Magica's userMessage if given; other errors → MAGICA_RUN_FAILED.
 */
export async function runNode(
  nodeType: string,
  params: { subModelId?: string; input: Record<string, unknown> },
  options?: MagicaFetchOptions | AbortSignal,
): Promise<{ runId: string }> {
  const opts: MagicaFetchOptions = options instanceof AbortSignal ? { signal: options } : (options ?? {});
  const url = `${baseUrl()}/v1/nodes/${nodeType}/run`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: magicaHeaders(),
      body: JSON.stringify(params),
    },
    opts,
  );

  checkStatus(res);
  if (!res.ok) {
    if (res.status === 400) {
      const errorBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const msg = typeof errorBody?.userMessage === "string" ? errorBody.userMessage : SAFE_ERROR_MESSAGES.TOOL_INPUT_INVALID;
      throw new AppError("TOOL_INPUT_INVALID", msg, false);
    }
    throw new AppError("MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, false);
  }

  const data = (await res.json()) as { runId: string };
  return { runId: data.runId };
}

/**
 * Reads the current state of a Magica run.
 *
 * Input:
 * - runId: the Magica run id
 * - options: an abort signal, or fetch options (signal, maxRetries, sleep)
 *
 * Output:
 * - the Magica run: status, output, creditUsed, and any error or user message
 *
 * Notes:
 * - Same retry and error mapping as runNode; any other non-OK response → MAGICA_RUN_FAILED.
 */
export async function getRun(
  runId: string,
  options?: MagicaFetchOptions | AbortSignal,
): Promise<MagicaRunResponse> {
  const opts: MagicaFetchOptions = options instanceof AbortSignal ? { signal: options } : (options ?? {});
  const url = `${baseUrl()}/v1/nodes/runs/${runId}`;
  const res = await fetchWithRetry(
    url,
    {
      headers: magicaHeaders(),
    },
    opts,
  );

  checkStatus(res);
  if (!res.ok) {
    throw new AppError("MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, false);
  }

  return (await res.json()) as MagicaRunResponse;
}

const estimateCache = new Map<string, { value: number; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

export function clearEstimateCache() {
  estimateCache.clear();
}

/**
 * Asks Magica how many credits a node run will cost, used to size the credit hold.
 *
 * Input:
 * - nodeType, subModelId, data: what will be run
 * - fallback: the value to use if Magica can't answer
 *
 * Output:
 * - the estimate in microcredits
 *
 * Notes:
 * - Answers are cached in memory for one hour per node + model + input.
 * - Never throws: any failure or bad response returns the fallback.
 */
export async function estimateNodeCredits(params: {
  nodeType: string;
  subModelId?: string;
  data?: Record<string, unknown>;
  fallback: number;
}): Promise<number> {
  const cacheKey = `${params.nodeType}:${params.subModelId || ""}:${JSON.stringify(params.data ?? {})}`;
  const cached = estimateCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  try {
    const url = `${baseUrl()}/v1/nodes/estimate-credits`;
    const res = await fetch(url, {
      method: "POST",
      headers: magicaHeaders(),
      body: JSON.stringify({
        nodes: [
          {
            type: params.nodeType,
            subModelId: params.subModelId,
            data: params.data ?? {},
          },
        ],
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as { estimates?: Array<{ microcredits?: number }> };
      const microcredits = json.estimates?.[0]?.microcredits;
      if (typeof microcredits === "number" && microcredits >= 0) {
        estimateCache.set(cacheKey, { value: microcredits, expiresAt: Date.now() + CACHE_TTL_MS });
        return microcredits;
      }
    }
    logger.warn("Magica estimate-credits call returned non-ok status, falling back to constant", { nodeType: params.nodeType, status: res.status });
  } catch (err) {
    logger.warn("Magica estimate-credits call failed, falling back to constant", { nodeType: params.nodeType, err: String(err) });
  }

  return params.fallback;
}
