import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expected = [
  "LICENSE", "README.md", "package.json",
  "src/agy-events.ts", "src/agy-process.ts", "src/diagnostics.ts",
  "src/index.ts", "src/models.ts", "src/provider.ts", "src/stream.ts",
].sort();
const input = process.argv[2];
assert(input, "Expected --json (npm pack JSON on stdin) or a tarball path");
const files = input === "--json"
  ? JSON.parse(readFileSync(0, "utf8"))[0].files.map(file => file.path)
  : execFileSync("tar", ["-tf", input], { encoding: "utf8" }).trim().split("\n")
      .map(file => file.replace(/^package\//, ""));
assert.deepEqual(files.sort(), expected, "Unexpected package inventory");
console.log(`Package inventory verified: ${files.length} files`);
