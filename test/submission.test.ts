import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { Writable, PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { AgyProcess } from "../src/agy-process.ts";
import { streamSimple, resetActiveProcesses } from "../src/stream.ts";
import { MODELS } from "../src/models.ts";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  const state: { count: number; value?: T; error?: unknown } = { count: 0 };
  void promise.then(value => { state.count++; state.value = value; }, error => { state.count++; state.error = error; });
  return state;
}
const children: ChildProcess[] = [];
function transport() {
  const writes: string[] = [], signals: string[] = [];
  const callbacks: ((error?: Error | null) => void)[] = [];
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    writes.push(JSON.parse(chunk.toString()).message.content);
    callbacks.push(callback);
  } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = (signal = "SIGTERM") => { signals.push(String(signal)); return true; };
  const emit = (event: object) => (child.stdout as PassThrough).write(JSON.stringify(event) + "\n");
  children.push(child);
  return { child, writes, signals, init: () => emit({ event: "init", conversation_id: "submission" }),
    spawnFn: (() => child) as typeof spawn, confirm: (error?: Error) => callbacks.shift()!(error),
    result: (response: string, status = "SUCCESS") => emit({ event: "result", status, result: { response } }) };
}
function fixture() {
  const f = transport(); const proc = new AgyProcess({ modelId: "test", spawnFn: f.spawnFn }); f.init();
  return { ...f, proc };
}
afterEach(() => { void resetActiveProcesses(); for (const child of children.splice(0)) child.emit("exit", 0, null); });

test("submission: late SUCCESS/ERROR while B prepares cannot skip B", async () => {
  const f = fixture(), gate = deferred<string>();
  const a = observe(f.proc.runTurn("A", () => {}));
  const b = observe(f.proc.runTurn(gate.promise, () => {}));
  const c = observe(f.proc.runTurn("C", () => {}));
  await drain(); f.confirm(); await drain(); f.result("A"); await drain();
  f.result("stale"); f.result("stale", "ERROR"); await drain();
  assert.equal(a.count, 1); assert.equal(b.count, 0); assert.equal(c.count, 0);
  assert.deepEqual(f.writes, ["A"]); assert.equal(f.proc.isAlive(), true);
  gate.resolve("B"); await drain(); f.confirm(); await drain(); f.result("B"); await drain();
  f.confirm(); await drain(); f.result("C"); await drain();
  assert.deepEqual(f.writes, ["A", "B", "C"]);
  assert.deepEqual([a.value?.result?.response,b.value?.result?.response,c.value?.result?.response],["A","B","C"]);
});

test("submission: preparing B cancellation is local; C continues", async () => {
  const f = fixture(), gate = deferred<string>(), controller = new AbortController();
  const a = observe(f.proc.runTurn("A", () => {}));
  const b = observe(f.proc.runTurn(gate.promise, () => {}, controller.signal));
  const c = observe(f.proc.runTurn("C", () => {}));
  await drain(); f.confirm(); await drain(); f.result("A"); await drain();
  controller.abort(); await drain();
  assert.equal(b.count, 1); assert.ok(b.error); assert.equal(a.count, 1);
  assert.deepEqual(f.signals, []); assert.equal(f.proc.isAlive(), true);
  assert.deepEqual(f.writes, ["A", "C"]);
  gate.resolve("B"); await drain(); f.confirm(); await drain(); f.result("C"); await drain();
  assert.equal(c.value?.result?.response, "C"); assert.deepEqual(f.writes, ["A", "C"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("submission: preparing B payload rejection is local; C continues", async () => {
  const f = fixture(), gate = deferred<string>();
  const b = observe(f.proc.runTurn(gate.promise, () => {}));
  const c = observe(f.proc.runTurn("C", () => {}));
  gate.reject(new Error("payload failure")); await drain();
  assert.equal(b.count, 1); assert.ok(b.error); assert.deepEqual(f.signals, []);
  assert.deepEqual(f.writes, ["C"]); f.confirm(); await drain(); f.result("C"); await drain();
  assert.equal(c.value?.result?.response, "C");
});

test("submission: abort before write remains local; after confirmed write invalidates", async () => {
  const f = fixture(), before = new AbortController();
  const a = observe(f.proc.runTurn("A", () => {}, before.signal)); before.abort();
  const after = new AbortController();
  const b = observe(f.proc.runTurn("B", () => {}, after.signal));
  await drain(); assert.deepEqual(f.writes, ["B"]); assert.deepEqual(f.signals, []);
  f.confirm(); await drain(); after.abort(); await drain();
  assert.equal(a.count, 1); assert.equal(b.count, 1); assert.ok(a.error && b.error);
  assert.deepEqual(f.signals, ["SIGINT"]); assert.equal(f.proc.isAlive(), false);
});

test("submission: result ownership is absent before write confirmation and after settlement", async () => {
  const f = fixture(), gate = deferred<string>(); const received: string[] = [];
  const a = observe(f.proc.runTurn(gate.promise, e => received.push(e.event)));
  const b = observe(f.proc.runTurn("B", () => {}));
  f.result("preparing"); await drain(); assert.equal(a.count, 0); assert.equal(b.count, 0);
  gate.resolve("A"); await drain();
  f.result("writing"); f.result("writing", "ERROR"); await drain();
  assert.equal(a.count, 0); assert.deepEqual(received, []);
  f.confirm(); await drain(); f.result("A");
  // Same chunk/stack: settled A, queued B, before the next pump.
  f.result("settled"); await drain();
  assert.equal(a.count, 1); assert.equal(b.count, 0);
  f.confirm(); await drain(); f.result("B"); await drain();
  assert.equal(b.value?.result?.response, "B"); assert.deepEqual(received, ["result"]);
});

test("submission: EPIPE before confirmation cannot produce a successful result", async () => {
  const f = fixture();
  const a = observe(f.proc.runTurn("A", () => {})), b = observe(f.proc.runTurn("B", () => {}));
  await drain(); f.result("not confirmed");
  f.confirm(Object.assign(new Error("EPIPE"), { code: "EPIPE" })); await drain();
  f.result("late"); f.child.emit("exit", 1, null); await drain();
  assert.equal(a.count, 1); assert.equal(b.count, 1); assert.ok(a.error && b.error);
  assert.equal(a.value, undefined); assert.equal(f.proc.isAlive(), false);
  assert.deepEqual(f.writes, ["A"]);
});

for (const order of ["abort-first", "confirm-first"] as const) {
  test(`submission: in-flight write race ${order} has one terminal outcome`, async () => {
    const f = fixture(), controller = new AbortController();
    const a = observe(f.proc.runTurn("A", () => {}, controller.signal));
    const b = observe(f.proc.runTurn("B", () => {}));
    await drain(); assert.deepEqual(f.writes, ["A"]);
    if (order === "abort-first") { controller.abort(); f.confirm(); }
    else { f.confirm(); controller.abort(); }
    f.result("late"); await drain();
    assert.equal(a.count, 1); assert.equal(b.count, 1); assert.ok(a.error && b.error);
    assert.deepEqual(f.signals, ["SIGINT"]); assert.deepEqual(f.writes, ["A"]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("submission: real stream payload cancellation releases the FIFO head", async () => {
  const f = transport(), gate = deferred<void>(), controller = new AbortController();
  const model = { ...MODELS[0], api: "agy-pool-api", provider: "agy-pool" } as Model<Api>;
  const context = { messages: [{ role: "user", content: "prompt", timestamp: 0 }] } as TranscriptContext;
  const options = { sessionId: "payload", spawnFn: f.spawnFn };
  const a = streamSimple(model, context, options); f.init(); await drain(); f.confirm(); await drain();
  const b = streamSimple(model, context, { ...options, signal: controller.signal, onPayload: () => gate.promise });
  const c = streamSimple(model, context, options);
  f.result("A"); await a.result(); await drain();
  f.result("stale"); await drain(); assert.equal(f.writes.length, 1);
  controller.abort(); assert.equal((await b.result()).stopReason, "aborted"); await drain();
  assert.deepEqual(f.signals, []); assert.equal(f.writes.length, 2);
  f.confirm(); await drain(); f.result("C"); assert.equal((await c.result()).stopReason, "stop");
  gate.resolve(); await drain(); assert.equal(f.writes.length, 2);
});
