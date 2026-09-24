import { describe, it } from "node:test";
import assert from "node:assert";
import {
  API_IDENTIFIER,
  DEFAULT_PROVIDER_NAME,
  MODELS,
  VERIFIED_MODELS,
} from "../src/models.ts";

describe("models.ts: catalog verification", () => {
  it("contains exactly 7 canonical native AGY models", () => {
    const expectedIds = [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ];

    assert.strictEqual(MODELS.length, 7);
    const actualIds = MODELS.map((m) => m.id);
    assert.deepStrictEqual(actualIds, expectedIds);
  });

  it("no duplicate model IDs", () => {
    const modelIds = MODELS.map((m) => m.id);
    const uniqueIds = new Set(modelIds);
    assert.strictEqual(
      uniqueIds.size,
      modelIds.length,
      `Detected duplicate model IDs in catalog`,
    );
  });

  it("every exposed model has required Pi metadata", () => {
    for (const model of MODELS) {
      assert.ok(typeof model.id === "string" && model.id.length > 0, `Model missing id`);
      assert.ok(typeof model.name === "string" && model.name.length > 0, `${model.id} missing name`);
      assert.strictEqual(model.reasoning, false, `${model.id} reasoning must be false`);
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

  it("exports provider constants", () => {
    assert.strictEqual(DEFAULT_PROVIDER_NAME, "agy-pool");
    assert.strictEqual(API_IDENTIFIER, "agy-pool-api");
    assert.strictEqual(VERIFIED_MODELS, MODELS);
  });
});
