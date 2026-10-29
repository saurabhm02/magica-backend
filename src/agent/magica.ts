import {
  MAGICA_CREDITS_EXHAUSTED_MESSAGE,
  SAFE_ERROR_MESSAGES,
} from "@/lib/constants";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

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

  if (res.status === 401) {
    throw new AppError("MAGICA_UNAUTHORIZED", SAFE_ERROR_MESSAGES.MAGICA_UNAUTHORIZED, false);
  }
  if (res.status === 403) {
    throw new AppError("MAGICA_UNAUTHORIZED", MAGICA_CREDITS_EXHAUSTED_MESSAGE, false);
  }
  if (res.status === 429) {
    throw new AppError("MAGICA_RATE_LIMITED", SAFE_ERROR_MESSAGES.MAGICA_RATE_LIMITED, true);
  }
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const msg =
      (typeof errorBody?.userMessage === "string" ? errorBody.userMessage : undefined) ||
      (typeof errorBody?.message === "string" ? errorBody.message : undefined) ||
      (typeof errorBody?.error === "string" ? errorBody.error : undefined) ||
      SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED;
    if (res.status === 400) {
      throw new AppError("TOOL_INPUT_INVALID", msg, false);
    }
    throw new AppError("MAGICA_RUN_FAILED", msg, false);
  }

  const data = (await res.json()) as { runId: string };
  return { runId: data.runId };
}

export async function getRun(
  runId: string,
  options?: MagicaFetchOptions | AbortSignal,
): Promise<MagicaRunResponse> {
  const opts: MagicaFetchOptions = options instanceof AbortSignal ? { signal: options } : (options ?? {});
  const url = `${baseUrl()}/v1/nodes/runs/${runId}`;
  const res = await fetchWithRetry(
    url,
    {
      headers: { Authorization: `Bearer ${env.MAGICA_API_KEY}` },
    },
    opts,
  );

  if (res.status === 401) {
    throw new AppError("MAGICA_UNAUTHORIZED", SAFE_ERROR_MESSAGES.MAGICA_UNAUTHORIZED, false);
  }
  if (res.status === 403) {
    throw new AppError("MAGICA_UNAUTHORIZED", MAGICA_CREDITS_EXHAUSTED_MESSAGE, false);
  }
  if (res.status === 429) {
    throw new AppError("MAGICA_RATE_LIMITED", SAFE_ERROR_MESSAGES.MAGICA_RATE_LIMITED, true);
  }
  if (!res.ok) {
    throw new AppError("MAGICA_RUN_FAILED", SAFE_ERROR_MESSAGES.MAGICA_RUN_FAILED, false);
  }

  return (await res.json()) as MagicaRunResponse;
}

const schemaCache = new Map<string, Promise<Record<string, unknown>>>();

export function fetchModelSchema(
  modelId: string,
  options?: MagicaFetchOptions | AbortSignal,
): Promise<Record<string, unknown>> {
  let cached = schemaCache.get(modelId);
  if (!cached) {
    cached = (async () => {
      const opts: MagicaFetchOptions = options instanceof AbortSignal ? { signal: options } : (options ?? {});
      const url = `${baseUrl()}/v1/models/${modelId}/schema`;
      const res = await fetchWithRetry(
        url,
        {
          headers: { Authorization: `Bearer ${env.MAGICA_API_KEY}` },
        },
        opts,
      );
      if (!res.ok) {
        schemaCache.delete(modelId);
        throw new AppError("MAGICA_RUN_FAILED", "Failed to fetch model schema", false);
      }
      return (await res.json()) as Record<string, unknown>;
    })();
    schemaCache.set(modelId, cached);
  }
  return cached;
}
