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

## Supported Models (V0.1.1 Curated Catalog)

`pi-agy-pool` V0.1.1 provides a curated static model catalog verified against Cloud Code PA via `agy-pool-go`.

### Models Exposed by pi-agy-pool

| Model ID | Display Name | Family | Context Window | Max Output | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | Google Gemini | 1,048,576 | 65,536 | Recommended (Default) |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | Google Gemini | 1,048,576 | 65,536 | Verified |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | Google Gemini | 1,048,576 | 65,536 | Verified |
| `gemini-pro-agent` | Gemini 3.1 Pro (High) | Google Gemini | 1,048,576 | 65,535 | Recommended Pro |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | Google Gemini | 1,048,576 | 65,535 | Verified Pro |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | Google Gemini | 1,048,576 | 65,535 | Verified Utility |
| `gemini-3-flash` | Gemini 3 Flash | Google Gemini | 1,048,576 | 65,536 | Verified Fast |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Anthropic (Vertex) | 250,000 | 64,000 | Verified |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 | Anthropic (Vertex) | 250,000 | 64,000 | Verified |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | OpenAI (Vertex) | 131,072 | 32,768 | Verified |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Google Gemini | 1,048,576 | 65,535 | Legacy Alias |

### Static Catalog vs. Upstream Availability

- **Curated Static Catalog:** V0.1.1 uses a static model catalog in [`src/models.ts`](file:///home/codex/work/pi-agy-pool/src/models.ts). It does not dynamically query upstream on every request.
- **Dynamic Upstream Models:** Cloud Code PA dynamically discovers 27 internal/specialized identifiers via `POST /v1internal:fetchAvailableModels`. Non-generative, internal routing tiers (e.g. `gemini-3.8-flash-tiered`), deprecated entries (e.g. `gemini-3.1-pro-high`), and capacity-exhausted legacy models (e.g. `gemini-2.5-pro`) are intentionally excluded from the active Pi model picker.
- **Pi Custom IDs:** Pi allows passing custom model IDs directly via `--model agy-pool/<MODEL_ID>` if you wish to experiment with unlisted models supported by your upstream backend.

---

## Supported V0.1.1 Features

- Pi extension loading and provider registration via `pi.registerProvider("agy-pool", ...)`
- Updated V0.1.1 curated model catalog matching native Antigravity recommended models
- Text-only conversations with streaming output
- User and assistant conversation history mapping (`assistant` → `model`, `user` → `user`)
- System prompt mapping (`systemInstruction`)
- Centralized model definitions in [`src/models.ts`](file:///home/codex/work/pi-agy-pool/src/models.ts)
- Cloud Code PA request formatting (`/v1internal:streamGenerateContent?alt=sse`)
- Incremental Server-Sent Events (SSE) parsing handling split chunks, CRLF framing, and partial UTF-8 boundaries
- Incremental `text_delta` streaming events
- Token usage metadata reporting (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `thoughtsTokenCount`)
- Direct HTTP error and transport error reporting without retry/failover
- `AbortSignal` cancellation support

---

## Explicit V0.1.1 Limitations

The V0.1.1 release is intentionally scoped as a minimal maintenance update:

- **No tool / function calling:** `functionCall` and `functionResponse` are not implemented.
- **No thought/reasoning UI:** `thought == true` parts and `thoughtSignature` are ignored (V0.1.1 remains text-only).
- **No MCP support.**
- **No account / quota management:** Handled entirely by `agy-pool-go`.
- **No runtime model discovery:** Model catalog is statically curated to keep generation requests fast and deterministic.
- **No native `agy` process spawning.**
- **No retries:** Requests are sent once; failure reporting is immediate and deterministic.

---

## Usage Example

Run a prompt through the registered provider using `gemini-3.6-flash-high`:

```bash
pi -e ./src/index.ts --model agy-pool/gemini-3.6-flash-high -p "Reply with exactly: OK"
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
