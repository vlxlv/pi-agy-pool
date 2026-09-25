import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import { FakeAgy } from "./helpers/pi-progress.ts";
import { MODELS, API_IDENTIFIER } from "../src/models.ts";
import { streamSimple, resetActiveProcesses, activeProcesses, sessionStates,
  validPostCompactionConversations, retiredConversationIds } from "../src/stream.ts";

const model: any = { ...MODELS[0], provider: "agy-pool", api: API_IDENTIFIER };
const user: any = { role: "user", content: "offline", timestamp: 1 };
afterEach(() => resetActiveProcesses());
function transport() {
  const child = new FakeAgy(); let args: string[] = [];
  return { child, get args() { return args; }, spawnFn: ((_bin: string, a: string[]) => { args = a; return child; }) as any };
}
async function finish(f: ReturnType<typeof transport>, request: any, id = "Y") {
  f.child.send({ event: "init", conversation_id: id }); await tick();
  f.child.result(); return request.result();
}
for (const changed of [false, true]) test(`conservative historical receipt ${changed ? "changed responseId" : "replay"} cannot resume`, async () => {
  const message: any = { role: "assistant", provider: model.provider, api: model.api,
    responseId: changed ? "forged-Y" : "X", stopReason: "stop", content: [], timestamp: 1,
    agyPoolOwner: { sessionId: "A", checkpoint: "saved-tip" } };
  const f = transport();
  const request = streamSimple(model, { messages: [message, user] } as any, {
    sessionId: "A", spawnFn: f.spawnFn, resume: message.agyPoolOwner,
  } as any);
  assert.ok(!f.args.includes("--conversation"));
  await finish(f, request);
});
test("conservative ephemeral indexes return to baseline after 100 requests", async () => {
  const baseline = [sessionStates.size, activeProcesses.size, validPostCompactionConversations.size, retiredConversationIds.size];
  for (let n = 0; n < 100; n++) {
    const f = transport(); const request = streamSimple(model, { messages: [user] } as any, { spawnFn: f.spawnFn });
    await finish(f, request, `ephemeral-${n}`); await tick(); assert(f.child.killed);
  }
  assert.deepEqual([sessionStates.size, activeProcesses.size, validPostCompactionConversations.size, retiredConversationIds.size], baseline);
});
for (const mode of ["clean", "crash", "hold"]) test(`conservative real Node ${mode} ownership loss starts fresh`, async () => {
  const start = (mode: string, file?: string) => {
    const child = fork(new URL("./helpers/ownership-child.ts", import.meta.url), [mode, ...(file ? [file] : [])], { execArgv: [], silent: true });
    let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
    const exited = once(child, "exit");
    const info = new Promise<any>((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", code => reject(new Error(`Child exited before report: ${code} ${stderr}`)));
    });
    return { child, exited, info };
  };
  const seed = start(mode); let info: any; let reader: ReturnType<typeof start> | undefined;
  try {
    info = await seed.info;
    if (mode === "crash") { assert.equal(info.submitted, 2); assert.equal((await seed.exited)[1], "SIGKILL"); }
    if (mode === "clean") assert.equal((await seed.exited)[0], 0);
    reader = start("open", info.file); const reopened = await reader.info;
    assert.equal((await reader.exited)[0], 0);
    if (mode === "hold") assert.equal(seed.child.exitCode, null);
    assert.ok(!reopened.args.includes("--conversation"), JSON.stringify(reopened.args));
  } finally {
    if (seed.child.connected) seed.child.send("close");
    if (mode === "hold") await seed.exited;
    if (reader?.child.exitCode === null && reader.child.signalCode === null) { reader.child.kill(); await reader.exited; }
    if (info) await rm(info.dir, { recursive: true, force: true });
  }
});

for (const code of [0, 1, null]) test(`conservative idle exit ${code} retains completed in-memory continuity`, async () => {
  const a = transport();
  const first = streamSimple(model, { messages: [user] } as any, { sessionId: "A", spawnFn: a.spawnFn });
  const answer = await finish(a, first, "X");
  a.child.emit("exit", code, code === null ? "SIGTERM" : null);
  const b = transport();
  const next = streamSimple(model, { messages: [user, answer, user] } as any, { sessionId: "A", spawnFn: b.spawnFn });
  assert.equal(b.args[b.args.indexOf("--conversation") + 1], "X");
  await finish(b, next, "X");
});
test("conservative exit during submitted turn discards in-memory resume authority", async () => {
  const a = transport();
  const first = streamSimple(model, { messages: [user] } as any, { sessionId: "A", spawnFn: a.spawnFn });
  const answer = await finish(a, first, "X");
  const history: any = { messages: [user, answer, user] };
  const interrupted = streamSimple(model, history, { sessionId: "A", spawnFn: a.spawnFn });
  await tick(); assert.equal(a.child.turns, 2); a.child.emit("exit", 1, null);
  assert.equal((await interrupted.result()).stopReason, "error");
  const b = transport(); const next = streamSimple(model, history, { sessionId: "A", spawnFn: b.spawnFn });
  assert.ok(!b.args.includes("--conversation")); await finish(b, next);
});
test("conservative cancelled preparation without a completed turn cannot authorize replacement", async () => {
  const a = transport(), controller = new AbortController();
  const first = streamSimple(model, { messages: [user] } as any, {
    sessionId: "A", spawnFn: a.spawnFn, signal: controller.signal, onPayload: () => new Promise(() => {}),
  });
  a.child.send({ event: "init", conversation_id: "X" }); await tick(); controller.abort();
  assert.equal((await first.result()).stopReason, "aborted"); assert.equal(a.child.turns, 0);
  const b = transport(); const next = streamSimple({ ...model, id: "different-model" }, { messages: [user] } as any, { sessionId: "A", spawnFn: b.spawnFn });
  assert.ok(!b.args.includes("--conversation")); await finish(b, next);
});
