import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as drain } from "node:timers/promises";
import { streamSimple, resetActiveProcesses, activeProcesses, retireSessionConversation, findConversationId, getSessionState, releaseSessionProcesses, markSessionCompacted, releaseProviderProcesses } from "../src/stream.ts";
import { MODELS, API_IDENTIFIER } from "../src/models.ts";
const model: any = { ...MODELS[0], api: API_IDENTIFIER, provider: "agy-pool" };
const user: any = { role: "user", content: "offline", timestamp: 0 };
function transport() {
    const c: any = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    const writes: string[] = [];
    const signals: string[] = [];
    let args: string[] = [];
    c.stdin.on("data", (x: Buffer) => writes.push(JSON.parse(x.toString()).message.content));
    c.kill = (s: string) => { signals.push(s); queueMicrotask(() => c.emit("exit", 0, s)); return true; };
    const send = (e: any) => c.stdout.write(JSON.stringify(e) + "\n");
    return { c, writes, signals, get args() { return args; }, spawnFn: ((_b: string, a: string[]) => { args = a; return c; }) as any,
        init: (id: string) => send({ event: "init", conversation_id: id }), result: () => send({ event: "result", status: "SUCCESS" }), send };
}
afterEach(async () => { await resetActiveProcesses(); });
async function first(sid = "A", id = "X") {
    const f = transport();
    const s = streamSimple(model, { messages: [user] } as any, { sessionId: sid, spawnFn: f.spawnFn });
    f.init(id);
    await drain();
    f.result();
    return { f, answer: await s.result() };
}
function history(a: any): any { return { messages: [user, a, user] }; }
for (const provider of ["openai", "anthropic", "google", "another-extension"]) {
    test(`ownership foreign ${provider} responseId rejected`, async () => {
        const { answer } = await first();
        await resetActiveProcesses();
        const a = { ...answer, provider, api: "responses", responseId: "resp_foreign" };
        assert.equal(findConversationId(history(a)), undefined);
        const f = transport();
        const request = streamSimple(model, history(a), {
            sessionId: "A", spawnFn: f.spawnFn, resume: (a as any).agyPoolOwner,
        } as any);
        assert.ok(!f.args.includes("--conversation"));
        f.init("fresh");
        await drain();
        f.result();
        assert.equal((await request.result()).responseId, "fresh");
    });
}
test("ownership cross-session historical X cannot steal live A", async () => {
    const { f, answer } = await first();
    const b = transport();
    const s = streamSimple(model, history(answer), { sessionId: "B", spawnFn: b.spawnFn });
    assert.ok(b.args.length);
    assert.ok(!b.args.includes("--conversation"));
    assert.equal(f.writes.length, 1);
    b.init("Y");
    await drain();
    b.result();
    assert.equal((await s.result()).responseId, "Y");
    assert.equal(f.signals.length, 0);
});
test("ownership normal same-session continuity", async () => {
    const { f, answer } = await first();
    const s = streamSimple(model, history(answer), { sessionId: "A", spawnFn: () => { throw Error("duplicate spawn"); } });
    await drain();
    assert.equal(f.writes.length, 2);
    f.result();
    assert.equal((await s.result()).responseId, "X");
});
test("ownership missing identity never infers session from history", async () => {
    const { f, answer } = await first();
    const b = transport();
    const s = streamSimple(model, history(answer), { spawnFn: b.spawnFn });
    assert.ok(b.args.length);
    assert.ok(!b.args.includes("--conversation"));
    b.init("Y");
    await drain();
    b.result();
    await s.result();
    assert.equal(f.writes.length, 1);
});
test("ownership historical receipt cannot authorize new-process restart", async () => {
    const { answer } = await first();
    assert.equal((answer as any).agyPoolOwner, undefined);
    await resetActiveProcesses();
    const f = transport();
    const s = streamSimple(model, history(answer), { sessionId: "A", spawnFn: f.spawnFn, resume: (answer as any).agyPoolOwner } as any);
    assert.ok(!f.args.includes("--conversation"));
    f.init("Y");
    await drain();
    f.result();
    await s.result();
});
test("ownership same-session concurrent acquisition", async () => {
    const f = transport();
    let n = 0;
    const spawnFn: any = (...args: any[]) => { n++; return f.spawnFn(...args); };
    const a = streamSimple(model, { messages: [user] } as any, { sessionId: "A", spawnFn });
    const b = streamSimple(model, { messages: [user] } as any, { sessionId: "A", spawnFn });
    assert.equal(n, 1);
    f.init("X");
    await drain();
    assert.equal(f.writes.length, 1);
    f.result();
    await drain();
    assert.equal(f.writes.length, 2);
    f.result();
    await Promise.all([a.result(), b.result()]);
});
test("ownership A retirement cannot kill B", async () => {
    const a = await first("A", "X"), b = await first("B", "Y");
    await retireSessionConversation("A");
    assert.equal(b.f.signals.length, 0);
    assert.ok(activeProcesses.get("Y")?.isAlive());
});
test("ownership different sessions concurrent acquisition is independent", async () => {
    const a = transport(), b = transport();
    const sa = streamSimple(model, { messages: [user] } as any, { sessionId: "A", spawnFn: a.spawnFn });
    const sb = streamSimple(model, { messages: [user] } as any, { sessionId: "B", spawnFn: b.spawnFn });
    assert.ok(a.args.length && b.args.length);
    a.init("X");
    b.init("Y");
    await drain();
    a.result();
    b.result();
    await Promise.all([sa.result(), sb.result()]);
    assert.notEqual(getSessionState("A").process, getSessionState("B").process);
});
test("ownership receipt cannot resume a different live owner's native conversation", async () => {
    const { answer } = await first();
    const b = transport();
    const forged = { ...answer, agyPoolOwner: { sessionId: "B", checkpoint: "old-B-receipt" } };
    const sb = streamSimple(model, history(forged), { sessionId: "B", spawnFn: b.spawnFn, resume: forged.agyPoolOwner } as any);
    assert.ok(!b.args.includes("--conversation"));
    b.init("Y");
    await drain();
    b.result();
    await sb.result();
});
test("ownership compaction X to Y preserves independent B", async () => {
    const a = await first(), b = await first("B", "Z");
    await markSessionCompacted("A");
    const f = transport();
    const s = streamSimple(model, history(a.answer), { sessionId: "A", spawnFn: f.spawnFn });
    assert.ok(!f.args.includes("--conversation"));
    f.init("Y");
    await drain();
    f.result();
    const answer = await s.result();
    assert.equal(getSessionState("A").activeConversationId, "Y");
    assert.equal(b.f.signals.length, 0);
    const next = streamSimple(model, history(answer), { sessionId: "A", spawnFn: () => { throw Error("lost Y"); } });
    await drain();
    f.result();
    await next.result();
});
for (const change of ["model", "effort"]) {
    test(`ownership replacement ${change} ignores old exit/init`, async () => {
        const a = await first();
        const old = getSessionState("A").process!;
        const f = transport();
        const s = streamSimple(change === "model" ? { ...model, id: "other" } : model, history(a.answer), { sessionId: "A", spawnFn: f.spawnFn, reasoning: change === "effort" ? "high" : undefined });
        assert.equal(f.args[f.args.indexOf("--conversation") + 1], "X");
        f.init("X");
        const owner = getSessionState("A").process;
        assert.notEqual(owner, old);
        old.emit("init", { event: "init", conversation_id: "stale" });
        old.emit("exit", 0, null);
        await drain();
        assert.equal(getSessionState("A").process, owner);
        assert.equal(getSessionState("A").activeConversationId, "X");
        assert.equal(activeProcesses.get("X"), owner);
        f.result();
        await s.result();
    });
}
test("ownership stale runner cleanup cannot erase replacement binding", async () => {
    const oldOwner = Symbol(), newOwner = Symbol(), a = transport();
    const first = streamSimple(model, { messages: [user] } as any, { sessionId: "A", owner: oldOwner, spawnFn: a.spawnFn });
    a.init("X");
    await drain();
    a.result();
    const answer = await first.result();
    await releaseSessionProcesses("A", oldOwner);
    const b = transport();
    const next = streamSimple(model, history(answer), { sessionId: "A", owner: newOwner, spawnFn: b.spawnFn });
    b.init("X");
    await drain();
    await releaseSessionProcesses("A", oldOwner);
    assert.equal(b.signals.length, 0);
    b.result();
    await next.result();
});
test("ownership two runners with same session ID cannot share live process", async () => {
    const a = transport(), b = transport();
    const one = streamSimple(model, { messages: [user] } as any, { sessionId: "A", owner: Symbol(), spawnFn: a.spawnFn });
    a.init("X");
    await drain();
    a.result();
    const answer = await one.result();
    const two = streamSimple(model, history(answer), { sessionId: "A", owner: Symbol(), spawnFn: b.spawnFn });
    assert.ok(b.args.length);
    assert.ok(!b.args.includes("--conversation"));
    b.init("Y");
    await drain();
    b.result();
    await two.result();
    assert.equal(a.signals.length, 0);
});
test("ownership matching provider with foreign API is rejected", () => {
    assert.equal(findConversationId(history({ role: "assistant", provider: "agy-pool", api: "google-generative-ai", responseId: "foreign" })), undefined);
});
test("ownership late pre-init process callbacks cannot change replacement", async () => {
    const oldOwner = Symbol(), newOwner = Symbol(), a = transport(), b = transport();
    const one = streamSimple(model, { messages: [user] } as any, { sessionId: "A", owner: oldOwner, spawnFn: a.spawnFn });
    const old = getSessionState("A").process!;
    await releaseProviderProcesses(oldOwner);
    assert.equal((await one.result()).stopReason, "error");
    const two = streamSimple(model, { messages: [user] } as any, { sessionId: "A", owner: newOwner, spawnFn: b.spawnFn });
    b.init("Y");
    await drain();
    const replacement = getSessionState("A").process;
    old.init = { event: "init", conversation_id: "stale" };
    old.conversationId = "stale";
    old.emit("init");
    old.emit("invalidated");
    old.emit("exit", 0, null);
    await releaseProviderProcesses(oldOwner);
    assert.equal(getSessionState("A").process, replacement);
    assert.equal(getSessionState("A").activeConversationId, "Y");
    assert.equal(b.signals.length, 0);
    b.result();
    await two.result();
});

test("ownership busy replacement cannot resume a partial native future", async () => {
    const { f, answer } = await first();
    const pending = streamSimple(model, history(answer), { sessionId: "A", spawnFn: f.spawnFn });
    await drain();
    assert.equal(f.writes.length, 2);
    const next = transport();
    const replacement = streamSimple({ ...model, id: "other" }, history(answer), { sessionId: "A", spawnFn: next.spawnFn });
    assert.ok(!next.args.includes("--conversation"));
    assert.equal((await pending.result()).stopReason, "error");
    next.init("Y");
    await drain();
    next.result();
    assert.equal((await replacement.result()).responseId, "Y");
});
