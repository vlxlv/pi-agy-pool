import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  activeProcesses,
  buildTurnPrompt,
  findConversationId,
  resetActiveProcesses,
  resolveEffort,
  streamSimple,
} from "../src/stream.ts";

function createMockChildProcess(): {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  simulateExit: (code: number, signal?: string | null) => void;
  signalsReceived: string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalsReceived: string[] = [];

  const childEmitter = new EventEmitter() as ChildProcess;
  childEmitter.stdin = stdin;
  childEmitter.stdout = stdout;
  childEmitter.stderr = stderr;
  let isKilled = false;
  Object.defineProperty(childEmitter, "killed", {
    get: () => isKilled,
    set: (val: boolean) => {
      isKilled = val;
    },
    configurable: true,
  });
  childEmitter.kill = ((sig?: NodeJS.Signals | number) => {
    isKilled = true;
    signalsReceived.push(String(sig || "SIGTERM"));
    return true;
  }) as unknown as ChildProcess["kill"];

  const simulateExit = (code: number, signal: string | null = null) => {
    isKilled = true;
    childEmitter.emit("exit", code, signal);
  };

  return { child: childEmitter, stdin, stdout, stderr, simulateExit, signalsReceived };
}

describe("stream.ts: streamSimple", () => {
  beforeEach(() => {
    resetActiveProcesses();
  });

  const dummyModel: Model<"agy-pool-api"> = {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    baseUrl: "",
    api: "agy-pool-api",
    provider: "agy-pool",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };

  it("streams full response incrementally with usage and completion", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        } as UserMessage,
      ],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, { spawnFn });

    // Simulate AGY events
    mock.stdout.write('{"event":"init","conversation_id":"conv-test-1"}\n');
    mock.stdout.write(
      '{"event":"step_update","step_update":{"role":"model","text_delta":"Hel"}}\n',
    );
    mock.stdout.write(
      '{"event":"step_update","step_update":{"role":"model","text_delta":"lo"}}\n',
    );
    mock.stdout.write(
      '{"event":"step_update","step_update":{"role":"model","status":"DONE","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"thinking_tokens":2}}}\n',
    );
    mock.stdout.write(
      '{"event":"result","status":"SUCCESS","data":{"stop_reason":"END_OF_TURN"}}\n',
    );

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

    const result = (await stream.result()) as AssistantMessage;
    assert.strictEqual(result.stopReason, "stop");
    assert.strictEqual(result.responseId, "conv-test-1");
    assert.strictEqual(result.usage.input, 10);
    assert.strictEqual(result.usage.output, 5);
    assert.strictEqual(result.usage.totalTokens, 15);
    assert.strictEqual(result.usage.reasoning, 2);
  });

  it("handles multi-turn session by reusing running process", async () => {
    let spawnCount = 0;
    const mock = createMockChildProcess();
    const spawnFn = (() => {
      spawnCount++;
      return mock.child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Turn 1
    const context1 = {
      messages: [
        { role: "user", content: "Remember code 42", timestamp: Date.now() } as UserMessage,
      ],
    } as unknown as TranscriptContext;

    const stream1 = streamSimple(dummyModel, context1, { spawnFn });
    mock.stdout.write('{"event":"init","conversation_id":"c-reuse"}\n');
    mock.stdout.write(
      '{"event":"step_update","step_update":{"role":"model","text_delta":"Got it."}}\n',
    );
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result1 = await stream1.result();
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(result1.responseId, "c-reuse");

    // Turn 2: includes previous assistant message with responseId
    const context2 = {
      messages: [
        { role: "user", content: "Remember code 42", timestamp: Date.now() },
        result1,
        { role: "user", content: "What was the code?", timestamp: Date.now() },
      ],
    } as unknown as TranscriptContext;

    const stream2 = streamSimple(dummyModel, context2, { spawnFn });
    // Process is reused, NO new spawn!
    assert.strictEqual(spawnCount, 1);

    mock.stdout.write(
      '{"event":"step_update","step_update":{"role":"model","text_delta":"Code is 42."}}\n',
    );
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result2 = await stream2.result();
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(result2.responseId, "c-reuse");
  });

  it("resumes with --conversation if previous process exited", async () => {
    let spawnCount = 0;
    let lastSpawnArgs: string[] = [];

    const mock1 = createMockChildProcess();
    const mock2 = createMockChildProcess();

    const spawnFn = ((_bin: string, args: string[]) => {
      spawnCount++;
      lastSpawnArgs = args;
      return spawnCount === 1 ? mock1.child : mock2.child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Turn 1
    const context1 = {
      messages: [{ role: "user", content: "Turn 1", timestamp: Date.now() }],
    } as unknown as TranscriptContext;

    const stream1 = streamSimple(dummyModel, context1, { spawnFn });
    mock1.stdout.write('{"event":"init","conversation_id":"c-resumed"}\n');
    mock1.stdout.write('{"event":"step_update","step_update":{"text_delta":"R1"}}\n');
    mock1.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    const result1 = await stream1.result();

    // Simulate process 1 exiting
    mock1.simulateExit(0);

    // Turn 2
    const context2 = {
      messages: [
        { role: "user", content: "Turn 1", timestamp: Date.now() },
        result1,
        { role: "user", content: "Turn 2", timestamp: Date.now() },
      ],
    } as unknown as TranscriptContext;

    const stream2 = streamSimple(dummyModel, context2, { spawnFn });
    assert.strictEqual(spawnCount, 2);
    assert.ok(lastSpawnArgs.includes("--conversation"));
    assert.ok(lastSpawnArgs.includes("c-resumed"));

    mock2.stdout.write('{"event":"init","conversation_id":"c-resumed"}\n');
    mock2.stdout.write('{"event":"step_update","step_update":{"text_delta":"R2"}}\n');
    mock2.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result2 = await stream2.result();
    assert.strictEqual(result2.responseId, "c-resumed");
  });

  it("handles AbortSignal cancellation", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const controller = new AbortController();
    const context = {
      messages: [{ role: "user", content: "Cancel", timestamp: Date.now() }],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, {
      spawnFn,
      signal: controller.signal,
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-abort"}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"text_delta":"Starting..."}}\n');

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort();
        mock.simulateExit(130, "SIGINT");
      }
    }

    const lastEvent = events[events.length - 1];
    assert.strictEqual(lastEvent.type, "error");
    if (lastEvent.type === "error") {
      assert.strictEqual(lastEvent.reason, "aborted");
    }
    assert.strictEqual(
      activeProcesses.has("c-abort"),
      false,
      "Cancelled process must be discarded from activeProcesses",
    );
  });

  it("handles AGY result ERROR", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const context = {
      messages: [{ role: "user", content: "Error test", timestamp: Date.now() }],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, { spawnFn });
    mock.stdout.write('{"event":"init","conversation_id":"c-err"}\n');
    mock.stdout.write('{"event":"result","status":"ERROR","error":"Upstream quota exceeded"}\n');

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    assert.strictEqual(events.length, 2); // start + error
    const errEvent = events[1];
    assert.strictEqual(errEvent.type, "error");
    if (errEvent.type === "error") {
      assert.strictEqual(errEvent.reason, "error");
      assert.ok(errEvent.error.errorMessage?.includes("Upstream quota exceeded"));
    }
  });

  it("buildTurnPrompt formats system message correctly", () => {
    const contextWithSystem = {
      messages: [
        { role: "system", content: "Act as an expert.", timestamp: 0 },
        { role: "user", content: "Hello", timestamp: 1 },
      ],
    } as unknown as TranscriptContext;

    const prompt = buildTurnPrompt(contextWithSystem, false);
    assert.strictEqual(prompt, "Act as an expert.\n\nHello");

    // When resumed, only returns latest user text
    const resumedPrompt = buildTurnPrompt(contextWithSystem, true);
    assert.strictEqual(resumedPrompt, "Hello");
  });

  it("findConversationId finds conversation ID from previous assistant message", () => {
    const context = {
      messages: [
        { role: "user", content: "Hi", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          responseId: "conv-xyz-789",
          timestamp: 2,
        } as AssistantMessage,
        { role: "user", content: "How are you?", timestamp: 3 },
      ],
    } as unknown as TranscriptContext;

    const id = findConversationId(context);
    assert.strictEqual(id, "conv-xyz-789");
  });

  it("resolveEffort respects official AGY model constraints", () => {
    // Claude models: must omit --effort
    assert.strictEqual(resolveEffort("claude-sonnet-4-6"), undefined);
    assert.strictEqual(resolveEffort("claude-opus-4-6-thinking"), undefined);

    // Gemini 3.1 Pro: defaults to high, supports low
    assert.strictEqual(resolveEffort("gemini-3.1-pro"), "high");
    assert.strictEqual(resolveEffort("gemini-3.1-pro", { reasoning: "low" }), "low");

    // Gemini Flash: defaults to medium, maps reasoning levels
    assert.strictEqual(resolveEffort("gemini-3.8-flash"), "medium");
    assert.strictEqual(resolveEffort("gemini-3.8-flash", { reasoning: "high" }), "high");
    assert.strictEqual(resolveEffort("gemini-3.7-flash", { reasoning: "low" }), "low");
  });

  it("session isolation: unrelated Pi sessions do not share processes", async () => {
    let spawnCount = 0;
    const mockA = createMockChildProcess();
    const mockB = createMockChildProcess();

    const spawnFn = (() => {
      spawnCount++;
      return spawnCount === 1 ? mockA.child : mockB.child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Session A
    const contextA = {
      messages: [{ role: "user", content: "Session A query", timestamp: 100 }],
    } as unknown as TranscriptContext;
    const streamA = streamSimple(dummyModel, contextA, { spawnFn });
    mockA.stdout.write('{"event":"init","conversation_id":"conv-session-A"}\n');
    mockA.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    const resultA = await streamA.result();
    assert.strictEqual(resultA.responseId, "conv-session-A");

    // Session B: completely separate transcript without Session A history
    const contextB = {
      messages: [{ role: "user", content: "Session B query", timestamp: 200 }],
    } as unknown as TranscriptContext;
    const streamB = streamSimple(dummyModel, contextB, { spawnFn });
    mockB.stdout.write('{"event":"init","conversation_id":"conv-session-B"}\n');
    mockB.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    const resultB = await streamB.result();
    assert.strictEqual(resultB.responseId, "conv-session-B");

    // Must spawn twice (one per session), never share
    assert.strictEqual(spawnCount, 2);
    assert.notStrictEqual(resultA.responseId, resultB.responseId);
  });

  it("shutdown cleanup: resetActiveProcesses terminates active processes", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const context = {
      messages: [{ role: "user", content: "Active query", timestamp: 1 }],
    } as unknown as TranscriptContext;
    const stream = streamSimple(dummyModel, context, { spawnFn });
    mock.stdout.write('{"event":"init","conversation_id":"c-cleanup"}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    await stream.result();

    assert.strictEqual(activeProcesses.has("c-cleanup"), true);
    resetActiveProcesses();
    assert.strictEqual(activeProcesses.size, 0);
    assert.ok(mock.signalsReceived.includes("SIGTERM"));
  });

  it("no extension-side account retry/failover: fails immediately on upstream error", async () => {
    let spawnCount = 0;
    const mock = createMockChildProcess();
    const spawnFn = (() => {
      spawnCount++;
      return mock.child;
    }) as unknown as typeof import("node:child_process").spawn;

    const context = {
      messages: [{ role: "user", content: "Fail once", timestamp: 1 }],
    } as unknown as TranscriptContext;
    const stream = streamSimple(dummyModel, context, { spawnFn });
    mock.stdout.write('{"event":"init","conversation_id":"c-no-retry"}\n');
    mock.stdout.write('{"event":"result","status":"ERROR","error":"rate limit"}\n');

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "error");
    // Exactly 1 spawn attempt, zero retries
    assert.strictEqual(spawnCount, 1);
  });

  it("no direct :8899 production transport: source files contain no obsolete patterns", () => {
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const files = fs.readdirSync(srcDir);
    const forbidden = [
      "127.0.0.1:8899",
      "streamGenerateContent",
      "fetchAvailableModels",
      "CLOUD_CODE_URL",
      "thinkingBudget",
      "thoughtSignature",
    ];

    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      for (const pattern of forbidden) {
        assert.strictEqual(
          content.includes(pattern),
          false,
          `File ${file} contains forbidden pattern: ${pattern}`,
        );
      }
    }
  });
});
