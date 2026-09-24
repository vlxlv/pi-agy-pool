import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AssistantMessageEvent,
  Model,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "../src/stream.ts";

describe("stream.ts: streamSimple", () => {
  let server: http.Server;
  let serverUrl: string;
  let requestCount = 0;
  let lastRequestBody: string | null = null;
  let mockHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  before(async () => {
    server = http.createServer((req, res) => {
      requestCount++;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        lastRequestBody = body;
        mockHandler(req, res);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const dummyModel: Model<"agy-pool-api"> = {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    baseUrl: "http://127.0.0.1:8899",
    api: "agy-pool-api",
    provider: "agy-pool",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };

  const dummyContext = {
    messages: [
      {
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      } as UserMessage,
    ],
  } as unknown as TranscriptContext;

  it("12. HTTP JSON error handling", async () => {
    requestCount = 0;
    mockHandler = (_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: 503,
            message: "No capacity available for model gemini-2.5-pro on the server",
            status: "UNAVAILABLE",
          },
        }),
      );
    };

    const modelWithBaseUrl = { ...dummyModel, baseUrl: serverUrl };
    const stream = streamSimple(modelWithBaseUrl, dummyContext);

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "error");
    if (events[0].type === "error") {
      assert.strictEqual(events[0].reason, "error");
      assert.ok(
        events[0].error.errorMessage?.includes("No capacity available"),
        `Expected error message to contain capacity info, got: ${events[0].error.errorMessage}`,
      );
    }
  });

  it("13. AbortSignal cancellation", async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Start"}]}}]}}\r\n\r\n',
      );
      // Keep response open without ending
    };

    const controller = new AbortController();
    const modelWithBaseUrl = { ...dummyModel, baseUrl: serverUrl };
    const stream = streamSimple(modelWithBaseUrl, dummyContext, {
      signal: controller.signal,
    });

    const events: AssistantMessageEvent[] = [];
    // Read first event, then abort
    for await (const event of stream) {
      events.push(event);
      if (event.type === "start" || event.type === "text_delta") {
        controller.abort();
      }
    }

    const lastEvent = events[events.length - 1];
    assert.strictEqual(lastEvent.type, "error");
    if (lastEvent.type === "error") {
      assert.strictEqual(lastEvent.reason, "aborted");
    }
  });

  it("14. no retry performed by the extension", async () => {
    requestCount = 0;
    mockHandler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal server error" } }));
    };

    const modelWithBaseUrl = { ...dummyModel, baseUrl: serverUrl };
    const stream = streamSimple(modelWithBaseUrl, dummyContext);

    for await (const _event of stream) {
      // consume
    }

    assert.strictEqual(
      requestCount,
      1,
      `Expected exactly 1 request to backend, got ${requestCount}`,
    );
  });

  it("streams full response incrementally with usage and completion", async () => {
    requestCount = 0;
    mockHandler = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      res.write(
        'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": ""}]}}], "usageMetadata": {"promptTokenCount": 2, "totalTokenCount": 2}}}\r\n\r\n',
      );
      res.write(
        'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hel"}]}}], "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 1, "totalTokenCount": 3}}}\r\n\r\n',
      );
      res.write(
        'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "lo"}]}}], "finishReason": "STOP", "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 2, "totalTokenCount": 4}}}\r\n\r\n',
      );
      res.end();
    };

    const modelWithBaseUrl = { ...dummyModel, baseUrl: serverUrl };
    const stream = streamSimple(modelWithBaseUrl, dummyContext);

    const eventTypes: string[] = [];
    let accumulatedText = "";

    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "text_delta") {
        accumulatedText += event.delta;
      }
    }

    assert.ok(eventTypes.includes("start"), "Must include start event");
    assert.ok(eventTypes.includes("text_start"), "Must include text_start event");
    assert.ok(eventTypes.includes("text_delta"), "Must include text_delta event");
    assert.ok(eventTypes.includes("text_end"), "Must include text_end event");
    assert.ok(eventTypes.includes("done"), "Must include done event");

    assert.strictEqual(accumulatedText, "Hello");

    const doneEvent = (await stream.result()) as unknown as {
      usage: { input: number; output: number; totalTokens: number };
      stopReason: string;
    };
    assert.strictEqual(doneEvent.stopReason, "stop");
    assert.strictEqual(doneEvent.usage.input, 2);
    assert.strictEqual(doneEvent.usage.output, 2);
    assert.strictEqual(doneEvent.usage.totalTokens, 4);
  });
});
