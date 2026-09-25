import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as drain } from "node:timers/promises";
import { ownershipHarness } from "./helpers/pi-ownership.ts";
import { resetActiveProcesses } from "../src/stream.ts";
async function until(check: () => boolean) { for (let i = 0; i < 20000; i++) {
    if (check())
        return;
    await drain();
} assert.fail("event-loop barrier exhausted"); }
async function turn(h: any, id: string) {
    const before = h.children.length;
    const existing = h.children.at(-1);
    const written = existing?.turns || 0;
    const pending = h.session.prompt("offline");
    await until(() => h.children.length > before || existing?.turns > written);
    const child = h.children.at(-1);
    if (h.children.length > before)
        child.send({ event: "init", conversation_id: id });
    await until(() => child.turns > (child === existing ? written : 0));
    await drain();
    child.step({ step_type: "agent_response", text_delta: "answer" });
    child.result();
    await pending;
    return h.session.sessionManager.getLeafId();
}
for (const point of ["tip", "older"]) {
    test(`real Pi fork ${point} starts fresh`, async (t) => {
        const h = await ownershipHarness();
        t.after(() => h.close());
        const first = await turn(h, "X");
        await turn(h, "X");
        const tip = await turn(h, "X");
        assert.equal(h.children.length, 1);
        const old = h.session.sessionId;
        await h.host.fork(point === "tip" ? tip : first, { position: "at" });
        assert.notEqual(h.session.sessionId, old);
        await turn(h, "Y");
        assert.equal(h.children.length, 2);
        assert.ok(!h.children[1].args.includes("--conversation"));
        assert.ok(h.events.includes("session_before_fork:"));
        assert.ok(h.events.includes("session_shutdown:fork"));
        assert.ok(h.events.includes("session_start:fork"));
    });
}
test("real Pi tree backward and sibling invalidates mutable future", async (t) => {
    const h = await ownershipHarness();
    t.after(() => h.close());
    const first = await turn(h, "X");
    const oldTip = await turn(h, "X");
    await h.session.navigateTree(first);
    await turn(h, "Y");
    assert.equal(h.children.length, 2);
    assert.ok(!h.children[1].args.includes("--conversation"));
    await h.session.navigateTree(oldTip);
    await turn(h, "Z");
    assert.equal(h.children.length, 3);
    assert.ok(!h.children[2].args.includes("--conversation"));
});
test("real Pi persisted restart bootstraps without native resume", async (t) => {
    const h = await ownershipHarness(true);
    t.after(() => h.close());
    await turn(h, "X");
    const file = h.session.sessionFile;
    const message = h.session.state.messages.at(-1);
    assert.equal(message.responseId, "X");
    await h.host.dispose();
    await resetActiveProcesses();
    await h.reopen(file);
    await turn(h, "X");
    assert.ok(!h.children.at(-1)!.args.includes("--conversation"));
});
for (const point of ["tip", "older"]) {
    test(`real Pi restart then fork ${point} cannot resume historical X`, async (t) => {
        const h = await ownershipHarness(true);
        t.after(() => h.close());
        const first = await turn(h, "X"), tip = await turn(h, "X");
        const file = h.session.sessionFile;
        await h.host.dispose();
        await resetActiveProcesses();
        await h.reopen(file);
        await h.host.fork(point === "tip" ? tip : first, { position: "at" });
        await turn(h, "Y");
        assert.ok(!h.children.at(-1)!.args.includes("--conversation"));
    });
}
test("real Pi resume historical older projection starts fresh", async (t) => {
    const h = await ownershipHarness(true);
    t.after(() => h.close());
    const first = await turn(h, "X");
    await turn(h, "X");
    await h.session.navigateTree(first);
    h.session.sessionManager.appendCustomEntry("test-branch-position", {});
    const file = h.session.sessionFile;
    await h.host.dispose();
    await resetActiveProcesses();
    await h.reopen(file);
    await turn(h, "Y");
    assert.ok(!h.children.at(-1)!.args.includes("--conversation"));
});
test("real Pi switch A to B preserves independent process owner", async (t) => {
    const a = await ownershipHarness(true), b = await ownershipHarness(true);
    t.after(async () => { await a.close(); await b.close(); });
    await turn(a, "X");
    await turn(b, "Y");
    await a.host.switchSession(b.session.sessionFile);
    await turn(a, "Z");
    assert.ok(!a.children.at(-1)!.args.includes("--conversation"));
    assert.equal(b.children[0].killed, false);
    await turn(b, "Y");
    assert.equal(b.children.length, 1);
});
test("real Pi reload loses ownership and bootstraps fresh", async (t) => {
    const h = await ownershipHarness();
    t.after(() => h.close());
    await turn(h, "X");
    await h.session.reload();
    await turn(h, "X");
    const args = h.children.at(-1)!.args;
    assert.ok(!args.includes("--conversation"));
});
for (const action of ["fork", "switch"]) {
    test(`real Pi cancelled ${action} preserves current process`, async (t) => {
        const h = await ownershipHarness(true, pi => pi.on(action === "fork" ? "session_before_fork" : "session_before_switch", () => ({ cancel: true })));
        t.after(() => h.close());
        const leaf = await turn(h, "X");
        const sid = h.session.sessionId;
        const result = action === "fork" ? await h.host.fork(leaf, { position: "at" }) : await h.host.switchSession(h.session.sessionFile);
        assert.equal(result.cancelled, true);
        assert.equal(h.session.sessionId, sid);
        assert.equal(h.children[0].killed, false);
        await turn(h, "X");
        assert.equal(h.children.length, 1);
    });
}

test("real Pi copied historical receipt on an older branch cannot restore mutable X", async t => {
    const h = await ownershipHarness(true); t.after(() => h.close());
    const a1 = await turn(h, "X"); const message = h.session.sessionManager.getEntry(a1).message;
    await turn(h, "X"); await turn(h, "X");
    h.session.sessionManager.branch(a1);
    h.session.sessionManager.appendMessage({ ...structuredClone(message), agyPoolOwner: { sessionId: h.session.sessionId, checkpoint: "legacy-copied-tip" } });
    const file = h.session.sessionFile; await h.host.dispose(); await resetActiveProcesses(); await h.reopen(file);
    await turn(h, "Y"); assert.ok(!h.children.at(-1)!.args.includes("--conversation"));
});
