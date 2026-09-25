import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  type AgyEvent,
  type AgyInitEvent,
  type AgyResultEvent,
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
  maxRecordSize?: number;
}

interface Turn {
  prompt: string | Promise<string>;
  onEvent: (event: AgyEvent) => void;
  resolve: (result: AgyResultEvent) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  started: boolean;
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
  private readonly decoder: AgyEventDecoder;

  conversationId?: string;
  sessionId?: string;

  private _isAlive = true;
  private _isAborted = false;
  private stderrTail = "";
  private readonly turns: Turn[] = [];
  private failure?: Error;
  private exited = false;
  private termination?: Promise<void>;
  private terminationResolve!: () => void;
  private escalation?: NodeJS.Timeout;
  readonly closed: Promise<void> = new Promise(resolve => { this.terminationResolve = resolve; });
  init?: AgyInitEvent;

  readonly ready: Promise<AgyInitEvent>;
  private readyResolve!: (value: AgyInitEvent) => void;
  private readyReject!: (reason: Error) => void;

  constructor(options: AgyProcessOptions) {
    super();
    this.modelId = options.modelId;
    this.effort = options.effort;
    this.conversationId = options.conversationId;
    this.decoder = new AgyEventDecoder(options.maxRecordSize);

    // Prevent Node unhandled error crash when listeners are registered/detached per turn
    this.on("error", () => {});

    this.ready = new Promise<AgyInitEvent>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Readiness can fail before any caller attaches (for example during onPayload).
    void this.ready.catch(() => {});

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

  get pid(): number | undefined {
    return this.child.pid;
  }

  isBusy(): boolean {
    return this.turns.length > 0;
  }

  isAborted(): boolean {
    return this._isAborted;
  }

  private setupChildHandlers(): void {
    const fatal = (error: Error) => {
      this.invalidate(error);
      void this.terminate("SIGINT");
    };
    this.child.stdin?.on("error", fatal);
    this.child.stdout?.on("error", fatal);
    this.child.stderr?.on("error", fatal);
    this.child.stdout?.on("data", (chunk: Buffer) => {
      if (!this.isAlive()) return;
      try {
        for (const event of this.decoder.feed(chunk)) this.handleEvent(event);
      } catch (error) {
        fatal(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stdout?.on("end", () => {
      if (!this.isAlive()) return;
      try {
        for (const event of this.decoder.flush()) this.handleEvent(event);
      } catch (error) {
        fatal(error instanceof Error ? error : new Error(String(error)));
      }
      fatal(new Error("AGY stdout ended before process completion"));
    });
    this.child.stdout?.once("close", () => {
      if (this.isAlive()) fatal(new Error("AGY stdout closed"));
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    this.child.on("error", (error: Error) => {
      this.invalidate(error);
      // Failed spawn has no PID and will never emit exit; close is also observed.
      if (this.child.pid === undefined) this.didExit();
      else void this.terminate("SIGINT");
    });
    this.child.once("exit", (code: number | null, signal: string | null) => {
      const detail = this.stderrTail.trim();
      this.didExit();
      this.invalidate(new Error(`AGY process exited with code ${code}${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`));
      this.emit("exit", code, signal);
    });
    this.child.once("close", () => {
      this.didExit();
      this.invalidate(new Error("AGY process closed"));
    });
  }

  private didExit(): void {
    this.exited = true;
    if (this.escalation) clearTimeout(this.escalation);
    this.terminationResolve();
  }

  private invalidate(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this._isAlive = false;
    this.readyReject(error);
    for (const turn of this.turns.splice(0)) {
      turn.cleanup();
      turn.reject(error);
    }
    this.emit("invalidated");
    this.emit("error", error);
  }

  private handleEvent(event: AgyEvent): void {
    if (!this.isAlive()) return;
    if (event.event === "init" && !this.init) {
      this.init = event as AgyInitEvent;
      this.conversationId = this.init.conversation_id || this.conversationId;
      this.sessionId = this.init.session_id;
      this.readyResolve(this.init);
      this.emit("init", this.init);
    }
    // Capture the head once: callbacks/results may enqueue more work.
    const turn = this.turns[0];
    if (turn?.started) {
      try {
        turn.onEvent(event);
      } catch (error) {
        this.invalidate(error instanceof Error ? error : new Error(String(error)));
        void this.terminate("SIGINT");
        return;
      }
      if (event.event === "result" && this.turns[0] === turn) {
        const result = event as AgyResultEvent;
        this.turns.shift();
        turn.cleanup();
        if ((result.status || result.result?.status) === "ERROR") {
          turn.reject(new Error(result.error || result.result?.error || "AGY generation failed"));
          this.invalidate(new Error("AGY generation failed"));
          void this.terminate("SIGINT");
        } else turn.resolve(result);
        // Do not hand this native result (or remaining events in its chunk) to B.
        queueMicrotask(() => this.startHead());
      }
    }
    if (event.event === "step_update" || event.event === "result") this.emit(event.event, event);
    this.emit("event", event);
  }

  /** The array is the FIFO authority; only its started head can write/settle. */
  runTurn(prompt: string | Promise<string>, onEvent: (event: AgyEvent) => void, signal?: AbortSignal): Promise<AgyResultEvent> {
    // A queued payload may reject before reaching the head.
    if (typeof prompt !== "string") void prompt.catch(() => {});
    if (signal?.aborted) return Promise.reject(new Error("Request was aborted"));
    if (!this.isAlive()) return Promise.reject(this.failure || new Error("AGY process is not alive"));
    return new Promise((resolve, reject) => {
      const turn: Turn = { prompt, onEvent, resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel), started: false };
      const cancel = () => {
        if (this.turns[0] === turn && turn.started) {
          void this.abort();
        } else {
          const index = this.turns.indexOf(turn);
          if (index < 0) return;
          this.turns.splice(index, 1);
          turn.cleanup();
          reject(new Error("Request was aborted"));
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.turns.push(turn);
      this.startHead();
    });
  }

  private startHead(): void {
    const turn = this.turns[0];
    if (!turn || turn.started || !this.isAlive()) return;
    turn.started = true;
    void Promise.all([this.ready, turn.prompt]).then(([, prompt]) => {
      if (this.turns[0] !== turn || !this.isAlive()) return;
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("AGY process stdin is not writable");
      stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", error => {
        if (error) {
          this.invalidate(error);
          void this.terminate("SIGINT");
        }
      });
    }).catch(error => {
      if (this.turns[0] !== turn) return;
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
      void this.terminate("SIGINT");
    });
  }

  private terminate(signal: NodeJS.Signals): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = this.closed;
    if (!this.exited) {
      // Install escalation before kill: test children and fast exits can be synchronous.
      this.escalation = setTimeout(() => {
        if (!this.exited) {
          try { this.child.kill("SIGKILL"); } catch { /* Still wait for definitive exit/close. */ }
        }
      }, 3000);
      this.escalation.unref();
      try { this.child.kill(signal); } catch { /* close/exit remains authoritative. */ }
    }
    return this.termination;
  }

  abort(): Promise<void> {
    this._isAborted = true;
    this.invalidate(new Error("Request was aborted"));
    return this.terminate("SIGINT");
  }

  kill(): Promise<void> {
    this.invalidate(new Error("AGY process was retired"));
    return this.terminate("SIGTERM");
  }
}
