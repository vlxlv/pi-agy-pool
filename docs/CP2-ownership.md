# CP2.1 conservative ownership

## Live continuity versus historical provenance

```text
live ExtensionRunner token + explicit Pi sessionId
  -> SessionOwnership (current process, native ID, canResume, bootstrap state)
  -> AgyProcess

persisted assistant provider/API + responseId (+ legacy agyPoolOwner, ignored)
  -> historical provenance only; NEVER native resume authority
```

Only in-memory ownership may supply `--conversation`. Normal same-session turns reuse their healthy process. For a new process to resume X, the same owner must retain X, ownership must not have been retired or released, and `canResume` must establish a successful terminal result with no queued/native turn left unresolved. The flag is revoked when another request starts and restored only by successful completion with an empty FIFO. Process death while any caller is pending invalidates continuity. A preparation-only failure may conservatively forfeit replacement reuse as well.

An idle process exit (including a nonzero exit or signal between completed turns) can preserve this known boundary. Idle model/effort replacement can resume X and waits for the old process to exit before writing. Busy/unresolved replacement bootstraps fresh. The CP1 FIFO and native protocol are unchanged; the pending count is not a scheduler.

## Ownership loss

Clean Pi restart, crash/SIGKILL, reconstructed sessions and extension reload bootstrap a fresh native conversation from the current Pi projection. This also prevents a second Node process opening the same session file from resuming another process's mutable native X. No cross-process lock or transcript hash is needed.

`agyPoolOwner` was removed: provider/API fields already identify historical provider provenance, while the live session record and runner token identify ownership. Old receipt fields are ignored, including copied receipts or receipts attached to a changed responseId. `responseId` remains the historical native conversation identity for Pi/diagnostics; it is not a resume credential. Legacy and CP2 transcripts both bootstrap after ownership loss.

Pi 0.87.1 reload emits shutdown, invalidates the runner and rebuilds extensions. Shutdown revokes all that runner's resume authority, including idle records whose child already exited. A new runner cannot inherit an old record by matching sessionId. There is no ownership transfer on reload or switch.

Both tip and old-point forks bootstrap fresh. Tree changes retire ownership. Successful switches release the outgoing runner; cancelled before-switch/fork hooks retain process ownership. Actual Pi lifecycle hooks, rather than persisted receipt comparisons, establish these branch boundaries. Direct callers with explicit IDs must retain their session lineage and retire it on branch changes; ambiguous/unbound calls use isolated ephemeral ownership.

Process registration captures the runner token. Init/invalidation/exit updates require the exact process owner; shutdown only terminates its own registered children. Ephemeral requests await child termination and remove their session and conversation indexes. The conversation index remains diagnostic, never a routing authority.

## Deferred CP3

Fresh bootstrap still uses the existing serializer. System prompt sections, branch-summary content semantics, toolResult fidelity and role serialization are deliberately unchanged. Compaction detection (including existing false positives), cwd, retries, usage, diagnostics, host signals, model/effort semantics and release/version handling are not redesigned here.
