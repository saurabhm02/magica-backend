import { expect, test } from "vitest";
import { MAX_MESSAGE_LENGTH, SendMessageRequest } from "./api";

test("accepts a normal send request", () => {
  const result = SendMessageRequest.safeParse({
    content: "make a 16:9 cover and crop it square",
    clientRequestId: "uuid-from-client",
  });
  expect(result.success).toBe(true);
});

test("rejects empty content", () => {
  const result = SendMessageRequest.safeParse({
    content: "",
    clientRequestId: "uuid-from-client",
  });
  expect(result.success).toBe(false);
});

test("rejects content that is only spaces", () => {
  const result = SendMessageRequest.safeParse({
    content: "   ",
    clientRequestId: "uuid-from-client",
  });
  expect(result.success).toBe(false);
});

test("rejects content over the max length", () => {
  const result = SendMessageRequest.safeParse({
    content: "a".repeat(MAX_MESSAGE_LENGTH + 1),
    clientRequestId: "uuid-from-client",
  });
  expect(result.success).toBe(false);
});

test("rejects a model other than openrouter/free", () => {
  const result = SendMessageRequest.safeParse({
    content: "hello",
    clientRequestId: "uuid-from-client",
    model: "gpt-4",
  });
  expect(result.success).toBe(false);
});
