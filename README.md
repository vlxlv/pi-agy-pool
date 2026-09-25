# pi-agy-pool

[![CI](https://github.com/vlxlv/pi-agy-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/vlxlv/pi-agy-pool/actions/workflows/ci.yml) [![Pi Compatibility](https://github.com/vlxlv/pi-agy-pool/actions/workflows/pi-compat.yml/badge.svg)](https://github.com/vlxlv/pi-agy-pool/actions/workflows/pi-compat.yml) [![Release](https://img.shields.io/github/v/release/vlxlv/pi-agy-pool?display_name=tag)](https://github.com/vlxlv/pi-agy-pool/releases/latest) [![License](https://img.shields.io/github/license/vlxlv/pi-agy-pool)](https://github.com/vlxlv/pi-agy-pool/blob/main/LICENSE)

`pi-agy-pool` is a standard, installable [Pi](https://github.com/earendil-works/pi) package and model-provider extension that routes model generation through [`agy-pool-go`](https://github.com/vlxlv/agy-pool-go) and official Antigravity headless.

> **Important:** `pi-agy-pool` does **not** manage Google accounts, OAuth tokens, authentication, quota, or failovers. All account management and scheduling belong strictly to `agy-pool-go`.

---

## Architecture

```text
Pi
 ↓
pi-agy-pool (installed extension package)
 ↓ subprocess spawn (argument array)
agy-pool run -- <native AGY stream-json args>
 ↓
official agy-native
 ↓ CLOUD_CODE_URL configured by agy-pool-go
agy-pool-go local gateway (:8899)
 ↓
existing multi-account scheduler / OAuth / quota / failover
 ↓
Google
```

---

## Prerequisites

- **Pi CLI** (`pi`) installed and available in `PATH` (`>=0.87.1`).
- **`agy-pool`** binary installed and available in `PATH` (or configured via `AGY_POOL_BIN`).
- A running **`agy-pool-go`** daemon.
- Official **Antigravity** installed and managed by `agy-pool`.

### Pi compatibility

Pi `0.87.1` is the minimum supported version and compatibility baseline.

A dedicated compatibility matrix checks the minimum supported Pi and dynamically
resolved latest upstream Pi using real Pi runtimes with controlled AGY transport.
It covers provider loading, generation, lifecycle, system/context projection,
context edits, compaction, fork/tree behavior, skills discovery, Working UI,
non-interactive modes, and retry/no-replay semantics. No Google generation,
accounts, or gateway are required for these checks.

See [Pi Compatibility](https://github.com/vlxlv/pi-agy-pool/actions/workflows/pi-compat.yml)
and the [compatibility tracker](https://github.com/vlxlv/pi-agy-pool/issues/1).

### Pi Skills

Pi's advertised skills remain available through `pi-agy-pool`. Official AGY can
discover the skill catalog supplied by Pi's ResourceLoader and load advertised
`SKILL.md` files on demand using its native file tools.

No skill-specific bridge or duplicate Pi tool execution is required.

### Live progress

In Pi's interactive TUI, activity appears in Pi's native Working indicator.
Tool and subagent telemetry is informational: official AGY executes the tools;
Pi never executes them again. The footer remains available for its existing information
and other extensions' statuses.

Each request owns its progress within the matching Pi session. If requests overlap,
the newest request owns the status until it finishes, then any remaining request's
status is restored. Short operations retain a completed-action label until the next
activity or assistant text; execution is never delayed to keep a label on screen.
Text and terminal completion restore Pi's default Working message. A later tool
can supply an activity label again.

Only fixed tool descriptions and recognized role labels are displayed; unknown
names restore Pi's default Working message. Arguments, paths, output and prompts
are not displayed.
Print, JSON and RPC modes receive no progress UI updates. The lifecycle/rendering
integration is tested against Pi 0.87.1.

---

## Installation

The recommended Pi 0.87.1+ installation uses Git and tracks the repository's default branch:

```bash
pi install git:github.com/vlxlv/pi-agy-pool
```

For a specific release artifact, download its npm-compatible `.tgz` archive from
[GitHub Releases](https://github.com/vlxlv/pi-agy-pool/releases), extract it into a
persistent directory, then install the extracted `package/` directory:

```bash
mkdir -p "$HOME/.local/share/pi-agy-pool/X.Y.Z"
tar -xzf ./pi-agy-pool-X.Y.Z.tgz -C "$HOME/.local/share/pi-agy-pool/X.Y.Z"
pi install "$HOME/.local/share/pi-agy-pool/X.Y.Z/package"
```

Replace `X.Y.Z` with the downloaded version. Pi keeps a reference to this directory;
keep it after installation. Direct `.tgz` installation is unsupported by Pi 0.87.1.
Choose one installation source to avoid registering the extension twice.

Verify that Pi has automatically discovered the extension and registered the models:

```bash
pi --list-models agy
```

Output will show the registered `agy-pool` model family:

```text
provider  model                     context  max-out  thinking  images
agy-pool  gemini-3.8-flash          1.0M     65.5K    yes       no
agy-pool  gemini-3.7-flash          1.0M     65.5K    yes       no
agy-pool  gemini-3.6-flash          1.0M     65.5K    yes       no
agy-pool  gemini-3.1-pro            1.0M     65.5K    yes       no
agy-pool  claude-sonnet-4-6         250K     64K      no        no
agy-pool  claude-opus-4-6-thinking  250K     64K      no        no
agy-pool  gpt-oss-120b-medium       131.1K   32.8K    no        no
```

### Updating and Uninstalling

```bash
# List installed packages
pi list

# Update a Git installation
pi update git:github.com/vlxlv/pi-agy-pool

# Remove a Git installation using its exact source
pi remove git:github.com/vlxlv/pi-agy-pool

# Remove an extracted release installation using its directory source
pi remove "$HOME/.local/share/pi-agy-pool/X.Y.Z/package"
```

For an archive update, remove the old directory source, then extract and install
the new version using the commands above. `pi update` does not download new local
archives. `pi list` shows configured sources; use the matching source for removal.

### Development & Debugging

During local development or debugging, you can install directly from a local checkout or run uninstalled source with the `-e` flag:

```bash
# Install from local source checkout
pi install ./path/to/pi-agy-pool
# Remove from the same working directory:
pi remove ./path/to/pi-agy-pool

# Or test directly with -e without installation
pi -e ./src/index.ts --model agy-pool/gemini-3.8-flash -p "Reply with OK"
```

---

## Usage

Select any registered model using the `agy-pool/` provider prefix:

```bash
# Non-interactive generation
pi --model agy-pool/gemini-3.8-flash -p "Explain quantum computing in one sentence."

# Interactive chat session
pi --model agy-pool/gemini-3.8-flash
```

### Thinking Level Selection

`pi-agy-pool` supports Pi's thinking level controls, mapping them directly to official AGY's `--effort` flag:

```bash
# Via --thinking flag
pi --model agy-pool/gemini-3.8-flash --thinking low -p "Explain quantum computing"
pi --model agy-pool/gemini-3.8-flash --thinking high -p "Write an optimal sorting algorithm"

# Via model pattern suffix shorthand
pi --model agy-pool/gemini-3.8-flash:high -p "Plan migration strategy"
pi --model agy-pool/gemini-3.1-pro:low -p "Summarize diff"
```

---

## Supported Models & Thinking Capability Matrix

`pi-agy-pool` exposes the 7 canonical models matching native Antigravity:

| Model ID | Display Name | Thinking (`pi --list-models`) | Supported Effort | AGY `--effort` Mapping |
| :--- | :--- | :--- | :--- | :--- |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `yes` | `low`, `medium`, `high` | `--effort low\|medium\|high` (default: `medium`) |
| `gemini-3.7-flash` | Gemini 3.7 Flash | `yes` | `low`, `medium`, `high` | `--effort low\|medium\|high` (default: `medium`) |
| `gemini-3.6-flash` | Gemini 3.6 Flash | `yes` | `low`, `medium`, `high` | `--effort low\|medium\|high` (default: `medium`) |
| `gemini-3.1-pro` | Gemini 3.1 Pro | `yes` | `low`, `high` | `--effort low\|high` (default: `high`) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | `no` | native thinking | Omitted (do NOT pass `--effort`) |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | `no` | native thinking | Omitted (do NOT pass `--effort`) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | `no` | N/A | Omitted (do NOT pass `--effort`) |

---

## Permission Mode & Autonomous Execution Notice

> **Security Notice:** `pi-agy-pool` launches official Antigravity headless using the `--dangerously-skip-permissions` and `--disable-slash-commands` flags.
>
> **Why:** The official Antigravity headless stream-json protocol currently does not support interactive stdin confirmation prompts for tool approvals. Passing `--dangerously-skip-permissions` is necessary to prevent headless subprocess execution from hanging on tool execution.
>
> **Operational Implications:** Headless AGY operates autonomously and may execute tools (including reading and editing files or executing shell commands) without prompting the user for approval. Do not execute untrusted prompts in sensitive environments.

---

## Configuration

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `AGY_POOL_BIN` | Path or command name for the `agy-pool` CLI | `agy-pool` |
| `AGY_POOL_EFFORT` | Reasoning effort fallback below explicit Pi reasoning (`low`, `medium`, `high`) | Model-specific native default |

---

## Lifecycle, Concurrency & Process Isolation

- **Process Ownership:** Each Pi conversation owns a dedicated AGY child process.
- **Session Continuity:** Normal turns continue within the same in-memory ownership lifetime. Pi/extension restart or ownership loss starts a fresh AGY conversation from Pi's current projection; historical conversation IDs never authorize resume.
- **Context Continuity:** Bootstrap is established only after successful native input submission. After a successful turn, a canonical projection checkpoint permits latest-only continuation only for unchanged history plus the next user request. System/history edits or injected context require fresh bootstrap from Pi's current projection.
- **Model / Effort Switching:** Proven idle ownership and an unchanged projection permit child replacement with `--conversation <id>`. Busy, ambiguous or stale context requires fresh bootstrap. The same rule applies to cwd/environment replacement.
- **Cleanup:** Request AbortSignal, Pi `session_shutdown` and extension reload own cleanup. No process-global signal/exit hooks are installed; abrupt host termination is not a graceful-cleanup guarantee.
- **Telemetry Boundary:** Official AGY executes tools and subagents autonomously. Telemetry events are never translated into Pi tool calls, preventing double execution.

---

## Development & Testing

Run offline tests using Node.js built-in test runner:

```bash
# Run TypeScript typecheck
npm run typecheck

# Run offline unit and integration tests
npm test

# Check distribution package contents
npm pack --dry-run --json
```

Pi compatibility is monitored separately against minimum and latest upstream Pi
using real Pi runtimes with controlled AGY transport. Native Pi → AGY →
agy-pool → Google acceptance remains a separate release-smoke concern.

---

## Releases

All production releases and package artifacts are built, verified, and published automatically to GitHub Releases by GitHub Actions from version tags (`v*`).

1. **Tag Trigger:** Pushing a release tag (e.g. `v0.3.1`) triggers the automated `.github/workflows/release.yml` workflow.
2. **Quality Gates:** GitHub Actions runs typechecking, offline tests, and verifies that the git tag strictly matches `"version"` in `package.json`.
3. **Artifact Generation & Inspection:** The workflow runs `npm pack` and inspects the resulting distribution tarball (`pi-agy-pool-X.Y.Z.tgz`) to verify it contains only approved runtime files.
4. **GitHub Release Publication:** The workflow creates the GitHub Release for the tag and attaches `pi-agy-pool-X.Y.Z.tgz` as a release asset. No packages are published to the public npm registry, and local or manual releases are strictly forbidden.

---

## Host integration (Pi 0.87.1+)

Native children use the matching Pi session's `ctx.cwd`, including workspace
switch/override. A changed cwd or provider environment replaces the child;
only proven idle in-memory ownership permits native conversation resume.
Direct API callers may supply `cwd`; without a Pi binding or explicit cwd,
the current host working directory is used. Provider `env` overrides inherit
and override the host environment and require replacement when changed.

AGY may have executed autonomous tools before reporting a failure. Pi 0.87.1
has no provider-specific non-retryable error flag, so this adapter ends failed
requests with the non-retrying `aborted` stop reason and
`rawStopReason: agy_execution_failed`, retaining a diagnostic. This deliberately
stops automatic error/overflow recovery, even for pre-submission failures.
Native MAX_TOKENS also stops for manual review rather than Pi length recovery.
Review effects before manually trying again. No global Pi retry setting is
changed; account scheduling/failover remains exclusively in agy-pool-go.

Cleanup belongs to request AbortSignal (Escape in interactive Pi), session
shutdown and extension reload. The extension installs no host signal handlers.
Abrupt host termination is not a graceful-cleanup guarantee. `onPayload` is
awaited before submission; HTTP-only `onResponse` is not invoked for subprocesses.

Diagnostics redact common credential headers, token/key query fields and known
key formats, then cap display at 4096 UTF-16 code units. Stderr retains only a
bounded tail beginning at a complete line; oversized lines are discarded.
This is best-effort redaction, not recognition of every possible secret format.
The NDJSON record limit is 4,194,304 UTF-16 code units, not 4 MB of UTF-8 bytes.

Usage records are snapshots. A terminal record replaces all prior counters,
including on an error result; abort retains the last observed snapshot. Native
input/output/cache-read values map directly to Pi's corresponding fields;
thinking is reported as the reasoning breakdown, never added again to output.
A valid native total is authoritative even if it differs from category sums;
when absent, total is input + output + cacheRead. No billing/cost is inferred.

Ordinary session records and retired/valid conversation IDs currently remain in
memory until the host exits, including retained system prompts. This process-wide
metadata accumulation is a known non-blocking limitation for long-lived hosts;
child processes and request resources are still released on shutdown.

## License

[MIT](LICENSE) © 2026 vlxlv
