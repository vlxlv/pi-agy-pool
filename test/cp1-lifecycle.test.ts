import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { AgyProcess } from "../src/agy-process.ts";
import { activeProcesses, resetActiveProcesses, retireSessionConversation, streamSimple } from "../src/stream.ts";
import { MODELS } from "../src/models.ts";
import type { Model, Api, TranscriptContext } from "@earendil-works/pi-ai";

// An event-loop barrier, not a timer: drains writes and promise continuations.
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const model = { ...MODELS[0], api: "agy-pool", provider: "agy-pool" } as Model<Api>;
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] } as TranscriptContext;
const children: ChildProcess[] = [];
function child(stdin: Writable = new PassThrough()) {
  const c = new EventEmitter() as ChildProcess;
  c.stdin = stdin;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  const signals: string[] = [], writes: string[] = [];
  if (stdin instanceof PassThrough) stdin.on("data", chunk => writes.push(JSON.parse(chunk.toString()).message.content));
  c.kill = (signal = "SIGTERM") => { signals.push(String(signal)); return true; };
  const emit = (event: object) => (c.stdout as PassThrough).write(JSON.stringify(event) + "\n");
  const init = (id = "cp1") => emit({ event: "init", conversation_id: id });
  const result = (response: string) => emit({ event: "result", status: "SUCCESS", result: { response } });
  const exit = () => c.emit("exit", 0, null);
  const fixture = { c, signals, writes, emit, init, result, exit, spawnFn: (() => c) as typeof spawn };
  children.push(c);
  return fixture;
}
afterEach(() => { resetActiveProcesses(); for (const c of children.splice(0)) c.emit("exit", 0, null); });
function processFixture(stdin?: Writable) {
  const f = child(stdin);
  const proc = new AgyProcess({ modelId: model.id, spawnFn: f.spawnFn });
  return { ...f, proc };
}
function observe<T>(promise: Promise<T>) {
  const settled: { value?: T; error?: unknown; count: number } = { count: 0 };
  void promise.then(value => { settled.value = value; settled.count++; }, error => { settled.error = error; settled.count++; });
  return settled;
}

test("CP1 FIFO: C cannot overtake queued B after A result", async () => {
  const f = processFixture(); f.init();
  const a = f.proc.runTurn("A", () => {});
  const b = f.proc.runTurn("B", () => {});
  observe(a); observe(b); await drain();
  f.result("A");
  const c = f.proc.runTurn("C", () => {}); observe(c);
  await drain();
  assert.deepEqual(f.writes, ["A", "B"]);
  f.result("B"); await drain(); f.result("C");
  assert.deepEqual((await Promise.all([a,b,c])).map(r => r.result?.response), ["A","B","C"]);
  assert.deepEqual(f.writes, ["A","B","C"]);
});

test("CP1 one result settles exactly one turn", async () => {
  const f = processFixture(); f.init();
  const a = observe(f.proc.runTurn("A", () => {}));
  const b = observe(f.proc.runTurn("B", () => {})); await drain();
  f.result("A");
  const c = observe(f.proc.runTurn("C", () => {})); await drain();
  f.result("second"); await drain();
  assert.equal(a.count + b.count + c.count, 2);
  assert.equal(c.count, 0);
  f.result("third"); await drain(); assert.equal(c.count, 1);
  assert.equal(f.proc.listenerCount("event"), 0);
});

test("CP1 concurrent same-session acquisition spawns once", async () => {
  const spawned: ReturnType<typeof child>[] = [];
  const spawnFn = (() => { const f = child(); spawned.push(f); return f.c; }) as typeof spawn;
  const a = streamSimple(model, context, { sessionId: "same", spawnFn });
  const b = streamSimple(model, context, { sessionId: "same", spawnFn });
  assert.equal(spawned.length, 1);
  spawned[0].init(); await drain();
  assert.equal(spawned[0].writes.length, 1);
  spawned[0].result("A"); await drain();
  assert.equal(spawned[0].writes.length, 2);
  spawned[0].result("B");
  assert.equal((await a.result()).stopReason, "stop");
  assert.equal((await b.result()).stopReason, "stop");
});

test("CP1 stdin EPIPE owns callback AND Writable error, rejects all once", async () => {
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" })); } });
  const f = processFixture(stdin); f.init();
  // Assert ownership before provoking a real Writable's error (old code would crash Node).
  assert.ok(stdin.listenerCount("error") > 0, "stdin must have its own error handler");
  const a = observe(f.proc.runTurn("A", () => {}));
  const b = observe(f.proc.runTurn("B", () => {}));
  await drain(); f.c.emit("exit", 1, null); await drain();
  assert.equal(a.count, 1); assert.equal(b.count, 1);
  assert.match(String(a.error), /EPIPE/); assert.ok(b.error);
  assert.equal(f.proc.isAlive(), false);
  assert.equal(f.proc.listenerCount("event"), 0);
});

test("CP1 real Writable EPIPE does not crash an isolated Node process", () => {
  const script = `
    import { EventEmitter } from 'node:events';
    import { Writable, PassThrough } from 'node:stream';
    import assert from 'node:assert/strict';
    import { AgyProcess } from ${JSON.stringify(new URL("../src/agy-process.ts", import.meta.url).href)};
    const c = new EventEmitter();
    c.stdin = new Writable({ write(chunk, encoding, cb) { cb(new Error('EPIPE')); } });
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => { queueMicrotask(() => c.emit('exit', 1, null)); return true; };
    const proc = new AgyProcess({ modelId: 'test', spawnFn: () => c });
    c.stdout.write(JSON.stringify({event:'init', conversation_id:'pipe'}) + '\\n');
    const result = proc.runTurn('A', () => {}).catch(e => e);
    assert.match(String(await result), /EPIPE/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proc.isAlive(), false);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("CP1 early init binds identity while payload is pending; cleanup owns child", async () => {
  const f = child();
  let release!: () => void;
  const gate = { promise: new Promise<void>(resolve => { release = resolve; }), resolve: () => release() };
  const stream = streamSimple(model, context, { sessionId: "early", spawnFn: f.spawnFn, onPayload: async () => { await gate.promise; } });
  f.init("early-id"); await drain();
  assert.equal(activeProcesses.size, 1);
  gate.resolve(); await drain(); f.result("answer");
  assert.equal((await stream.result()).responseId, "early-id");
  resetActiveProcesses(); assert.deepEqual(f.signals, ["SIGTERM"]);
});

for (const terminal of ["zero", "nonzero", "signal", "spawn error", "stdout EOF", "stdout close", "stdout error", "stdin error", "stderr error"] as const) {
  test(`CP1 ready rejects pre-init ${terminal}`, async () => {
    const f = processFixture(); const ready = observe(f.proc.ready);
    if (terminal === "zero") f.c.emit("exit", 0, null);
    else if (terminal === "nonzero") f.c.emit("exit", 2, null);
    else if (terminal === "signal") f.c.emit("exit", null, "SIGTERM");
    else if (terminal === "spawn error") f.c.emit("error", new Error("spawn failed"));
    else if (terminal === "stdout EOF") (f.c.stdout as PassThrough).end();
    else if (terminal === "stdout close") f.c.stdout!.destroy();
    else {
      const pipe = terminal === "stdin error" ? f.c.stdin : terminal === "stderr error" ? f.c.stderr : f.c.stdout;
      assert.ok(pipe!.listenerCount("error") > 0);
      pipe!.emit("error", new Error(terminal));
    }
    await drain();
    assert.equal(ready.count, 1, "ready must settle on a definitive terminal event");
    assert.ok(ready.error); assert.equal(f.proc.isAlive(), false);
  });
}

test("CP1 stdout EOF fails active turn without child exit", async () => {
  const f = processFixture(); f.init();
  const a = observe(f.proc.runTurn("A", () => {})); await drain();
  (f.c.stdout as PassThrough).end(); await drain();
  assert.equal(a.count, 1); assert.ok(a.error); assert.equal(f.proc.isAlive(), false);
});

test("CP1 EOF flush settles final result once and fails queued turn", async () => {
  const f = processFixture(); f.init();
  const a = f.proc.runTurn("A", () => {});
  const b = observe(f.proc.runTurn("B", () => {})); await drain();
  (f.c.stdout as PassThrough).end(JSON.stringify({ event: "result", status: "SUCCESS", result: { response: "A" } }));
  assert.equal((await a).result?.response, "A"); await drain();
  assert.equal(b.count, 1); assert.ok(b.error); assert.deepEqual(f.writes, ["A"]);
});

test("CP1 queued abort is local, active continues and process stays reusable", async () => {
  const f = processFixture(); f.init(); const controller = new AbortController();
  const a = f.proc.runTurn("A", () => {}); observe(a);
  const b = observe(f.proc.runTurn("B", () => {}, controller.signal)); await drain();
  controller.abort(); await drain();
  assert.equal(b.count, 1); assert.ok(b.error); assert.deepEqual(f.signals, []);
  assert.equal(f.proc.isAlive(), true); f.result("A"); await a;
  const c = f.proc.runTurn("C", () => {}); await drain(); f.result("C"); await c;
  assert.deepEqual(f.writes, ["A","C"]);
});

test("CP1 active abort invalidates and rejects A/B/C even without exit", async () => {
  const f = processFixture(); f.init(); const controller = new AbortController();
  const a = observe(f.proc.runTurn("A", () => {}, controller.signal));
  const b = observe(f.proc.runTurn("B", () => {}));
  const c = observe(f.proc.runTurn("C", () => {})); await drain();
  controller.abort(); await drain();
  assert.deepEqual(f.signals, ["SIGINT"]); assert.equal(f.proc.isAlive(), false);
  assert.deepEqual([a.count,b.count,c.count], [1,1,1]);
  assert.ok(a.error && b.error && c.error); assert.deepEqual(f.writes, ["A"]);
  f.exit(); await drain(); assert.equal(f.proc.listenerCount("event"), 0);
});

test("CP1 replacement survives old exit", async () => {
  const first = child();
  const a = streamSimple(model, context, { sessionId: "replace", spawnFn: first.spawnFn });
  first.init("shared"); await drain(); first.result("A"); const answer = await a.result();
  const second = child();
  const b = streamSimple({ ...model, id: "changed-model" }, { messages: [...context.messages, answer, ...context.messages] } as TranscriptContext, { sessionId: "replace", spawnFn: second.spawnFn });
  second.init("shared"); await drain();
  const owner = activeProcesses.get("shared"); assert.ok(owner); assert.equal(owner.modelId, "changed-model");
  assert.deepEqual(second.writes, [], "replacement cannot execute until old child exits");
  first.exit(); assert.equal(activeProcesses.get("shared"), owner);
  await drain(); assert.equal(second.writes.length, 1);
  second.result("B"); assert.equal((await b.result()).stopReason, "stop");
});

test("CP1 shutdown covers unregistered child and rejects startup", async () => {
  const f = child(); const stream = streamSimple(model, context, { sessionId: "unregistered", spawnFn: f.spawnFn });
  resetActiveProcesses(); await drain();
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal((await stream.result()).stopReason, "error");
});

test("CP1 repeated replacements wait for every retiring predecessor", async () => {
  const first = child();
  const a = streamSimple(model, context, { sessionId: "chain", spawnFn: first.spawnFn });
  first.init("chain-id"); await drain(); first.result("A");
  const transcript = { messages: [...context.messages, await a.result(), ...context.messages] } as TranscriptContext;
  const second = child();
  const b = streamSimple({ ...model, id: "second" }, transcript, { sessionId: "chain", spawnFn: second.spawnFn });
  second.init("chain-id"); await drain();
  const third = child();
  const c = streamSimple({ ...model, id: "third" }, transcript, { sessionId: "chain", spawnFn: third.spawnFn });
  third.init("chain-id"); await drain();
  assert.equal((await b.result()).stopReason, "error");
  second.exit(); await drain(); assert.deepEqual(third.writes, []);
  first.exit(); await drain(); assert.equal(third.writes.length, 1);
  assert.equal(activeProcesses.get("chain-id")?.modelId, "third");
  third.result("C"); assert.equal((await c.result()).stopReason, "stop");
});

test("CP1 session retirement owns pre-init children without affecting another session", async () => {
  const first = child(), second = child();
  const a = streamSimple(model, context, { sessionId: "pre-init-A", spawnFn: first.spawnFn });
  const b = streamSimple(model, context, { sessionId: "pre-init-B", spawnFn: second.spawnFn });
  const closed = retireSessionConversation("pre-init-A");
  assert.deepEqual(first.signals, ["SIGTERM"]); assert.deepEqual(second.signals, []);
  assert.equal((await a.result()).stopReason, "error");
  first.init("late"); assert.equal(activeProcesses.has("late"), false);
  first.exit(); await closed;
  second.init("live"); await drain(); second.result("B");
  assert.equal((await b.result()).stopReason, "stop");
  assert.equal(activeProcesses.get("live")?.isAlive(), true);
});

test("CP1 busy retirement signals immediately and rejects queued turns", async () => {
  const f = child();
  const a = streamSimple(model, context, { sessionId: "retire", spawnFn: f.spawnFn }); f.init(); await drain();
  const b = streamSimple(model, context, { sessionId: "retire", spawnFn: f.spawnFn }); await drain();
  retireSessionConversation("retire"); await drain();
  assert.deepEqual(f.signals, ["SIGTERM"]); assert.equal(activeProcesses.size, 0);
  assert.notEqual((await a.result()).stopReason, "stop"); assert.notEqual((await b.result()).stopReason, "stop");
});

test("CP1 delayed payload cannot reorder submissions; queued abort cleans listener", async () => {
  const f = child(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = streamSimple(model, context, { sessionId: "payload", spawnFn: f.spawnFn, onPayload: async () => { await gate; } });
  const controller = new AbortController();
  const b = streamSimple(model, context, { sessionId: "payload", spawnFn: f.spawnFn, signal: controller.signal });
  f.init(); await drain(); assert.deepEqual(f.writes, []);
  controller.abort(); assert.equal((await b.result()).stopReason, "aborted");
  assert.deepEqual(f.signals, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  release(); await drain(); assert.equal(f.writes.length, 1);
  f.result("A"); assert.equal((await a.result()).stopReason, "stop");
});

test("CP1 abort during pending payload settles without releasing hook", async () => {
  const f = child(); const controller = new AbortController();
  const stream = streamSimple(model, context, { sessionId: "pending", spawnFn: f.spawnFn, signal: controller.signal, onPayload: () => new Promise(() => {}) });
  const settled = observe(stream.result()); controller.abort(); await drain();
  assert.equal(settled.count, 1); assert.equal(settled.value?.stopReason, "aborted");
  assert.deepEqual(f.signals, ["SIGINT"]); assert.deepEqual(f.writes, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("CP1 termination is shared, escalates once and only completes on exit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = processFixture(); f.init();
  const one = f.proc.kill(); const two = f.proc.kill();
  assert.equal(one, two);
  const closed = observe(one); await drain(); assert.equal(closed.count, 0);
  assert.deepEqual(f.signals, ["SIGTERM"]);
  t.mock.timers.tick(3000); await drain();
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(closed.count, 0, "signalling is not termination completion");
  f.exit(); await one; await drain(); assert.equal(closed.count, 1);
  assert.equal(f.c.listenerCount("exit"), 0);
  t.mock.timers.tick(3000); assert.equal(f.signals.length, 2);
});

test("CP1 shutdown promise waits for an unregistered child to exit", async () => {
  const f = child();
  const stream = streamSimple(model, context, { sessionId: "shutdown-wait", spawnFn: f.spawnFn });
  const shutdown = resetActiveProcesses(); const settled = observe(shutdown);
  await drain(); assert.equal(settled.count, 0);
  assert.equal((await stream.result()).stopReason, "error");
  f.exit(); await shutdown; await drain(); assert.equal(settled.count, 1);
});

test("CP1 real OS child exit is observed before retirement completes", async () => {
  const proc = new AgyProcess({ modelId: model.id, spawnFn: (() => spawn(process.execPath, ["-e", `
    process.stdout.write(JSON.stringify({event:'init',conversation_id:'os-child'})+'\\n');
    process.stdin.resume();
  `], { stdio: "pipe" })) as unknown as typeof spawn });
  await proc.ready;
  const pid = proc.pid!;
  await proc.kill();
  assert.equal(proc.isAlive(), false);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
