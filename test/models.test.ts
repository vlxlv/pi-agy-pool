import { describe, it } from "node:test";
import assert from "node:assert";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { MODELS } from "../src/models.ts";
import { buildCloudCodeRequest } from "../src/request.ts";

describe("models.ts: catalog verification", () => {
  it("1. contains expected provider model IDs", () => {
    const modelIds = MODELS.map((m) => m.id);

    // Current Gemini Flash models
    assert.ok(modelIds.includes("gemini-3.6-flash-high"));
    assert.ok(modelIds.includes("gemini-3.6-flash-medium"));
    assert.ok(modelIds.includes("gemini-3.6-flash-low"));

    // Current Gemini Pro models
    assert.ok(modelIds.includes("gemini-pro-agent"));
    assert.ok(modelIds.includes("gemini-3.1-pro-low"));

    // Utility & Fast Flash models
    assert.ok(modelIds.includes("gemini-3.5-flash-lite"));
    assert.ok(modelIds.includes("gemini-3-flash"));

    // Anthropic Claude models via Cloud Code PA
    assert.ok(modelIds.includes("claude-sonnet-4-6"));
    assert.ok(modelIds.includes("claude-opus-4-6-thinking"));

    // OpenAI / OSS model via Cloud Code PA
    assert.ok(modelIds.includes("gpt-oss-120b-medium"));

    // Legacy compatibility
    assert.ok(modelIds.includes("gemini-2.5-flash"));
  });

  it("2. no duplicate model IDs", () => {
    const modelIds = MODELS.map((m) => m.id);
    const uniqueIds = new Set(modelIds);
    assert.strictEqual(
      uniqueIds.size,
      modelIds.length,
      `Detected duplicate model IDs in catalog: ${modelIds.filter((id, idx) => modelIds.indexOf(id) !== idx)}`,
    );
  });

  it("3. every exposed model has required Pi metadata", () => {
    for (const model of MODELS) {
      assert.ok(typeof model.id === "string" && model.id.length > 0, `Model missing id`);
      assert.ok(typeof model.name === "string" && model.name.length > 0, `${model.id} missing name`);
      assert.strictEqual(model.reasoning, false, `${model.id} reasoning must be false in V0.1.1`);
      assert.deepStrictEqual(model.input, ["text"], `${model.id} input must be text only`);
      assert.ok(model.cost, `${model.id} missing cost`);
      assert.strictEqual(model.cost.input, 0);
      assert.strictEqual(model.cost.output, 0);
      assert.strictEqual(model.cost.cacheRead, 0);
      assert.strictEqual(model.cost.cacheWrite, 0);
      assert.ok(
        typeof model.contextWindow === "number" && model.contextWindow > 0,
        `${model.id} invalid contextWindow`,
      );
      assert.ok(
        typeof model.maxTokens === "number" && model.maxTokens > 0,
        `${model.id} invalid maxTokens`,
      );
    }
  });

  it("4. model ID is forwarded unchanged into the Cloud Code request", () => {
    const dummyContext = {
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        } as UserMessage,
      ],
    };

    for (const model of MODELS) {
      const request = buildCloudCodeRequest(model.id, dummyContext);
      assert.strictEqual(
        request.model,
        model.id,
        `Expected request.model to match ${model.id}`,
      );
    }
  });
});
