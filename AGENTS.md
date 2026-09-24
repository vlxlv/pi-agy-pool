# AGENTS.md — Architecture & Implementation Guardrails

This document defines mandatory architecture and implementation constraints for all coding agents working in the `pi-agy-pool` repository.

It is an architectural contract, not a roadmap or historical summary. Every change in this repository must comply with the rules below.

---

## 1. Project Purpose & Execution Chain

`pi-agy-pool` is a Pi model-provider integration for the existing `agy-pool-go` multi-account system.

The required execution chain is:

```text
Pi
 ↓
pi-agy-pool
 ↓
agy-pool run -- <official AGY headless arguments>
 ↓
official agy-native
 ↓
CLOUD_CODE_URL configured by agy-pool-go
 ↓
agy-pool-go local gateway
 ↓
existing multi-account scheduler / OAuth / quota / failover
 ↓
Google
```

This execution chain is mandatory.

---

## 2. Core Ownership Boundaries

### `pi-agy-pool` owns (Only):
- Pi provider registration
- Pi ↔ official AGY machine-interface adaptation
- Official AGY subprocess lifecycle
- Structured stdin/stdout parsing
- Pi stream event mapping
- Pi session/process isolation
- Cancellation and cleanup
- Model and effort selection through official AGY CLI arguments

### `agy-pool-go` owns (Exclusively):
- Account inventory
- Account selection
- Multi-account scheduling
- OAuth / token handling
- CLI Base identity synchronization
- Quota tracking and quota refresh
- Cooldowns
- 429 / 403 failover
- Restricted-account handling
- Gateway lifecycle
- `CLOUD_CODE_URL` setup
- No-replay transport guarantees
- Routing observability
- Conversation continuation helpers already implemented in agy-pool-go
- Native AGY discovery

Do not duplicate `agy-pool-go` responsibilities in `pi-agy-pool`.

---

## 3. Official AGY Boundary

`pi-agy-pool` **MUST** invoke official Antigravity through:

```bash
agy-pool run -- <native arguments>
```

It **MUST NOT** invoke:
- `agy-native`
- `agy-raw`
- `agy-orig`

directly.

`agy-pool run` performs the required multi-account integration setup, configuration injection, and `CLOUD_CODE_URL` routing before executing native AGY.

---

## 4. Machine Interface

The intended Pi ↔ AGY boundary is the official Antigravity headless structured interface.

Use the installed AGY's supported:
- `stream-json` / structured stdin/stdout
- Model selection (`--model`)
- Effort selection (`--effort`)

interfaces after verifying their exact installed syntax.

Do not invent a private protocol when an official AGY machine interface exists.

---

## 5. Forbidden Direct Cloud Code Transport

Production `pi-agy-pool` code **MUST NOT** directly call:
- `127.0.0.1:8899`
- `/v1internal:streamGenerateContent`
- `/v1internal:fetchAvailableModels`
- `daily-cloudcode-pa.googleapis.com`

The extension must not be a Cloud Code PA client. All Google-facing protocol generation must be performed by official AGY.

---

## 6. Forbidden Protocol Reimplementation

Do **NOT** implement or maintain production logic for:
- Cloud Code PA request JSON encoding
- Cloud Code PA SSE decoding
- Cloud Code wire-model aliases
- Cloud Code model enum mappings
- `requestId` generation
- Trajectory IDs
- Cloud Code labels
- `thinkingBudget`
- `thinkingConfig`
- `thoughtSignature`
- `functionCall` Cloud Code serialization
- `functionResponse` Cloud Code serialization
- Antigravity HTTP User-Agent spoofing
- Google OAuth header injection

These are implementation details owned by official AGY and/or `agy-pool-go`.

---

## 7. Legacy V0.1.x Warning

The repository's early V0.1.x implementation directly constructed Cloud Code PA requests and sent them to the `agy-pool-go` gateway.

That architecture is **obsolete**.

Files or code associated with:
- `request.ts` Cloud Code encoding
- `sse.ts` Cloud Code SSE parsing
- `fetch(:8899)`
- Wire-model mapping
- Cloud Code User-Agent handling

must **NOT** be treated as the desired architecture.

During the official-AGY transport migration, remove obsolete production paths once their replacements are verified. Do not extend or enhance the legacy direct transport.

---

## 8. Model Handling

The user-facing model abstraction should follow official/native AGY semantics.

- Do not derive the Pi picker directly from raw Cloud Code PA wire model IDs.
- Do not manually translate Gemini family → Cloud Code internal model ID.
- Do not manually translate effort → `thinkingBudget`.

Official AGY performs these translations internally. Pass model and effort through official AGY's supported CLI / machine interface.

---

## 9. Multi-Account Invariant

There must be exactly one multi-account authority: **`agy-pool-go`**.

Never create:
- Pi-side `AccountPool`
- TypeScript account rotation
- Extension-side OAuth management
- Extension-side quota scheduler
- Extension-side failover across Google accounts

A Pi request must rely on `agy-pool-go` for all account routing.

---

## 10. Retry Invariant

`pi-agy-pool` must not replay a generation against another account.

Account failover and no-replay decisions belong to `agy-pool-go`. Do not add extension-level retries around model generation unless a future explicit design changes this invariant.

---

## 11. Process Safety

When invoking `agy-pool`:
- Use argument-array process spawning (`child_process.spawn("agy-pool", ["run", "--", ...])`).
- Do not construct shell command strings.
- Do not use `shell: true` for normal execution.
- Prompts, cwd paths, model IDs, and other user-controlled values must not be shell-interpolated.

---

## 12. Session Isolation

Never allow unrelated Pi sessions to share conversational state accidentally.

- Persistent AGY processes may only be reused when session ownership is unambiguous.
- If Pi does not expose sufficient session identity, prefer less process reuse over cross-session contamination.
- Correctness and isolation take priority over startup latency.

---

## 13. Structured Output

- Machine-readable AGY stdout is protocol data.
- Diagnostics belong on stderr.
- Do not mix stderr into the structured stdout parser.
- The parser must tolerate arbitrary byte/chunk boundaries and malformed individual records without corrupting unrelated subsequent records.

---

## 14. Cancellation and Cleanup

- Pi cancellation must propagate to the AGY execution safely.
- Any process that becomes invalid after cancellation must not be returned to a reusable process cache.
- All child processes owned by the extension must be terminated on Pi/session shutdown.
- Do not leave orphan AGY or `agy-pool` child processes.

---

## 15. agy-pool-go Repository Boundary

Do not modify `~/work/agy-pool-go` from tasks scoped to `pi-agy-pool` unless the user explicitly authorizes a cross-repository change. Treat `agy-pool-go` as an external dependency with an existing stable architecture.

---

## 16. Testing Requirements

- Tests must be offline by default.
- Use injectable/fake process transports for unit tests.
- Do not require Google credentials for `npm test` or `npm run typecheck`.
- Real Google/AGY calls belong only in explicitly requested E2E smoke verification.

---

## 17. Required Verification Before Commit

At minimum:
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `git status --short`

For transport changes, also verify there is no active production direct-Cloud-Code path by searching for obsolete production patterns:
- `streamGenerateContent`
- `fetchAvailableModels`
- `127.0.0.1:8899`
- `CLOUD_CODE_URL`
- `thinkingBudget`
- `thoughtSignature`

Occurrences in historical documentation/tests may be acceptable only when intentional.

---

## 18. Git Safety

- Never use destructive cleanup merely to make the tree clean.
- Do not use `git reset --hard` or `git clean -fd` unless explicitly instructed.
- If the working tree contains unexpected pre-existing modifications, STOP and report them.
- Do not overwrite unrelated work.

---

## 19. Scope Discipline

- Follow the requested milestone exactly.
- Do not automatically begin the next version or feature after completing the current task.
- Do not turn a focused transport task into MCP work, dashboard work, new account management, new scheduler, unrelated refactoring, model discovery, or release automation unless explicitly requested.

---

## 20. Stop Conditions

STOP and report rather than improvising when:
- Repository baseline is unexpectedly dirty.
- Installed AGY lacks a required documented machine interface.
- Official AGY behavior contradicts the expected protocol.
- Persistent sessions cannot be isolated safely.
- Implementing a task would require bypassing `agy-pool run`.
- Implementing a task would require direct Google OAuth access.
- Implementing a task would require changing `agy-pool-go`.
- The requested architecture conflicts with this file.

Do not silently substitute another architecture.

---

## 21. Guiding Rule

When choosing between:
- Reimplementing Antigravity behavior in `pi-agy-pool`, and
- Delegating that behavior to official AGY through `agy-pool run`,
**choose the official AGY path.**

When choosing between:
- Implementing account behavior in `pi-agy-pool`, and
- Delegating it to `agy-pool-go`,
**choose `agy-pool-go`.**

---

## 22. Release & Publishing Invariants

- **Automated Production Releases Only:** All production releases are created exclusively through GitHub Actions.
- **Tag-Driven:** Production releases are triggered solely by git version tags matching `v*`. Never publish from development branches, pull requests, or unversioned commits.
- **GitHub Release Distribution:** Release artifacts are distributed through GitHub Releases as an npm-compatible `.tgz` package produced by `npm pack`. No npm registry publication.
- **No Local/Manual Releases:** Creating manual releases or publishing locally is strictly forbidden.
- **Exact Version Match:** The release git tag (e.g. `v0.3.1`) must strictly match `"version"` in `package.json` (e.g. `0.3.1`). Any mismatch must abort the release immediately prior to artifact generation.
- **Pre-Release Verification Gates:** Offline tests (`npm test`), TypeScript verification (`npm run typecheck`), and package tarball content inspection (`npm pack`) must pass in CI/CD before GitHub Release creation. Never bypass failed release gates.
