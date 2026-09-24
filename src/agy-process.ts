import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  type AgyEvent,
  type AgyInitEvent,
  type AgyResultEvent,
  type AgyStepUpdateEvent,
  AgyEventDecoder,
} from "./agy-events.ts";

export type AgyEffort = "low" | "medium" | "high";

export interface AgyProcessOptions {
  modelId: string;
  effort?: AgyEffort;
  conversationId?: string;
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
}

/**
 * Manages an official AGY headless subprocess through `agy-pool run --`.
 *
 * Process lifecycle:
 * - One Pi session owns one AGY subprocess.
 * - Stdin/stdout communicate via stream-json NDJSON.
 * - Stderr is kept for diagnostics only, never mixed into stdout.
 * - Cancellation sends SIGINT, awaits exit, and invalidates the process.
 */
export class AgyProcess extends EventEmitter {
  readonly modelId: string;
  readonly effort?: AgyEffort;
  private readonly child: ChildProcess;
  private readonly decoder = new AgyEventDecoder();

  conversationId?: string;
  sessionId?: string;

  private _isAlive = true;
  private _isBusy = false;
  private _isAborted = false;
  private stderrTail = "";

  readonly ready: Promise<AgyInitEvent>;
  private readyResolve!: (value: AgyInitEvent) => void;
  private readyReject!: (reason: Error) => void;

  constructor(options: AgyProcessOptions) {
    super();
    this.modelId = options.modelId;
    this.effort = options.effort;
    this.conversationId = options.conversationId;

    // Prevent Node unhandled error crash when listeners are registered/detached per turn
    this.on("error", () => {});

    this.ready = new Promise<AgyInitEvent>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const bin = options.bin || process.env.AGY_POOL_BIN || "agy-pool";
    const args: string[] = [
      "run",
      "--",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      this.modelId,
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
    ];

    if (this.effort) {
      args.push("--effort", this.effort);
    }
    if (this.conversationId) {
      args.push("--conversation", this.conversationId);
    }

    const spawnFn = options.spawnFn || spawn;
    this.child = spawnFn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env ?? process.env,
    });

    this.setupChildHandlers();
  }

  isAlive(): boolean {
    return this._isAlive && !this._isAborted && !this.child.killed;
  }

  isBusy(): boolean {
    return this._isBusy;
  }

  isAborted(): boolean {
    return this._isAborted;
  }

  private setupChildHandlers(): void {
    if (this.child.stdout) {
      this.child.stdout.on("data", (chunk: Buffer) => {
        const events = this.decoder.feed(chunk);
        for (const event of events) {
          this.handleEvent(event);
        }
      });

      this.child.stdout.on("end", () => {
        const events = this.decoder.flush();
        for (const event of events) {
          this.handleEvent(event);
        }
      });
    }

    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk: Buffer) => {
        // Retain the last 4KB of stderr for diagnostic error reporting
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
      });
    }

    this.child.on("error", (err: Error) => {
      this._isAlive = false;
      this._isBusy = false;
      this.readyReject(err);
      this.emit("error", err);
    });

    this.child.on("exit", (code: number | null, signal: string | null) => {
      this._isAlive = false;
      this._isBusy = false;
      if (!this._isAborted && code !== 0 && code !== null) {
        const detail = this.stderrTail.trim();
        const err = new Error(
          `AGY process exited with code ${code}${detail ? `: ${detail}` : ""}`,
        );
        this.readyReject(err);
        this.emit("error", err);
      }
      this.emit("exit", code, signal);
    });
  }

  private handleEvent(event: AgyEvent): void {
    if (event.event === "init") {
      const initEvent = event as AgyInitEvent;
      if (initEvent.conversation_id) {
        this.conversationId = initEvent.conversation_id;
      }
      if (initEvent.session_id) {
        this.sessionId = initEvent.session_id;
      }
      this.readyResolve(initEvent);
      this.emit("init", initEvent);
    } else if (event.event === "step_update") {
      this.emit("step_update", event as AgyStepUpdateEvent);
    } else if (event.event === "result") {
      this._isBusy = false;
      this.emit("result", event as AgyResultEvent);
    }
    this.emit("event", event);
  }

  /**
   * Executes a turn by writing user message JSON to stdin and streaming events.
   */
  runTurn(
    prompt: string,
    onEvent: (event: AgyEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgyResultEvent> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Request was aborted"));
    }

    if (!this.isAlive()) {
      return Promise.reject(new Error("AGY process is not alive"));
    }

    if (this._isBusy) {
      // ponytail: sequential turns per session, parallel turn queueing deferred until pi supports concurrent session turns
      return Promise.reject(new Error("AGY process is busy with another turn"));
    }

    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error("AGY process stdin is not writable"));
    }

    this._isBusy = true;

    return new Promise<AgyResultEvent>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        this.off("event", handleEvent);
        this.off("error", handleError);
        this.off("exit", handleExit);
        signal?.removeEventListener("abort", handleAbort);
      };

      const handleEvent = (event: AgyEvent) => {
        onEvent(event);
        if (event.event === "result") {
          const resEvent = event as AgyResultEvent;
          const status = resEvent.status || resEvent.result?.status;
          const error = resEvent.error || resEvent.result?.error;
          cleanup();
          if (status === "ERROR") {
            reject(new Error(error || "AGY generation failed"));
          } else {
            resolve(resEvent);
          }
        }
      };

      const handleError = (err: Error) => {
        if (!settled) {
          cleanup();
          reject(err);
        }
      };

      const handleExit = (code: number | null) => {
        if (!settled) {
          cleanup();
          if (this._isAborted) {
            reject(new Error("Request was aborted"));
          } else {
            const detail = this.stderrTail.trim();
            reject(
              new Error(
                `AGY process exited prematurely with code ${code}${detail ? `: ${detail}` : ""}`,
              ),
            );
          }
        }
      };

      const handleAbort = async () => {
        if (!settled) {
          cleanup();
          try {
            await this.abort();
          } catch {
            // Ignore abort error
          }
          reject(new Error("Request was aborted"));
        }
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }

      signal?.addEventListener("abort", handleAbort, { once: true });
      this.on("event", handleEvent);
      this.on("error", handleError);
      this.on("exit", handleExit);

      this.ready
        .then(() => {
          if (settled) return;
          const turnMessage = JSON.stringify({
            event: "user",
            message: { content: prompt },
          });
          stdin.write(turnMessage + "\n", (err) => {
            if (err && !settled) {
              cleanup();
              reject(err);
            }
          });
        })
        .catch((err) => {
          if (!settled) {
            cleanup();
            reject(err);
          }
        });
    });
  }

  /**
   * Immediately sends SIGINT to the process and waits for exit.
   * A cancelled process is invalidated and must never be reused.
   */
  async abort(): Promise<void> {
    if (this._isAborted || !this._isAlive) {
      return;
    }
    this._isAborted = true;
    this._isAlive = false;
    this._isBusy = false;

    return new Promise<void>((resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;

      const onExit = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve();
      };

      this.child.once("exit", onExit);

      try {
        this.child.kill("SIGINT");
      } catch {
        onExit();
        return;
      }

      timeoutId = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
      timeoutId.unref?.();
    });
  }

  /**
   * Terminate the process unconditionally (e.g. on shutdown).
   */
  kill(): void {
    this._isAlive = false;
    this._isAborted = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
