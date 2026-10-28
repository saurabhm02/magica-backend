import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { ErrorResponse } from "@/contracts/errors";
import { GENERIC_SAFE_MESSAGE } from "@/lib/constants";
import { AppError, errorResponse } from "@/lib/errors";
import { parseInput } from "@/lib/http";

test("bad input becomes VALIDATION_FAILED naming the field", () => {
  const schema = z.object({ title: z.string().max(3) });
  expect(() => parseInput(schema, { title: "too long" })).toThrow(/^title: /);
});

test("our own errors keep their status", async () => {
  const res = errorResponse(new AppError("NOT_FOUND", "Chat not found"), "trace-1");
  expect(res.status).toBe(404);
  expect(((await res.json()) as ErrorResponse).error.code).toBe("NOT_FOUND");
});

test("unexpected errors become a logged 500 that hides the details", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = errorResponse(new Error("db exploded"), "trace-2");
  const body = (await res.json()) as ErrorResponse;
  expect(res.status).toBe(500);
  expect(body.error).toMatchObject({ code: "INTERNAL", message: GENERIC_SAFE_MESSAGE, traceId: "trace-2" });
  expect(log.mock.calls[0]?.[0]).toContain("trace-2");
  log.mockRestore();
});
