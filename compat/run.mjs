import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { contracts } from "./contracts.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
assert(["minimum", "latest"].includes(target), "Usage: node compat/run.mjs minimum|latest [resolved-version]");
const requested = target === "minimum" ? "0.87.1" : "latest";
const reportDir = resolve(process.env.PI_COMPAT_REPORT_DIR ?? mkdtempSync(join(tmpdir(), "pi-compat-report-")));
mkdirSync(reportDir, { recursive: true });
const sandbox = mkdtempSync(join(tmpdir(), "pi-compat-runtime-"));
const lockHash = () => createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex");
const before = lockHash();
const report = { target, requested, resolved: process.argv[3] ?? "", aiVersion: "", node: process.version,
  setupError: "", lockUnchanged: true, contracts: contracts.map(c => ({ name: c.name, status: "pending", tests: 0 })) };
function command(bin, args, cwd = sandbox) {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(bin + " " + args.join(" ") + ": " + (result.error ?? result.stderr ?? result.stdout));
  return result.stdout;
}
function packageRoot(entry) {
  let dir = dirname(entry);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir); assert.notEqual(parent, dir); dir = parent;
  }
  return dir;
}
try {
  report.resolved ||= JSON.parse(command("npm", ["view", "@earendil-works/pi-coding-agent@" + requested, "version", "--json"], root));
  assert.match(report.resolved, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  if (target === "minimum") assert.equal(report.resolved, "0.87.1");
  console.log("Pi Compatibility · " + target + " · requested=" + requested + " · resolved=" + report.resolved + " · Node=" + process.version);
  // Real copies, not symlinks: bare imports resolve inside the isolated dependency root.
  for (const dir of ["src", "test", "compat"]) cpSync(join(root, dir), join(sandbox, dir), { recursive: true });
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "@earendil-works/pi-coding-agent": report.resolved } }, null, 2));
  writeFileSync(join(reportDir, "install.log"), command("npm", ["install", "--no-audit", "--no-fund"]));
  const agentRoot = join(sandbox, "node_modules/@earendil-works/pi-coding-agent");
  assert.equal(JSON.parse(readFileSync(join(agentRoot, "package.json"))).version, report.resolved);
  // Honor target Pi's shrinkwrap/dependency resolution rather than assume a version pair.
  const aiEntry = command(process.execPath, ["--input-type=module", "-e",
    "console.log(import.meta.resolve('@earendil-works/pi-ai'))"], agentRoot).trim();
  const aiRoot = packageRoot(fileURLToPath(aiEntry));
  assert(realpathSync(aiRoot).startsWith(realpathSync(sandbox) + "/"), "Pi AI escaped isolated environment");
  report.aiVersion = JSON.parse(readFileSync(join(aiRoot, "package.json"))).version;
  const peer = join(sandbox, "node_modules/@earendil-works/pi-ai");
  if (!existsSync(peer)) symlinkSync(aiRoot, peer, "dir");
  assert.equal(realpathSync(peer), realpathSync(aiRoot), "provider and target Pi must use the same pi-ai");
  writeFileSync(join(reportDir, "runtime.json"), JSON.stringify({ agentRoot, aiRoot, ...report }, null, 2));
  for (const [index, contract] of contracts.entries()) {
    const pattern = "^(?:" + contract.tests.map(s => s.replace(/[.*+?^{}()|[\]\\]/g, "\\$&")).join("|") + ")$";
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=60000",
      "--test-name-pattern=" + pattern, contract.file], {
      cwd: sandbox, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NODE_PATH: "", NO_COLOR: "1" },
    });
    const log = (result.stdout ?? "") + (result.stderr ?? "") + (result.error ?? "");
    writeFileSync(join(reportDir, "contract-" + (index + 1) + ".log"), log);
    const passed = Number(log.match(/^# pass (\d+)$/m)?.[1] ?? 0);
    // A rename or zero-test selection must never produce a false green.
    const ok = result.status === 0 && !result.error && passed === contract.tests.length;
    report.contracts[index] = { name: contract.name, status: ok ? "pass" : "fail", tests: passed };
    console.log((ok ? "🟢" : target === "minimum" ? "🔴" : "🟡") + " " + contract.name + ": " + passed + "/" + contract.tests.length);
  }
} catch (error) {
  report.setupError = String(error);
  console.error(report.setupError);
} finally {
  report.lockUnchanged = before === lockHash();
  const failed = Boolean(report.setupError) || !report.lockUnchanged || report.contracts.some(c => c.status !== "pass");
  const light = failed ? target === "minimum" ? "🔴" : "🟡" : "🟢";
  const title = failed ? target === "minimum" ? "MINIMUM COMPATIBILITY REGRESSION" : "LATEST PI COMPATIBILITY ALERT" : "PI COMPATIBILITY PASS";
  const summary = [
    "# " + light + " " + title, "", "**" + target + " · " + (report.resolved || "unresolved") + "**", "",
    "Requested: " + requested + " · Resolved Pi: " + (report.resolved || "unresolved") + " · pi-ai: " + (report.aiVersion || "unresolved") + " · Node: " + process.version, "",
    "| Contract | Result |", "|---|---|",
    ...report.contracts.map(c => "| " + c.name + " | " + (c.status === "pass" ? "🟢 PASS" : c.status === "fail" ? light + " FAIL" : "⚪ Not run") + " |"),
    "", "Project lockfile unchanged: **" + (report.lockUnchanged ? "yes" : "NO") + "**",
    ...(report.setupError ? ["", "## Setup failure", "", "~~~~text", report.setupError, "~~~~"] : []),
    "", "Logs and resolved dependency paths are attached as workflow artifacts.", "",
  ].join("\n");
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(reportDir, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log("Reports: " + reportDir + "\n" + light + " " + title);
  rmSync(sandbox, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
