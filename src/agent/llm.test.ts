import { afterEach, expect, test, vi } from "vitest";
import { streamChat } from "@/agent/llm";

function chunk(body: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, ...body })}\n\n`;
}

function sseStream(lines: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function collect(signal = new AbortController().signal) {
  const events = [];
  for await (const event of streamChat([{ role: "user", content: "hi" }], signal)) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a full stream yields text, usage, then done with the routed model", async () => {
  const fetchSpy = vi.fn().mockImplementation(
    async () =>
      new Response(
        sseStream([
          chunk({ model: "meta-llama/free", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
          chunk({
            model: "meta-llama/free",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(events).toEqual([
    { type: "text-delta", text: "Hi" },
    { type: "usage", promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    { type: "done", model: "meta-llama/free" },
  ]);
});

test("an empty stream maps to LLM_EMPTY_STREAM", async () => {
  const fetchSpy = vi.fn().mockImplementation(async () => new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(events).toEqual([{ type: "error", code: "LLM_EMPTY_STREAM", message: expect.any(String), retryable: true }]);
});

test("a 429 is retried, then maps to the safe LLM_RATE_LIMITED message, never the provider's raw text", async () => {
  const fetchSpy = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: { message: "some provider-specific rate limit text" } }), {
        status: 429,
        headers: { "retry-after-ms": "1" }, // keep the test fast \u2014 the SDK honors this header
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(fetchSpy.mock.calls.length).toBeGreaterThan(1); // retried at least once
  expect(events).toEqual([
    {
      type: "error",
      code: "LLM_RATE_LIMITED",
      message: "The free model is busy right now. Please try again in a moment.",
      retryable: true,
    },
  ]);
});

test("a 401 (bad key) is not retried", async () => {
  const fetchSpy = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify({ error: { message: "No auth" } }), { status: 401 }));
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    { type: "error", code: "LLM_UNAVAILABLE", message: "The model is unavailable right now. Please try again.", retryable: false },
  ]);
});

test("a cancelled run stops right away instead of retrying", async () => {
  const controller = new AbortController();
  const fetchSpy = vi.fn().mockImplementation(async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  });
  vi.stubGlobal("fetch", fetchSpy);

  await expect(collect(controller.signal)).rejects.toThrow();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("an error after the first token yields one error event and does not retry", async () => {
  const fetchSpy = vi.fn().mockImplementation(async () => {
    let reads = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          if (reads === 1) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk({ model: "m", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
              ),
            );
          } else {
            controller.error(new Error("connection dropped"));
          }
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(events[0]).toEqual({ type: "text-delta", text: "Hi" });
  expect(events.at(-1)).toMatchObject({ type: "error", code: "LLM_UNAVAILABLE" });
});

test("the model's reasoning streams as reasoning-delta, before the reply text", async () => {
  const fetchSpy = vi.fn().mockImplementation(
    async () =>
      new Response(
        sseStream([
          chunk({ model: "m", choices: [{ index: 0, delta: { reasoning: "The user wants..." }, finish_reason: null }] }),
          chunk({ model: "m", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  const events = await collect();

  expect(events.slice(0, 2)).toEqual([
    { type: "reasoning-delta", text: "The user wants..." },
    { type: "text-delta", text: "Hi" },
  ]);
});
