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

---

## Installation

Install `pi-agy-pool` as a standard Pi package:

```bash
# Install from npm
pi install npm:pi-agy-pool

# Or install from a local checkout / tarball
pi install ./path/to/pi-agy-pool
```

Verify that Pi has automatically discovered the extension and registered the models:

```bash
pi --list-models agy
```

Output will show the registered `agy-pool` model family:

```text
provider  model                     context  max-out  thinking  images
agy-pool  gemini-3.8-flash          1.0M     65.5K    no        no
agy-pool  gemini-3.7-flash          1.0M     65.5K    no        no
agy-pool  gemini-3.6-flash          1.0M     65.5K    no        no
agy-pool  gemini-3.1-pro            1.0M     65.5K    no        no
agy-pool  claude-sonnet-4-6         250K     64K      no        no
agy-pool  claude-opus-4-6-thinking  250K     64K      no        no
agy-pool  gpt-oss-120b-medium       131.1K   32.8K    no        no
```

### Updating and Uninstalling

```bash
# List installed packages
pi list

# Update package
pi update

# Uninstall package
pi remove npm:pi-agy-pool
```

### Development & Debugging

During local development or debugging, you can still test uninstalled source directly with the `-e` flag:

```bash
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

---

## Supported Models (Native Switch Model Parity)

`pi-agy-pool` exposes the 7 canonical models matching native Antigravity:

| Model ID | Display Name | Native AGY Family | Context Window | Max Output | Effort Support |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gemini-3.8-flash` | Gemini 3.8 Flash | Google Gemini | 1,048,576 | 65,536 | low, medium (default), high |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Google Gemini | 1,048,576 | 65,536 | low, medium (default), high |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Google Gemini | 1,048,576 | 65,536 | low, medium (default), high |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Google Gemini | 1,048,576 | 65,535 | low, high (default) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | Anthropic (Vertex) | 250,000 | 64,000 | native thinking (omits --effort) |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | Anthropic (Vertex) | 250,000 | 64,000 | native thinking (omits --effort) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | OpenAI (Vertex) | 131,072 | 32,768 | optional (medium) |

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

## License

[MIT](LICENSE) © 2026 vlxlv
