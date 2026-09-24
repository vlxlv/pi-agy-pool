import { describe, it } from "node:test";
import assert from "node:assert";
import { SseDecoder, extractSseEvent } from "../src/sse.ts";

describe("sse.ts: SseDecoder", () => {
  it("5. SSE single event", () => {
    const decoder = new SseDecoder();
    const raw =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Hello"}]}}]}}\r\n\r\n';
    const events = decoder.feed(raw);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].text, "Hello");
  });

  it("6. SSE event split across chunks", () => {
    const decoder = new SseDecoder();
    const chunk1 = 'data: {"response": {"candidates": [{"con';
    const chunk2 = 'tent": {"parts": [{"text": "Split text"}]}}]}}\r\n\r\n';

    const events1 = decoder.feed(chunk1);
    assert.strictEqual(events1.length, 0);

    const events2 = decoder.feed(chunk2);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(events2[0].text, "Split text");
  });

  it("7. multiple events in one chunk", () => {
    const decoder = new SseDecoder();
    const combined =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "One"}]}}]}}\r\n\r\n' +
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Two"}]}}]}}\r\n\r\n' +
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Three"}]}}]}}\r\n\r\n';

    const events = decoder.feed(combined);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].text, "One");
    assert.strictEqual(events[1].text, "Two");
    assert.strictEqual(events[2].text, "Three");
  });

  it("8. normal text extraction", () => {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "First part" }, { text: " Second part" }],
            },
          },
        ],
      },
    };
    const event = extractSseEvent(payload);
    assert.ok(event);
    assert.strictEqual(event.text, "First part Second part");
  });

  it("9. thought parts ignored in V0.1", () => {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { thought: true, text: "Internal thinking process" },
                { text: "Visible answer" },
              ],
            },
          },
        ],
      },
    };
    const event = extractSseEvent(payload);
    assert.ok(event);
    assert.strictEqual(event.text, "Visible answer");
  });

  it("10. finishReason handling", () => {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "" }],
            },
            finishReason: "STOP",
          },
        ],
      },
    };
    const event = extractSseEvent(payload);
    assert.ok(event);
    assert.strictEqual(event.finishReason, "STOP");
  });

  it("11. usageMetadata mapping", () => {
    const payload = {
      response: {
        candidates: [],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 25,
          totalTokenCount: 40,
          thoughtsTokenCount: 8,
        },
      },
    };
    const event = extractSseEvent(payload);
    assert.ok(event);
    assert.ok(event.usage);
    assert.strictEqual(event.usage.promptTokenCount, 15);
    assert.strictEqual(event.usage.candidatesTokenCount, 25);
    assert.strictEqual(event.usage.totalTokenCount, 40);
    assert.strictEqual(event.usage.thoughtsTokenCount, 8);
  });

  it("handles CRLF and LF framing correctly", () => {
    const decoder = new SseDecoder();
    const crlf =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "CRLF"}]}}]}}\r\n\r\n';
    const lf =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "LF"}]}}]}}\n\n';

    const events1 = decoder.feed(crlf);
    assert.strictEqual(events1.length, 1);
    assert.strictEqual(events1[0].text, "CRLF");

    const events2 = decoder.feed(lf);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(events2[0].text, "LF");
  });

  it("handles partial UTF-8 multibyte characters split across network chunks", () => {
    const decoder = new SseDecoder();
    const encoder = new TextEncoder();

    // String with 4-byte emoji 🚀 (bytes: 0xF0, 0x9F, 0x99, 0x80)
    const jsonStr =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Rocket 🚀"}]}}]}}\r\n\r\n';
    const fullBytes = encoder.encode(jsonStr);

    // Split in the middle of the 4-byte emoji (around byte offset where rocket emoji starts)
    const emojiIndex = jsonStr.indexOf("🚀");
    const prefixBytesLength = encoder.encode(jsonStr.slice(0, emojiIndex)).length;

    // Cut right after the 2nd byte of the 4-byte sequence
    const splitPoint = prefixBytesLength + 2;
    const part1 = fullBytes.subarray(0, splitPoint);
    const part2 = fullBytes.subarray(splitPoint);

    const events1 = decoder.feed(part1);
    assert.strictEqual(events1.length, 0);

    const events2 = decoder.feed(part2);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(events2[0].text, "Rocket 🚀");
  });

  it("handles malformed JSON without corrupting subsequent parser state", () => {
    const decoder = new SseDecoder();
    const brokenEvent = "data: {not valid json\r\n\r\n";
    const validEvent =
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Recovered"}]}}]}}\r\n\r\n';

    const events1 = decoder.feed(brokenEvent);
    assert.strictEqual(events1.length, 0);

    const events2 = decoder.feed(validEvent);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(events2[0].text, "Recovered");
  });
});
