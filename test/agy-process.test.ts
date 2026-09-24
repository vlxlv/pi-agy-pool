import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { AgyProcess } from "../src/agy-process.ts";

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

describe("agy-process.ts: AgyProcess", () => {
  it("spawns with exact arguments array", async () => {
    let capturedBin = "";
    let capturedArgs: string[] = [];

    const mock = createMockChildProcess();
    const spawnFn = ((bin: string, args: string[]) => {
      capturedBin = bin;
      capturedArgs = args;
      return mock.child;
    }) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      effort: "high",
      conversationId: "conv-123",
      spawnFn,
    });

    assert.strictEqual(capturedBin, "agy-pool");
    assert.deepStrictEqual(capturedArgs, [
      "run",
      "--",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--effort",
      "high",
      "--conversation",
      "conv-123",
    ]);

    // Emit init
    mock.stdout.write('{"event":"init","conversation_id":"conv-123","session_id":"s1"}\n');
    const init = await proc.ready;
    assert.strictEqual(init.conversation_id, "conv-123");
    assert.strictEqual(proc.conversationId, "conv-123");
    assert.strictEqual(proc.sessionId, "s1");
  });

  it("handles multi-turn interaction over stdin and stdout", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      spawnFn,
    });

    // Send init
    mock.stdout.write('{"event":"init","conversation_id":"c-abc"}\n');
    await proc.ready;

    // Turn 1
    let turn1Stdin = "";
    mock.stdin.on("data", (chunk) => {
      turn1Stdin += chunk.toString();
      // Simulate AGY output for Turn 1 in response to stdin
      mock.stdout.write('{"event":"step_update","step_update":{"role":"model","text_delta":"Reply 1"}}\n');
      mock.stdout.write('{"event":"result","status":"SUCCESS","data":{"stop_reason":"END_OF_TURN"}}\n');
    });

    const turn1Promise = proc.runTurn("Turn 1 prompt", (event) => {
      if (event.event === "step_update") {
        assert.strictEqual(
          (event as { step_update: { text_delta: string } }).step_update.text_delta,
          "Reply 1",
        );
      }
    });

    const result1 = await turn1Promise;
    assert.strictEqual(result1.status, "SUCCESS");
    assert.ok(turn1Stdin.includes('"content":"Turn 1 prompt"'));

    // Turn 2 on the same running process
    let turn2Stdin = "";
    mock.stdin.removeAllListeners("data");
    mock.stdin.on("data", (chunk) => {
      turn2Stdin += chunk.toString();
      mock.stdout.write('{"event":"step_update","step_update":{"role":"model","text_delta":"Reply 2"}}\n');
      mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    });

    const turn2Promise = proc.runTurn("Turn 2 prompt", () => {});
    const result2 = await turn2Promise;
    assert.strictEqual(result2.status, "SUCCESS");
    assert.ok(turn2Stdin.includes('"content":"Turn 2 prompt"'));
  });

  it("handles AbortSignal by sending SIGINT and invalidating process", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      spawnFn,
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-abort"}\n');
    await proc.ready;

    const controller = new AbortController();
    const turnPromise = proc.runTurn("Cancel me", () => {}, controller.signal);

    // Trigger abort
    controller.abort();
    // Simulate process exiting on SIGINT
    mock.simulateExit(130, "SIGINT");

    await assert.rejects(turnPromise, /Request was aborted/);
    assert.ok(mock.signalsReceived.includes("SIGINT"));
    assert.strictEqual(proc.isAlive(), false);
    assert.strictEqual(proc.isAborted(), true);
  });

  it("handles AGY error result", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      spawnFn,
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-err"}\n');
    await proc.ready;

    const turnPromise = proc.runTurn("Fail me", () => {});
    mock.stdout.write('{"event":"result","status":"ERROR","error":"account quota exhausted"}\n');

    await assert.rejects(turnPromise, /account quota exhausted/);
  });

  it("handles unexpected child exit before result", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      spawnFn,
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-crash"}\n');
    await proc.ready;

    mock.stderr.write("SIGSEGV: segmentation violation\n");
    const turnPromise = proc.runTurn("Crash me", () => {});
    mock.simulateExit(139, "SIGSEGV");

    await assert.rejects(turnPromise, /AGY process exited.*code 139.*segmentation violation/);
    assert.strictEqual(proc.isAlive(), false);
  });

  it("isolates stderr diagnostics from stdout protocol decoding", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const proc = new AgyProcess({
      modelId: "gemini-3.8-flash",
      spawnFn,
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-diag"}\n');
    await proc.ready;

    const receivedEvents: string[] = [];
    const turnPromise = proc.runTurn("Diag test", (ev) => {
      receivedEvents.push(ev.event);
    });

    // Write diagnostic spam to stderr
    mock.stderr.write("DEBUG: connecting to gateway\n");
    mock.stderr.write("WARN: token approaching limit\n");

    // Write valid stdout protocol
    mock.stdout.write('{"event":"step_update","step_update":{"text_delta":"OK"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await turnPromise;
    // Stderr was ignored by stdout decoder
    assert.deepStrictEqual(receivedEvents, ["step_update", "result"]);
  });
});
