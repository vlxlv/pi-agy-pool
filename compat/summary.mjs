import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contracts } from "./contracts.mjs";
const reports = ["minimum", "latest"].map(target => {
  const path = join(process.argv[2], target, "report.json");
  return existsSync(path) ? JSON.parse(readFileSync(path)) : { target, resolved: "unresolved", node: "unknown", contracts: [], setupError: "Lane did not produce a report" };
});
const failed = report => Boolean(report.setupError) || !report.lockUnchanged ||
  contracts.some(c => report.contracts.find(r => r.name === c.name)?.status !== "pass");
const symbol = report => failed(report) ? report.target === "minimum" ? "🔴" : "🟡" : "🟢";
const title = failed(reports[0]) ? "🔴 MINIMUM COMPATIBILITY REGRESSION" :
  failed(reports[1]) ? "🟡 LATEST PI COMPATIBILITY ALERT" : "🟢 PI COMPATIBILITY PASS";
const lines = ["# " + title, "",
  ...reports.map(r => "**" + r.target + " · " + r.resolved + "** " + symbol(r) + " · Node " + r.node),
  "", "| Contract | Minimum · " + reports[0].resolved + " | Latest · " + reports[1].resolved + " |", "|---|---|---|",
  ...contracts.map(c => "| " + c.name + " | " + reports.map(r => {
    const status = r.contracts.find(x => x.name === c.name)?.status;
    return status === "pass" ? "🟢" : status === "fail" ? symbol(r) : "⚪ Not run";
  }).join(" | ") + " |"),
  "", ...reports.filter(r => r.setupError).map(r => r.target + " setup: " + r.setupError),
  "", "Tracking: https://github.com/vlxlv/pi-agy-pool/issues/1 (keep open).", ""];
const markdown = lines.join("\n");
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (reports.some(failed)) process.exitCode = 1;
