import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["print", "json", "rpc"]) {
  test(`real ${mode} mode has no AGY progress UI or output pollution`, async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./helpers/pi-mode-child.ts", import.meta.url)), mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (mode === "rpc" && stdout.includes('"type":"agent_end"')) child.stdin.end();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (mode === "rpc") child.stdin.write('{"type":"prompt","message":"offline"}\n');
    else child.stdin.end();
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert(!/AGY:|Working…|Reading file|Running subagent|done; continuing/.test(stdout));
    if (mode === "print") assert.equal(stdout.trim(), "Offline answer.");
    else {
      const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert(records.some((r) => r.type === "agent_end"));
      assert(!records.some((r) => r.type === "extension_ui_request"));
      assert(!records.some((r) => r.type.startsWith("tool_execution")));
    }
  });
}
