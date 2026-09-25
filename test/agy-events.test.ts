import { describe, it } from "node:test";
import assert from "node:assert";
import { AgyEventDecoder } from "../src/agy-events.ts";

describe("agy-events.ts: AgyEventDecoder", () => {
  it("parses single event", () => {
    const decoder = new AgyEventDecoder();
    const events = decoder.feed('{"event":"init","conversation_id":"c1"}\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "init");
    assert.strictEqual((events[0] as { conversation_id: string }).conversation_id, "c1");
  });

  it("handles event split across chunks", () => {
    const decoder = new AgyEventDecoder();
    const e1 = decoder.feed('{"event":"step_update","step_');
    assert.strictEqual(e1.length, 0);

    const e2 = decoder.feed('update":{"text_delta":"hello"}}\n');
    assert.strictEqual(e2.length, 1);
    assert.strictEqual(e2[0].event, "step_update");
    assert.strictEqual(
      (e2[0] as { step_update: { text_delta: string } }).step_update.text_delta,
      "hello",
    );
  });

  it("handles multiple events in one chunk", () => {
    const decoder = new AgyEventDecoder();
    const chunk =
      '{"event":"step_update","step_update":{"text_delta":"a"}}\n' +
      '{"event":"step_update","step_update":{"text_delta":"b"}}\n' +
      '{"event":"result","status":"SUCCESS"}\n';
    const events = decoder.feed(chunk);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].event, "step_update");
    assert.strictEqual(events[1].event, "step_update");
    assert.strictEqual(events[2].event, "result");
    assert.strictEqual((events[2] as { status: string }).status, "SUCCESS");
  });

  it("handles CRLF and LF framing correctly", () => {
    const decoder = new AgyEventDecoder();
    const chunk =
      '{"event":"init","conversation_id":"c1"}\r\n' +
      '{"event":"result","status":"SUCCESS"}\n';
    const events = decoder.feed(chunk);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, "init");
    assert.strictEqual(events[1].event, "result");
  });

  it("handles partial UTF-8 multibyte characters split across network chunks", () => {
    const decoder = new AgyEventDecoder();
    // Multi-byte character: 🚀 (F0 9F 99 80)
    const rocket = Buffer.from("🚀", "utf8");
    const prefix = Buffer.from('{"event":"step_update","step_update":{"text_delta":"', "utf8");
    const suffix = Buffer.from('"}}\n', "utf8");

    // Chunk 1: prefix + first 2 bytes of rocket
    const chunk1 = Buffer.concat([prefix, rocket.subarray(0, 2)]);
    // Chunk 2: last 2 bytes of rocket + suffix
    const chunk2 = Buffer.concat([rocket.subarray(2), suffix]);

    const events1 = decoder.feed(chunk1);
    assert.strictEqual(events1.length, 0);

    const events2 = decoder.feed(chunk2);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(
      (events2[0] as { step_update: { text_delta: string } }).step_update.text_delta,
      "🚀",
    );
  });

  it("handles malformed JSON without corrupting subsequent parser state", () => {
    const decoder = new AgyEventDecoder();
    const chunk =
      '{"event":"bad JSON\n' +
      '{"event":"step_update","step_update":{"text_delta":"valid"}}\n';
    const events = decoder.feed(chunk);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "step_update");
    assert.strictEqual(
      (events[0] as { step_update: { text_delta: string } }).step_update.text_delta,
      "valid",
    );
  });

  it("ignores empty lines", () => {
    const decoder = new AgyEventDecoder();
    const chunk = "\n\n   \n\r\n";
    const events = decoder.feed(chunk);
    assert.strictEqual(events.length, 0);
  });

  it("flushes trailing line if no final newline", () => {
    const decoder = new AgyEventDecoder();
    decoder.feed('{"event":"result","status":"SUCCESS"}');
    const flushed = decoder.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].event, "result");
  });

  it("parses usage metadata correctly", () => {
    const decoder = new AgyEventDecoder();
    const chunk =
      '{"event":"step_update","step_update":{"role":"model","status":"DONE","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30,"thinking_tokens":5}}}\n';
    const events = decoder.feed(chunk);
    assert.strictEqual(events.length, 1);
    const update = (events[0] as { step_update: { usage: Record<string, number> } }).step_update;
    assert.strictEqual(update.usage.input_tokens, 10);
    assert.strictEqual(update.usage.output_tokens, 20);
    assert.strictEqual(update.usage.total_tokens, 30);
    assert.strictEqual(update.usage.thinking_tokens, 5);
  });

  it("enforces maximum record size and throws cleanly on record overflow", () => {
    // Test with small limit of 50 UTF-16 code units
    const decoder = new AgyEventDecoder(50);
    const oversizedRecord = '{"event":"step_update","step_update":{"text_delta":"' + "a".repeat(100) + '"}}\n';
    assert.throws(
      () => decoder.feed(oversizedRecord),
      /NDJSON record size exceeded limit of 50 UTF-16 code units/,
    );
  });

  it("enforces maximum buffer size without line delimiter and throws cleanly", () => {
    const decoder = new AgyEventDecoder(50);
    const endlessChunk = "x".repeat(60);
    assert.throws(
      () => decoder.feed(endlessChunk),
      /NDJSON buffer limit exceeded \(50 UTF-16 code units\) without valid line delimiter/,
    );

    // After overflow, buffer is cleared and subsequent valid data can be parsed
    const valid = decoder.feed('{"event":"init","conversation_id":"fresh"}\n');
    assert.strictEqual(valid.length, 1);
    assert.strictEqual(valid[0].event, "init");
  });
});
