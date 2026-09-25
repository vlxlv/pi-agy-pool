# CP3 projected context boundary

Pi 0.87.1 is the source of truth, not the full session tree or historical AGY IDs.

- `core/system-prompt.js:buildSystemPromptState` normally supplies an empty
  system content plus sections (preamble, project files including AGENTS.md,
  skills, cwd and extension instructions). `pi-ai` public
  `getCurrentSystemPrompt` replays section patches and removals, then renders
  them. Independent opaque contributions remain exactly as Pi renders them.
- `pi-ai:normalizeContext` folds legacy systemPrompt into transcript messages.
- `core/session-manager.js:buildSessionProjection` selects the current branch,
  applies context edits, excludes compacted history, and retains recent items.
- `core/messages.js:convertToLlm` preserves system/user/assistant/toolResult;
  it converts compaction and branch summaries into user text. The former
  replaces a removed prefix; the latter follows retained target history.
  The provider must not infer either operation from a phrase in user content.

Every fresh AGY bootstrap serializes the current projection, without additional
truncation or reading outside that projection. One instruction line precedes
one JSON array with explicit roles and escaped content. The latest request is
already in the array and is not appended again. System state is folded to one
record. Historical tool calls/results are data, never executable Pi events.
Only semantic content, tool names/arguments and result error status are copied;
Pi IDs, signatures, ownership, usage and timestamps are excluded. No native
role-array API is invented: the array remains text inside the supported AGY
stdin user event. Framing improves semantic separation; it is not a sandbox
or a claim of native model compliance established by offline tests. The model
catalog remains text-only; this checkpoint adds no native multimodal support.

Pi can update system sections before a request (`_preparePromptAndToolLoadout`)
or project a forced prompt. A changed rendered system state uses the existing
retirement/fresh-bootstrap boundary, since AGY has no adapter system-patch
channel. Stable state keeps normal persistent continuation. No FIFO, native
submission, progress or session routing mechanism changes.

Tests use actual Pi system/projection, fork/tree, persistence/restart and
compaction machinery, with fake AGY subprocesses and inspected stdin. Native
AGY testing is intentionally not performed in WSL.

## CP3.2 occurrence references and authoritative system state

Pi 0.87.1 `pi-ai/api/transform-messages.js` tracks pending calls in the current
assistant batch. An assistant or user message closes the previous batch;
system messages are transparent. The agent loop emits results for each batch,
but projection edits can remove arbitrary calls/results. Raw IDs are not
transcript-global identities.

Each retained call occurrence receives a new bootstrap-global `call_N` ref.
Results match only a unique raw ID in the current retained assistant batch.
Repeated IDs within that batch, missing calls, and results after a user boundary
are ambiguous: each receives a separate ref and `orphaned: true`. Calls in later
batches cannot capture earlier results. Failed/aborted assistant batches cannot
establish result associations. Nothing synthesizes results or executes records.

System state is exactly `getCurrentSystemPrompt(normalizeContext(context).messages)`.
The public normalizer also covers direct/legacy callers with `systemPrompt`:
Pi prepends that contribution; it does not establish an alias. No timestamp,
text equality, or filtered-position heuristic removes content. If Pi renders
BASE twice, bootstrap preserves both copies. The full ordered projection is
passed to Pi, including conversational boundaries. This same function drives
bootstrap and system-change retirement; equivalent rendered strings reuse the
process, changed strings force fresh bootstrap. There is no second system path.
