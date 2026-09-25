import { ownershipHarness } from "./pi-ownership.ts";
import { setImmediate as tick } from "node:timers/promises";
import { once } from "node:events";

async function until(check: () => boolean) {
  for (let n = 0; n < 30000; n++) { if (check()) return; await tick(); }
  throw new Error("Ownership child barrier exhausted");
}
const mode = process.argv[2];
const h = await ownershipHarness(mode !== "open");
if (mode === "open") { await h.host.dispose(); await h.reopen(process.argv[3]); }
const first = h.session.prompt("offline");
await until(() => h.children.length === 1);
const child = h.children[0];
child.send({ event: "init", conversation_id: mode === "open" ? "fresh-Y" : "X" });
await until(() => child.turns === 1);
await tick();
child.step({ step_type: "agent_response", text_delta: "offline answer" });
child.result();
await first;
if (mode === "crash") {
  void h.session.prompt("submitted but not persisted");
  await until(() => child.turns === 2);
}
process.send!({ file: h.session.sessionFile, dir: h.dir, args: child.args, submitted: child.turns }, () => {
  if (mode === "crash") process.kill(process.pid, "SIGKILL");
});
if (mode === "hold") await once(process, "message");
if (mode !== "crash") {
  if (mode === "open") await h.close();
  else await h.host.dispose(); // Parent owns the saved fixture directory.
  process.disconnect();
} else await new Promise(() => {});
