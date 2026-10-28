import { expect, test } from "vitest";
import { RunMetadata } from "./run";

test("accepts metadata with only status set", () => {
  const result = RunMetadata.safeParse({ status: "thinking" });
  expect(result.success).toBe(true);
});

test("rejects a status outside the known set", () => {
  const result = RunMetadata.safeParse({ status: "done" });
  expect(result.success).toBe(false);
});
