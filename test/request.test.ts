import { describe, it } from "node:test";
import assert from "node:assert";
import type { Message, UserMessage, AssistantMessage, SystemMessage } from "@earendil-works/pi-ai";
import { buildCloudCodeRequest } from "../src/request.ts";

describe("request.ts: buildCloudCodeRequest", () => {
  it("1. user message request mapping", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Hello from user",
        timestamp: Date.now(),
      } as UserMessage,
      {
        role: "user",
        content: [{ type: "text", text: "Multi-part user message" }],
        timestamp: Date.now(),
      } as UserMessage,
    ];

    const result = buildCloudCodeRequest("gemini-2.5-flash", { messages });
    assert.strictEqual(result.request.contents.length, 2);
    assert.strictEqual(result.request.contents[0].role, "user");
    assert.deepStrictEqual(result.request.contents[0].parts, [{ text: "Hello from user" }]);
    assert.strictEqual(result.request.contents[1].role, "user");
    assert.deepStrictEqual(result.request.contents[1].parts, [{ text: "Multi-part user message" }]);
  });

  it("2. assistant -> model mapping", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Hi",
        timestamp: Date.now(),
      } as UserMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello there!" }],
        api: "agy-pool-api",
        provider: "agy-pool",
        model: "gemini-2.5-flash",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as AssistantMessage,
    ];

    const result = buildCloudCodeRequest("gemini-2.5-flash", { messages });
    assert.strictEqual(result.request.contents.length, 2);
    assert.strictEqual(result.request.contents[0].role, "user");
    assert.strictEqual(result.request.contents[1].role, "model");
    assert.deepStrictEqual(result.request.contents[1].parts, [{ text: "Hello there!" }]);
  });

  it("3. systemInstruction mapping", () => {
    const messages: Message[] = [
      {
        role: "system",
        content: "You are a coding assistant.",
        timestamp: Date.now(),
      } as SystemMessage,
      {
        role: "user",
        content: "Test prompt",
        timestamp: Date.now(),
      } as UserMessage,
    ];

    const result = buildCloudCodeRequest("gemini-2.5-flash", { messages });
    assert.ok(result.request.systemInstruction);
    assert.strictEqual(result.request.systemInstruction.role, "user");
    assert.deepStrictEqual(result.request.systemInstruction.parts, [
      { text: "You are a coding assistant." },
    ]);
    // System message should not be present in contents
    assert.strictEqual(result.request.contents.length, 1);
    assert.strictEqual(result.request.contents[0].role, "user");
  });

  it("4. model ID propagation", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      } as UserMessage,
    ];

    const resultFlash = buildCloudCodeRequest("gemini-2.5-flash", { messages });
    assert.strictEqual(resultFlash.model, "gemini-2.5-flash");

    const resultPro = buildCloudCodeRequest("gemini-2.5-pro", { messages });
    assert.strictEqual(resultPro.model, "gemini-2.5-pro");
  });
});
