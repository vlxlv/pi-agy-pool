# pi-agy-pool

`pi-agy-pool` is an official AGY stream-transport model-provider extension for [Pi](https://github.com/earendil-works/pi) that routes model generation through [`agy-pool-go`](https://github.com/vlxlv/agy-pool-go) and official Antigravity headless.

> **Important:** `pi-agy-pool` does **not** manage Google accounts, OAuth tokens, authentication, quota, or failovers. All account management and scheduling belong strictly to `agy-pool-go`.

---

## Architecture

```text
Pi
 ↓
pi-agy-pool (extension)
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

- **Pi CLI** (`pi`) installed and available in `PATH`.
- **`agy-pool`** binary installed and available in `PATH` (or configured via `AGY_POOL_BIN`).
- A running **`agy-pool-go`** daemon.

---

## Installation into Pi

Load `pi-agy-pool` directly when launching Pi:

```bash
pi -e /path/to/pi-agy-pool/src/index.ts
```

Or configure Pi to autoload the extension by adding its directory or entrypoint to your Pi extensions configuration (`~/.pi/agent/extensions` or settings).

To verify the extension is loaded and inspect available models:

```bash
pi -e ./src/index.ts --list-models | grep agy-pool
```

---

## Supported Models (Native Switch Model Parity)

`pi-agy-pool` V0.2 exposes the 7 canonical models matching the native Antigravity Switch Model catalog:

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

## Configuration

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `AGY_POOL_BIN` | Path or command name for the `agy-pool` CLI | `agy-pool` |
| `AGY_POOL_EFFORT` | Reasoning effort override (`low`, `medium`, `high`) | Model-specific native default |

---

## V0.2 Transport Features

- **Official AGY Subprocess Transport:** Spawns `agy-pool run --` with argument arrays (no `shell: true`, safe against command injection).
- **Session Continuity:** Captures `init.conversation_id` from AGY and passes `--conversation <id>` for resilient multi-turn conversation resumption across process restarts.
- **Process Isolation:** One Pi session owns one dedicated AGY child process. Multi-turn interactions run through the same process's `stdin`.
- **Cancellation & Cleanup:** `AbortSignal` immediately sends `SIGINT` to child processes, awaits clean exit, and permanently discards cancelled processes from reuse.
- **Structured NDJSON Output:** Robust incremental parsing of `stream-json` stdout events (`init`, `step_update`, `result`), handling chunk fragmentation and UTF-8 multibyte boundaries. Diagnostics stay on `stderr`.
- **Offline Tests:** 100% offline unit test suite with mock child process transports.

---

## Usage Example

Run a prompt through the registered provider using `gemini-3.8-flash`:

```bash
pi -e ./src/index.ts --model agy-pool/gemini-3.8-flash -p "Reply with exactly: OK"
```

---

## Development & Testing

All unit tests run offline using Node.js built-in test runner; no credentials or live daemons are required for standard checks:

```bash
# Run TypeScript typecheck
npm run typecheck

# Run offline test suite
npm test
```

---

## License

[MIT](LICENSE) © 2026 vlxlv
