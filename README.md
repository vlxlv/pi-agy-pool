# pi-agy-pool

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

- **Pi CLI** (`pi`) installed and available in `PATH` (`>=0.80.0`).
- **`agy-pool`** binary installed and available in `PATH` (or configured via `AGY_POOL_BIN`).
- A running **`agy-pool-go`** daemon.
- Official **Antigravity** installed and managed by `agy-pool`.

### Live progress

In Pi's interactive TUI, AGY activity appears in one `agy-pool` footer status.
Tool and subagent telemetry is informational: official AGY executes the tools;
Pi never executes them again. Pi's native working indicator is left unchanged.

Each request owns its progress within the matching Pi session. If requests overlap,
the newest request owns the status until it finishes, then any remaining request's
status is restored. Short operations retain a completed-action label until the next
activity or assistant text; execution is never delayed to keep a label on screen.
Text and terminal completion clear the status. A later tool makes it visible again.

Only fixed tool descriptions and recognized role labels are displayed; unknown
names use generic labels. Arguments, paths, output and prompts are not displayed.
Print, JSON and RPC modes receive no progress UI updates. The lifecycle/rendering
integration is tested against Pi 0.87.1.

---

## Installation

Download the release `.tgz` artifact from [GitHub Releases](https://github.com/vlxlv/pi-agy-pool/releases) and install it using Pi:

```bash
# Install from downloaded release tarball
pi install /path/to/pi-agy-pool-X.Y.Z.tgz
```

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

# Update package by reinstalling new release tarball
pi install /path/to/pi-agy-pool-X.Y.Z.tgz

# Uninstall package
pi remove pi-agy-pool
```

### Development & Debugging

During local development or debugging, you can install directly from a local checkout or run uninstalled source with the `-e` flag:

```bash
# Install from local source checkout
pi install ./path/to/pi-agy-pool

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
| `AGY_POOL_EFFORT` | Reasoning effort override (`low`, `medium`, `high`) | Model-specific native default |

---

## Lifecycle, Concurrency & Process Isolation

- **Process Ownership:** Each Pi conversation owns a dedicated AGY child process.
- **Session Continuity:** Captures AGY's `init.conversation_id` and transparently resumes across turns or process restarts using `--conversation <id>`.
- **Model / Effort Switching:** If a session changes model or effort between turns, the mismatched process is cleanly terminated and a new process is spawned with `--conversation <id>`, preserving conversation history with the new model configuration.
- **Signal Ownership:** Cleans up active child processes on Pi `session_shutdown` and process exit without hijacking host signal semantics (does not unconditionally exit on Ctrl+C).
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

---

## Releases

All production releases and package artifacts are built, verified, and published automatically to GitHub Releases by GitHub Actions from version tags (`v*`).

1. **Tag Trigger:** Pushing a release tag (e.g. `v0.3.1`) triggers the automated `.github/workflows/release.yml` workflow.
2. **Quality Gates:** GitHub Actions runs typechecking, offline tests, and verifies that the git tag strictly matches `"version"` in `package.json`.
3. **Artifact Generation & Inspection:** The workflow runs `npm pack` and inspects the resulting distribution tarball (`pi-agy-pool-X.Y.Z.tgz`) to verify it contains only approved runtime files.
4. **GitHub Release Publication:** The workflow creates the GitHub Release for the tag and attaches `pi-agy-pool-X.Y.Z.tgz` as a release asset. No packages are published to the public npm registry, and local or manual releases are strictly forbidden.

---

## License

[MIT](LICENSE) © 2026 vlxlv
