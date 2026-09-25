import { rm } from "node:fs/promises";
import { createHarness, piModule, until } from "./pi-progress.ts";

const h = await createHarness();
const mode = process.argv[2];
// Observe the real runner context without replacing any UI implementation.
h.session.extensionRunner.extensions.push({ path: "mode-observer", handlers: new Map([
  ["session_start", [(_event: unknown, ctx: any) => {
    if (ctx.mode !== mode) throw new Error(`Wrong binding: ${ctx.mode}`);
  }]],
]) });
const feed = (async () => {
  await until(() => h.children.length > 0, "provider request");
  const child = h.children[0];
  child.send({ event: "init", conversation_id: `non-tui-${mode}` });
  await until(() => child.turns === 1, "AGY prompt");
  child.step({ step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "view_file" });
  child.step({ step_type: "tool", step_index: 1, state: "DONE" });
  child.step({ step_type: "subagent", step_index: 2, state: "ACTIVE" });
  child.step({ step_type: "subagent", step_index: 2, state: "DONE" });
  child.step({ step_type: "agent_response", text_delta: "Offline answer." });
  child.result();
})();
if (mode === "rpc") {
  // Pi's real RPC entry point owns stdin/stdout and exits on stdin EOF.
  // Clean the isolated test directory after its real shutdown/dispose completes.
  const dispose = h.host.dispose.bind(h.host);
  h.host.dispose = async () => { await dispose(); await rm(h.dir, { recursive: true, force: true }); };
  const { runRpcMode } = await piModule("modes/rpc/rpc-mode");
  void feed.catch((error) => { process.stderr.write(String(error)); process.exit(1); });
  await runRpcMode(h.host);
} else {
  const { runPrintMode } = await piModule("modes/print-mode");
  const code = await runPrintMode(h.host, { mode: mode === "json" ? "json" : "text", messages: ["offline"] });
  await feed;
  await rm(h.dir, { recursive: true, force: true });
  process.exitCode = code;
}
