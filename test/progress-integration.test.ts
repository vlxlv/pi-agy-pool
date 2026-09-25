import { setImmediate as drain } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness, attachTui, until } from "./helpers/pi-progress.ts";

test("real AgentSession / ExtensionRunner / registered provider / TUI frames", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const events: string[] = [];
  h.session.subscribe((event: any) => {
    events.push(event.type);
    if (event.assistantMessageEvent) events.push(event.assistantMessageEvent.type);
  });
  const reply = h.session.prompt("Exercise progress offline");
  await until(() => h.children.length === 1, "provider spawned fake AGY");
  const child = h.children[0];
  child.send({ event: "init", conversation_id: "render-test" });
  await until(() => child.turns === 1, "AGY received prompt");
  await until(() => ui.terminal.writes.some((s) => s.includes("AGY: Working")), "initial status rendered");

  const before = ui.terminal.writes.length;
  // One data chunk, no render opportunity between ACTIVE and DONE.
  child.stdout.write([
    { event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "view_file" } },
    { event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "DONE" } },
    { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE" } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  await until(() => ui.terminal.writes.slice(before).some((s) =>
    stripVTControlCharacters(s).includes("AGY: Reading file — done; continuing…")), "completed activity rendered");
  assert.equal(ui.mode.workingMessage, undefined, "AGY must not customize the native spinner");
  await drain();
  child.step({ step_type: "agent_response", text_delta: "First. " });
  await until(() => ui.status() === undefined, "text clears keyed status");
  await drain();
  child.step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "run_command" });
  await until(() => ui.terminal.writes.some((s) => s.includes("AGY: Running command…")), "tool after text rendered");
  await drain();
  child.step({ step_type: "tool", step_index: 2, state: "DONE" });
  await drain();
  child.step({ step_type: "subagent", step_index: 3, state: "ACTIVE", subagent_info: { subagents: [{ role: "Research" }] } });
  await until(() => ui.terminal.writes.some((s) => s.includes("AGY: Research subagent…")), "subagent rendered");
  await drain();
  child.step({ step_type: "subagent", step_index: 3, state: "DONE" });
  await drain();
  child.step({ step_type: "agent_response", text_delta: "Last." });
  await drain();
  child.result();
  await reply;
  await until(() => ui.status() === undefined, "terminal cleanup");
  assert(events.includes("turn_start") && events.includes("turn_end"));
  assert(!events.some((x) => /^(tool_execution|toolcall_|thinking_)/.test(x)));
  assert.equal(h.session.state.messages.at(-1).content[0].text, "First. Last.");

  // Real second Pi turn reuses the process, without another init event.
  const again = h.session.prompt("Continue");
  await until(() => child.turns === 2, "reused process received second prompt");
  assert.equal(ui.status(), "AGY: Working…");
  await drain();
  child.step({ step_type: "agent_response", text_delta: "Again." });
  await drain();
  child.result();
  await again;
  assert.equal(h.children.length, 1);
  assert.equal(ui.status(), undefined);
});

test("separate real session bindings and overlapping request tokens cannot steal or clear status", async (t) => {
  const a = await createHarness();
  const b = await createHarness();
  const ua = await attachTui(a);
  const ub = await attachTui(b);
  t.after(async () => { await ua.close(); await ub.close(); });
  const context = { messages: [{ role: "user", content: "offline", timestamp: 1 }] };
  const start = (h: typeof a, sessionId = h.session.sessionId) => h.provider.streamSimple(h.model, context, { sessionId });
  const ra = start(a);
  const rb = start(b);
  a.children[0].send({ event: "init", conversation_id: "isolation-a" });
  b.children[0].send({ event: "init", conversation_id: "isolation-b" });
  await until(() => a.children[0].turns === 1 && b.children[0].turns === 1, "both requests written");
  await drain();
  a.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  await drain();
  b.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
  assert.equal(ua.status(), "AGY: Reading file…");
  assert.equal(ub.status(), "AGY: Running command…");

  const newer = start(b);
  assert.equal(b.children.length, 1, "overlap queues on the existing child");
  assert.equal(ub.status(), "AGY: Working…");
  await drain();
  b.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "write_file" });
  await drain();
  b.children[0].result();
  await rb.result();
  assert.equal(ub.status(), "AGY: Working…", "old request settlement cannot clear newer status");
  await until(() => b.children[0].turns === 2, "queued request written");
  await drain();
  b.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "code_search" });

  await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(ua.status(), undefined);
  await drain();
  a.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "write_file" });
  await drain();
  a.children[0].result();
  await ra.result();
  assert.equal(ua.status(), undefined, "shutdown tokens remain invalid");
  assert.equal(ub.status(), "AGY: Searching code…");
  await drain();
  b.children[0].result();
  await newer.result();
  assert.equal(ub.status(), undefined);

  // A request with the wrong session ID cannot use B's bound UI.
  const mismatch = start(b, a.session.sessionId);
  b.children[1].send({ event: "init", conversation_id: "mismatch" });
  await drain();
  b.children[1].step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  assert.equal(ub.status(), undefined);
  await drain();
  b.children[1].result();
  await mismatch.result();
});

test("switch/reload invalidation rejects late telemetry even after rebind to the same session", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const context = { messages: [{ role: "user", content: "offline", timestamp: 1 }] };
  for (const type of ["session_before_switch", "session_before_fork", "session_tree", "session_shutdown"]) {
    await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    const old = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId });
    const child = h.children.at(-1)!;
    child.send({ event: "init", conversation_id: `old-${type}` });
    await h.session.extensionRunner.emit({ type, reason: "reload" });
    assert.equal(ui.status(), undefined);
    await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    const fresh = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId });
    const next = h.children.at(-1)!;
    next.send({ event: "init", conversation_id: `new-${type}` });
    await drain();
    next.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
    await drain();
    child.step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
    await drain();
    child.result();
    await old.result();
    assert.equal(ui.status(), "AGY: Reading file…");
    await drain();
    next.result();
    await fresh.result();
    assert.equal(ui.status(), undefined);
  }
  await delay(20); // let the final real renderer frame drain before teardown
});

test("queued request abort restores active progress; active abort rejects shared queue", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const context = { messages: [{ role: "user", content: "offline", timestamp: 1 }] };
  const active = new AbortController();
  const old = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId, signal: active.signal });
  const first = h.children[0];
  first.send({ event: "init", conversation_id: "abort-old" });
  await until(() => first.turns === 1, "active request written");
  await drain();
  first.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  const queued = new AbortController();
  const fresh = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId, signal: queued.signal });
  assert.equal(h.children.length, 1);
  queued.abort();
  assert.equal((await fresh.result()).stopReason, "aborted");
  assert.equal(first.killed, false);
  assert.equal(ui.status(), "AGY: Reading file…", "surviving active status restored");

  const pending = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId });
  active.abort();
  assert.equal((await old.result()).stopReason, "aborted");
  assert.notEqual((await pending.result()).stopReason, "stop");
  assert.equal(first.killed, true);
  assert.equal(first.turns, 1);
  assert.equal(ui.status(), undefined);
});

test("abort clears status while the real payload hook is still pending", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.session.extensionRunner.extensions[0].handlers.set("before_provider_request", [() => gate]);
  const controller = new AbortController();
  const request = h.provider.streamSimple(h.model, { messages: [] }, {
    sessionId: h.session.sessionId, signal: controller.signal,
    onPayload: (payload: unknown) => h.session.extensionRunner.emitBeforeProviderRequest(payload),
  });
  assert.equal(ui.status(), "AGY: Working…");
  controller.abort();
  assert.equal(ui.status(), undefined);
  release();
  assert.equal((await request.result()).stopReason, "aborted");
});

test("real ExtensionRunner shutdown waits for owned child termination", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const stream = h.provider.streamSimple(h.model, { messages: [] }, { sessionId: h.session.sessionId });
  const child = h.children[0];
  const kill = child.kill.bind(child);
  t.after(() => { child.kill = kill; });
  // Control external child exit only; Pi dispatch and lifecycle awaiting are real.
  child.kill = () => { child.killed = true; return true; };
  let settled = false;
  const shutdown = h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(settled, false);
  assert.equal(ui.status(), undefined);
  assert.equal((await stream.result()).stopReason, "error");
  child.emit("exit", null, "SIGTERM");
  await shutdown;
  assert.equal(settled, true);
  child.kill = kill;
});

test("real runner invalidation prevents a captured callback from reaching a replacement UI", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const request = h.provider.streamSimple(h.model, { messages: [] }, { sessionId: h.session.sessionId });
  const child = h.children[0];
  child.send({ event: "init", conversation_id: "invalidated" });
  // A host can invalidate a runner independently of session_shutdown.
  h.session.extensionRunner.invalidate();
  const before = ui.status();
  await drain();
  child.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  await drain();
  child.result();
  await request.result();
  assert.equal(ui.status(), before, "late events must not mutate disposed UI");
});
