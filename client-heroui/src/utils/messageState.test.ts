import { describe, expect, it } from "vitest";
import {
  appendAIChunk,
  appendA2UIPayload,
  addOptimisticMessage,
  completeAIMessage,
  deleteMessageById,
  editMessageAndTruncateAfter,
  editMessageContent,
  getMessageById,
  markOptimisticMessageFailed,
  replaceMessage,
  replaceOptimisticMessage,
  sortMessages,
  truncateBeforeMessage,
  upsertMessage,
} from "./messageState";
import { Message } from "./types";

const message = (overrides: Partial<Message>): Message => ({
  id: "m1",
  clientId: "client-1",
  content: "hello",
  roomId: "room-1",
  timestamp: "2026-05-03T10:00:00.000Z",
  messageType: "text",
  ...overrides,
});

describe("messageState", () => {
  it("sorts by timestamp, puts streaming AI after same-time user messages, then by id", () => {
    const sorted = sortMessages([
      message({ id: "z", timestamp: "2026-05-03T10:00:01.000Z" }),
      message({ id: "ai", clientId: "ai_assistant", status: "streaming" }),
      message({ id: "a" }),
    ]);

    expect(sorted.map(item => item.id)).toEqual(["a", "ai", "z"]);
  });

  it("keeps updated messages ordered by their original timestamp", () => {
    const sorted = sortMessages([
      message({
        id: "edited",
        timestamp: "2026-05-03T10:00:00.000Z",
        updatedAt: "2026-05-03T10:05:00.000Z",
      }),
      message({
        id: "later",
        timestamp: "2026-05-03T10:01:00.000Z",
      }),
    ]);

    expect(sorted.map(item => item.id)).toEqual(["edited", "later"]);
  });

  it("upserts without duplicating existing messages", () => {
    const first = message({ id: "m1" });
    const duplicate = message({ id: "m1", content: "duplicate" });
    const next = message({ id: "m2", timestamp: "2026-05-03T10:00:01.000Z" });

    expect(upsertMessage([first], duplicate)).toEqual([duplicate]);
    expect(upsertMessage([first], next).map(item => item.id)).toEqual(["m1", "m2"]);
  });

  it("adds, replaces, dedupes, and fails optimistic messages by clientMessageId", () => {
    const pending = message({
      id: "temp-client-message-1",
      content: "pending text",
      clientMessageId: "client-message-1",
      deliveryStatus: "pending",
    });
    const saved = message({
      id: "server-message-1",
      content: "saved text",
      clientMessageId: "client-message-1",
    });

    const withPending = addOptimisticMessage([], pending);
    expect(withPending).toEqual([pending]);
    expect(addOptimisticMessage(withPending, pending)).toEqual([pending]);

    const replaced = replaceOptimisticMessage(withPending, "client-message-1", saved);
    expect(replaced).toEqual([{ ...saved, deliveryStatus: "sent" }]);

    const duplicateBroadcast = upsertMessage(replaced, saved);
    expect(duplicateBroadcast).toEqual([{ ...saved, deliveryStatus: "sent" }]);

    const failed = markOptimisticMessageFailed(withPending, "client-message-1", "network down");
    expect(failed[0]).toMatchObject({
      id: "temp-client-message-1",
      deliveryStatus: "failed",
      deliveryError: "network down",
    });
  });

  it("appends AI chunks and marks completion metadata", () => {
    const ai = message({ id: "ai1", clientId: "ai_assistant", content: "hel", messageType: "ai", status: "streaming" });
    const chunked = appendAIChunk([ai], "ai1", "lo");

    expect(chunked[0].content).toBe("hello");
    expect(chunked[0].status).toBe("streaming");

    const completed = completeAIMessage(chunked, "ai1", {
      aiModel: { id: "gpt", apiModel: "openai/gpt", provider: "openrouter", label: "GPT" },
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, source: "reported" },
      cost: { currency: "USD", inputUsd: 1, outputUsd: 2, totalUsd: 3, inputPerMillion: 1, outputPerMillion: 2, estimated: false },
    });

    expect(completed[0].status).toBe("complete");
    expect(completed[0].aiModel?.id).toBe("gpt");
    expect(completed[0].usage?.totalTokens).toBe(3);
    expect(completed[0].cost?.totalUsd).toBe(3);
  });

  it("uses final AI stream content when a client missed earlier chunks", () => {
    const ai = message({ id: "ai1", clientId: "ai_assistant", content: "to: question", messageType: "ai", status: "streaming" });

    const completed = completeAIMessage([ai], "ai1", {
      content: "E2E AI response to: question",
      aiModel: { id: "gpt", apiModel: "openai/gpt", provider: "openrouter", label: "GPT" },
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, source: "reported" },
      cost: { currency: "USD", inputUsd: 1, outputUsd: 2, totalUsd: 3, inputPerMillion: 1, outputPerMillion: 2, estimated: false },
    });

    expect(completed[0].content).toBe("E2E AI response to: question");
    expect(completed[0].status).toBe("complete");
  });

  it("preserves message order while updating streaming AI messages", () => {
    const later = message({ id: "later", timestamp: "2026-05-03T10:00:02.000Z" });
    const ai = message({ id: "ai1", clientId: "ai_assistant", content: "hel", messageType: "ai", status: "streaming" });

    const chunked = appendAIChunk([later, ai], "ai1", "lo");
    expect(chunked.map(item => item.id)).toEqual(["later", "ai1"]);

    const completed = completeAIMessage(chunked, "ai1", {
      aiModel: { id: "gpt", apiModel: "openai/gpt", provider: "openrouter", label: "GPT" },
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, source: "reported" },
      cost: { currency: "USD", inputUsd: 1, outputUsd: 2, totalUsd: 3, inputPerMillion: 1, outputPerMillion: 2, estimated: false },
    });
    expect(completed.map(item => item.id)).toEqual(["later", "ai1"]);
  });

  it("finds, edits, replaces, and deletes messages by id", () => {
    const first = message({ id: "m1", content: "first" });
    const second = message({
      id: "m2",
      content: "second",
      uiPayload: {
        format: "a2ui",
        version: "v0.9",
        messages: [{ version: "v0.9", createSurface: { surfaceId: "surface-1", catalogId: "catalog-1" } }],
      },
    });
    const { uiPayload: _uiPayload, ...secondWithoutUiPayload } = second;
    const updatedSecond = message({ id: "m2", content: "server second", timestamp: "2026-05-03T10:00:02.000Z" });

    expect(getMessageById([first, second], "m2")).toBe(second);
    expect(getMessageById([first], "missing")).toBeNull();
    expect(editMessageContent([first, second], "m2", "local second")).toEqual([
      first,
      { ...secondWithoutUiPayload, content: "local second" },
    ]);
    expect(replaceMessage([first, second], updatedSecond)).toEqual([first, updatedSecond]);
    expect(deleteMessageById([first, second], "m1")).toEqual([second]);
  });

  it("appends streaming A2UI payloads to AI messages", () => {
    const ai = message({
      id: "ai1",
      clientId: "ai_assistant",
      messageType: "ai",
      status: "streaming",
      uiPayload: {
        format: "a2ui",
        version: "v0.9",
        messages: [{ version: "v0.9", createSurface: { surfaceId: "surface-1", catalogId: "catalog-1" } }],
      },
    });

    const updated = appendA2UIPayload([ai], "ai1", {
      format: "a2ui",
      version: "v0.9",
      messages: [{ version: "v0.9", updateDataModel: { surfaceId: "surface-1", path: "/", value: { title: "Ready" } } }],
    });

    expect(updated[0].uiPayload?.messages).toHaveLength(2);
    expect(updated[0].status).toBe("streaming");
  });

  it("truncates message history for edit-and-ask and AI retry flows", () => {
    const user = message({ id: "u1", content: "question" });
    const ai = message({ id: "ai1", clientId: "ai_assistant", messageType: "ai", content: "answer" });
    const tail = message({ id: "tail", content: "after" });

    expect(editMessageAndTruncateAfter([user, ai, tail], "u1", "new question")).toEqual({
      found: true,
      messages: [{ ...user, content: "new question" }],
    });
    expect(editMessageAndTruncateAfter([user, ai], "missing", "new")).toEqual({
      found: false,
      messages: [user, ai],
    });
    expect(truncateBeforeMessage([user, ai, tail], "ai1")).toEqual({
      found: true,
      messages: [user],
    });
    expect(truncateBeforeMessage([user, ai], "missing")).toEqual({
      found: false,
      messages: [user, ai],
    });
  });
});
