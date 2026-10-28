import { expect, test } from "vitest";
import { ContentBlock } from "./content-blocks";

test("accepts a text block", () => {
  const result = ContentBlock.safeParse({ type: "text", text: "hello" });
  expect(result.success).toBe(true);
});

test("rejects an unknown block type", () => {
  const result = ContentBlock.safeParse({ type: "image", text: "hello" });
  expect(result.success).toBe(false);
});
