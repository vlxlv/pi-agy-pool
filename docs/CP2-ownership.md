# CP2 ownership design

Pi sessionId is the routing identity. A session ownership record owns its current process, native conversation ID and last successful checkpoint. The process registry additionally retains retiring children until exit; a conversation index is diagnostic, never routing authority.

Pi provider/API fields establish provider provenance. Successful assistant messages additionally carry agyPoolOwner { sessionId, checkpoint }. responseId remains the mutable native conversation ID, not the checkpoint. The checkpoint is an adapter receipt, not an AGY protocol correlation ID.

A registered provider may authorize restart resume only when the latest relevant assistant receipt in the current projection matches the latest receipt in the real SessionManager entries and belongs to the same session/provider/API. A fork changes sessionId, so both tip and older forks bootstrap fresh. Tree navigation retires ownership. Historical IDs alone, legacy messages without receipts, and direct calls without a session ID bootstrap conservatively. Concurrent calls for one session reserve the same record before yielding.

Pi 0.87.1 AgentSessionRuntime calls cancellable before-switch/fork hooks before teardown; successful replacement aborts then emits session_shutdown and creates a new runner/session_start. Fork creates a new sessionId; navigateTree updates projection before session_tree. Cleanup belongs to the outgoing session, never the last globally active session. Reload releases its process and uses persisted receipts for safe reattachment.

Known bootstrap system prompt sections, branch-summary text, toolResult fidelity and role serialization remain CP3. This change does not alter the CP1 turn queue or native protocol.

## Ownership and lifetime

```text
real AgentSession / ExtensionRunner token
  -> explicit options.sessionId
  -> SessionOwnership (process, native ID, successful receipt, bootstrap flag)
  -> AgyProcess

historical responseId + provider/API + same-session tip receipt
  -> candidate for a NEW process only
```

The runner token is captured in each spawned-child registration. Shutdown aborts its own requests and awaits all of its children, including those still initializing or retiring. Late invalidation/init/exit callbacks change session state only while that exact process remains its owner. A second runner opening the same session file cannot borrow the first runner's live process.

Requests not bound to the runner's actual session (including Pi's separately identified compaction helper requests), and direct callers without a session ID, use independent ephemeral ownership and terminate after completion. They do not mint resumable receipts. Explicit-ID direct callers can reuse only their own in-memory ownership; historical resume additionally requires an explicitly verified receipt. Legacy pre-CP2 messages have no receipt, so the first continuation bootstraps once, then resumes normal persistent reuse.

Successful idle shutdown/reload preserves the receipt for a new process. Active failure/cancellation invalidates the native checkpoint. Idle model/effort replacement preserves the same owned native conversation and waits for the old child's exit before writing. Busy replacement retires the native conversation: interrupted work may have advanced beyond Pi's completed projection. A pending caller count is only a checkpoint-invalidation guard, never a scheduler; the unchanged CP1 FIFO is the only turn scheduler.

Tree changes invalidate immediately. Across restart, a projection receipt must also equal the chronologically latest successful provider receipt in the full persisted tree. This rejects an older/sibling projection with native future history. Pi's bare in-memory leaf navigation is not itself persisted; the integration test persists a custom entry at the selected leaf before reopening, using Pi's own SessionManager implementation.

Existing compaction detection and its retired/post-compaction indexes remain unchanged in meaning. They are not live-process routing authorities. CP2 does not repair false-positive compaction detection or bootstrap contents.
