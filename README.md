# pi-agy-pool

`pi-agy-pool` is a minimal, lightweight model-provider extension for [Pi](https://github.com/earendil-works/pi) that connects Pi to an upstream [`agy-pool-go`](https://github.com/vlxlv/agy-pool-go) gateway for Cloud Code PA streaming generation.

> **Important:** `pi-agy-pool` does **not** manage Google accounts, OAuth tokens, authentication, quota, or failovers. All account management and authentication belong strictly to `agy-pool-go`.

---

## Architecture

```text
Pi
 ↓
pi-agy-pool (extension)
 ↓ HTTP/SSE (POST /v1internal:streamGenerateContent?alt=sse)
127.0.0.1:8899 (default gateway)
 ↓
agy-pool-go
 ↓
Cloud Code PA
```

---

## Prerequisites

- **Pi CLI** (`pi`) installed and available in `PATH`.
- A running **`agy-pool-go`** daemon listening locally (default: `127.0.0.1:8899`).

---

## Installation into Pi

You can load `pi-agy-pool` directly when launching Pi:

```bash
pi -e /path/to/pi-agy-pool/src/index.ts
```

Or configure Pi to autoload the extension by adding its directory or entrypoint to your Pi extensions configuration (`~/.pi/agent/extensions` or settings).

To verify the extension is loaded and inspect available models:

```bash
pi -e ./src/index.ts --list-models | grep agy-pool
```

---

## Configuration

`pi-agy-pool` defaults to connecting to `127.0.0.1:8899`.

You can override the gateway base URL via the `AGY_POOL_BASE_URL` environment variable:

```bash
export AGY_POOL_BASE_URL="http://127.0.0.1:8899"
```

No Google API keys or credentials should be set in `pi-agy-pool`. Upstream authentication is handled by `agy-pool-go`.

---

## Supported V0.1 Features

- Pi extension loading and provider registration via `pi.registerProvider("agy-pool", ...)`
- Text-only conversations with streaming output
- User and assistant conversation history mapping (`assistant` → `model`, `user` → `user`)
- System prompt mapping (`systemInstruction`)
- Centralized model definitions (`gemini-2.5-flash`, `gemini-2.5-pro`)
- Cloud Code PA request formatting (`/v1internal:streamGenerateContent?alt=sse`)
- Incremental Server-Sent Events (SSE) parsing handling split chunks, CRLF framing, and partial UTF-8 boundaries
- Incremental `text_delta` streaming events
- Token usage metadata reporting (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `thoughtsTokenCount`)
- Direct HTTP error and transport error reporting without retry/failover
- `AbortSignal` cancellation support

---

## Explicit V0.1 Limitations

The V0.1 release is intentionally scoped as a minimal text streaming provider:

- **No tool / function calling:** `functionCall` and `functionResponse` are not implemented.
- **No thought/reasoning UI:** `thought == true` parts and `thoughtSignature` are ignored.
- **No MCP support.**
- **No account / quota management:** Handled entirely by `agy-pool-go`.
- **No automatic model discovery:** Only verified static models are exposed.
- **No native `agy` process spawning.**
- **No retries:** Requests are sent once; failure reporting is immediate and deterministic.

---

## Usage Example

Run a prompt through the registered provider using `gemini-2.5-flash`:

```bash
pi -e ./src/index.ts --model agy-pool/gemini-2.5-flash -p "Reply with exactly: OK"
```

---

## Development & Testing

All tests run offline using Node.js built-in test runner and local mock HTTP servers; no network access or Google credentials are required.

```bash
# Install dependencies
npm install

# Run TypeScript typecheck
npm run typecheck

# Run offline test suite
npm test
```

---

## License

[MIT](LICENSE) © 2026 vlxlv
