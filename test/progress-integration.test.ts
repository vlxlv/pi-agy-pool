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
  child.step({ step_type: "agent_response", text_delta: "First. " });
  await until(() => ui.status() === undefined, "text clears keyed status");
  child.step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "run_command" });
  await until(() => ui.terminal.writes.some((s) => s.includes("AGY: Running command…")), "tool after text rendered");
  child.step({ step_type: "tool", step_index: 2, state: "DONE" });
  child.step({ step_type: "subagent", step_index: 3, state: "ACTIVE", subagent_info: { subagents: [{ role: "Research" }] } });
  await until(() => ui.terminal.writes.some((s) => s.includes("AGY: Research subagent…")), "subagent rendered");
  child.step({ step_type: "subagent", step_index: 3, state: "DONE" });
  child.step({ step_type: "agent_response", text_delta: "Last." });
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
  child.step({ step_type: "agent_response", text_delta: "Again." });
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
  a.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  b.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
  assert.equal(ua.status(), "AGY: Reading file…");
  assert.equal(ub.status(), "AGY: Running command…");

  const newer = start(b);
  b.children[1].send({ event: "init", conversation_id: "isolation-b-newer" });
  b.children[1].step({ step_type: "tool", state: "ACTIVE", tool_name: "code_search" });
  b.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "write_file" });
  b.children[0].result();
  await rb.result();
  assert.equal(ub.status(), "AGY: Searching code…", "old request settlement cannot clear newer status");

  await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(ua.status(), undefined);
  a.children[0].step({ step_type: "tool", state: "ACTIVE", tool_name: "write_file" });
  a.children[0].result();
  await ra.result();
  assert.equal(ua.status(), undefined, "shutdown tokens remain invalid");
  assert.equal(ub.status(), "AGY: Searching code…");
  b.children[1].result();
  await newer.result();
  assert.equal(ub.status(), undefined);

  // A request with the wrong session ID cannot use B's bound UI.
  const mismatch = start(b, a.session.sessionId);
  b.children[2].send({ event: "init", conversation_id: "mismatch" });
  b.children[2].step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  assert.equal(ub.status(), undefined);
  b.children[2].result();
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
    next.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
    child.step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
    child.result();
    await old.result();
    assert.equal(ui.status(), "AGY: Reading file…");
    next.result();
    await fresh.result();
    assert.equal(ui.status(), undefined);
  }
  await delay(20); // let the final real renderer frame drain before teardown
});

test("request abort/error cleanup preserves another request and restores its status", async (t) => {
  const h = await createHarness();
  const ui = await attachTui(h);
  t.after(() => ui.close());
  const context = { messages: [{ role: "user", content: "offline", timestamp: 1 }] };
  const controller = new AbortController();
  const old = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId, signal: controller.signal });
  const first = h.children[0];
  first.send({ event: "init", conversation_id: "abort-old" });
  first.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  const fresh = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId });
  const second = h.children[1];
  second.send({ event: "init", conversation_id: "abort-new" });
  second.step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
  controller.abort();
  assert.equal((await old.result()).stopReason, "aborted");
  assert.equal(ui.status(), "AGY: Running command…");

  const failing = h.provider.streamSimple(h.model, context, { sessionId: h.session.sessionId });
  h.children[2].send({ event: "init", conversation_id: "error-new" });
  h.children[2].send({ event: "result", status: "ERROR", error: "test failure" });
  assert.equal((await failing.result()).stopReason, "error");
  assert.equal(ui.status(), "AGY: Running command…", "surviving request restored");
  second.result();
  await fresh.result();
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
  child.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
  child.result();
  await request.result();
  assert.equal(ui.status(), before, "late events must not mutate disposed UI");
});
