import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { metadata } from "@trigger.dev/sdk";
import * as llmModule from "@/agent/llm";
import { formatSuggestion, formatTitle } from "@/agent/llm";
import { db } from "@/lib/db";
import type { LlmEvent } from "@/lib/types";
import { createChat, updateChat } from "@/modules/chats/chats";
import { sendMessage, toMessageDTO } from "@/modules/messages/messages";
import { runAgentTurn } from "@/trigger/agent-turn";

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { clerkUserId: `test_titles_${randomUUID()}` },
  });
  userId = user.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.creditLedger.deleteMany({ where: { userId } });
  await db.toolInvocation.deleteMany({ where: { run: { userId } } });
  await db.agentRun.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { chat: { userId } } });
  await db.chat.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("Format helpers", () => {
  it("formatTitle ensures 2-5 words in Title Case and removes quotes", () => {
    expect(formatTitle('"greeting"')).toBe("Greeting");
    expect(formatTitle("make a red apple image")).toBe("Make A Red Apple Image");
    expect(formatTitle("one two three four five six seven")).toBe("One Two Three Four Five");
    expect(formatTitle("")).toBe("");
  });

  it("formatSuggestion ensures lowercase start, max 8 words, strips trailing punctuation", () => {
    expect(formatSuggestion("Try a lifestyle setting.")).toBe("try a lifestyle setting");
    expect(formatSuggestion('"Animate the Tokyo one into a video!"')).toBe("animate the Tokyo one into a video");
    expect(formatSuggestion("one two three four five six seven eight nine ten")).toBe(
      "one two three four five six seven eight",
    );
    expect(formatSuggestion("")).toBe("");
  });
});

describe("Chat Titles and Suggested Next Steps", () => {
  it("title starts before the reply finishes and renames mid-run in metadata", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "make a red apple image",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    let titleStartedAt: number | null = null;
    let replyFinishedAt: number | null = null;

    vi.spyOn(llmModule, "generateChatTitle").mockImplementation(async () => {
      titleStartedAt = Date.now();
      return "Red Apple Image";
    });

    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValue("try a green apple next");

    async function* gen(): AsyncGenerator<LlmEvent> {
      await new Promise((r) => setTimeout(r, 50));
      yield { type: "text-delta", text: "Here is your red apple image." };
      replyFinishedAt = Date.now();
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());

    const replacedMetadata: Record<string, unknown>[] = [];
    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      replacedMetadata.push(JSON.parse(JSON.stringify(data)));
    });
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    await runAgentTurn(runId, "trace_title_midrun");

    // Title was started before the reply finished
    expect(titleStartedAt).not.toBeNull();
    expect(replyFinishedAt).not.toBeNull();
    expect(titleStartedAt!).toBeLessThanOrEqual(replyFinishedAt!);

    // Chat title in DB was updated to the AI title
    const updatedChat = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(updatedChat.title).toBe("Red Apple Image");

    // Metadata mid-run or final received chatTitle
    const withTitle = replacedMetadata.find((m) => m.chatTitle === "Red Apple Image");
    expect(withTitle).toBeDefined();
  });

  it("'complete' metadata is sent BEFORE the suggestion call starts", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "design a clean minimal logo",
      clientRequestId: randomUUID(),
      planMode: false,
    });
    const runId = sent.run.id;

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Here is a clean minimal logo." };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());
    vi.spyOn(llmModule, "generateChatTitle").mockResolvedValue("Minimal Logo");

    let completeMetadataSentBeforeSuggestion = false;
    const metadataStates: string[] = [];

    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      if (data && typeof data === "object" && "status" in data && typeof data.status === "string") {
        metadataStates.push(data.status);
      }
    });
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    vi.spyOn(llmModule, "generateSuggestion").mockImplementation(async () => {
      // Check if 'complete' status has already been emitted via metadata.replace
      if (metadataStates.includes("complete")) {
        completeMetadataSentBeforeSuggestion = true;
      }
      return "export to svg";
    });

    await runAgentTurn(runId, "trace_complete_before_suggestion");

    // Verification: 'complete' was sent BEFORE suggestion started
    expect(completeMetadataSentBeforeSuggestion).toBe(true);

    // Assistant message in DB has suggestion saved
    const assistantMsg = await db.message.findFirstOrThrow({
      where: { chatId: chat.id, role: "assistant" },
    });
    expect(assistantMsg.suggestion).toBe("export to svg");
    expect(toMessageDTO(assistantMsg).suggestion).toBe("export to svg");
  });

  it("title is set once and never overwritten on subsequent turns", async () => {
    const chat = await createChat(userId);
    const sent1 = await sendMessage(userId, chat.id, {
      content: "make a red apple image",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "First reply." };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());
    vi.spyOn(metadata, "replace").mockImplementation(() => {});
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    const titleSpy = vi.spyOn(llmModule, "generateChatTitle").mockResolvedValueOnce("Red Apple Image");
    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValueOnce("try a green apple next");

    await runAgentTurn(sent1.run.id, "trace_turn_1");
    expect(titleSpy).toHaveBeenCalledTimes(1);

    const chatAfterTurn1 = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(chatAfterTurn1.title).toBe("Red Apple Image");

    // Second turn in same chat
    const sent2 = await sendMessage(userId, chat.id, {
      content: "now add water droplets",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    titleSpy.mockClear();
    const suggestionSpyTurn2 = vi.spyOn(llmModule, "generateSuggestion").mockResolvedValueOnce("make it shiny");

    await runAgentTurn(sent2.run.id, "trace_turn_2");

    // Turn 2 does NOT start generateChatTitle
    expect(titleSpy).not.toHaveBeenCalled();
    // Turn 2 DOES generate suggestion
    expect(suggestionSpyTurn2).toHaveBeenCalled();

    // Chat title remains "Red Apple Image"
    const chatAfterTurn2 = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(chatAfterTurn2.title).toBe("Red Apple Image");
  });

  it("never overwrites a user rename", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "generate a logo",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    // User renames chat
    await updateChat(userId, chat.id, { title: "My Custom Brand Name" });

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Logo generated." };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());
    vi.spyOn(metadata, "replace").mockImplementation(() => {});
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    const titleSpy = vi.spyOn(llmModule, "generateChatTitle").mockResolvedValue("AI Title");
    vi.spyOn(llmModule, "generateSuggestion").mockResolvedValue("export as svg");

    await runAgentTurn(sent.run.id, "trace_rename_test");

    // Title should not even be started, or if checked, never saved
    expect(titleSpy).not.toHaveBeenCalled();

    // Chat title remains the user rename
    const currentChat = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(currentChat.title).toBe("My Custom Brand Name");
  });

  it("a slow follow-up (fake 20s) is cut at the timeout and the run still succeeds", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "write a story",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    async function* gen(): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "Once upon a time..." };
      yield { type: "done", model: "test-model" };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => gen());
    vi.spyOn(metadata, "replace").mockImplementation(() => {});
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    // Simulate slow 20s title and suggestion by having AbortSignal timeout abort them
    vi.spyOn(llmModule, "generateChatTitle").mockImplementation(async () => {
      // Simulate waiting longer than timeout
      return new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve("Slow Story Title"), 20_000);
      });
    });

    vi.spyOn(llmModule, "generateSuggestion").mockImplementation(async () => {
      // Simulate slow suggestion timing out immediately via AbortSignal
      const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      throw err;
    });

    // Run must NOT throw or crash
    const startTime = Date.now();
    await expect(runAgentTurn(sent.run.id, "trace_slow_followup")).resolves.not.toThrow();
    const elapsed = Date.now() - startTime;

    // The run finished successfully without waiting the full 20s
    expect(elapsed).toBeLessThan(15_000);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: sent.run.id } });
    expect(run.status).toBe("succeeded");
  });

  it("no suggestion for errors or cancelled runs", async () => {
    const chat = await createChat(userId);
    const sent = await sendMessage(userId, chat.id, {
      content: "trigger an error",
      clientRequestId: randomUUID(),
      planMode: false,
    });

    async function* errorGen(): AsyncGenerator<LlmEvent> {
      yield { type: "error", code: "LLM_UNAVAILABLE", message: "Service down", retryable: false };
    }
    vi.spyOn(llmModule, "streamChat").mockImplementation(() => errorGen());

    const suggestionSpy = vi.spyOn(llmModule, "generateSuggestion");

    const replacedMetadata: Record<string, unknown>[] = [];
    vi.spyOn(metadata, "replace").mockImplementation((data) => {
      replacedMetadata.push(JSON.parse(JSON.stringify(data)));
    });
    vi.spyOn(metadata, "set").mockReturnValue(metadata);

    await runAgentTurn(sent.run.id, "trace_error_run");

    // Suggestion was not called
    expect(suggestionSpy).not.toHaveBeenCalled();

    // Run status failed
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: sent.run.id } });
    expect(run.status).toBe("failed");

    // Message has no suggestion
    const assistantMsg = await db.message.findFirstOrThrow({
      where: { chatId: chat.id, role: "assistant" },
    });
    expect(assistantMsg.suggestion).toBeNull();

    // Final metadata has no suggestion
    const finalMeta = replacedMetadata.at(-1);
    expect(finalMeta?.status).toBe("failed");
    expect(finalMeta?.suggestion).toBeUndefined();
  });
});
