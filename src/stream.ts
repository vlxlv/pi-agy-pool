import { randomUUID } from "node:crypto";
import { API_IDENTIFIER, DEFAULT_PROVIDER_NAME } from "./models.ts";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type TranscriptContext,
  contentText,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { type AgyEffort, AgyProcess } from "./agy-process.ts";
import type { AgyEvent, AgyStepUpdatePayload } from "./agy-events.ts";
import type { spawn } from "node:child_process";

// Diagnostic conversation index only. Session ownership below is the routing authority.
export const activeProcesses = new Map<string, AgyProcess>();
// Includes starting/retiring children until definitive exit, with explicit owners.
const ownedProcesses = new Map<AgyProcess, { state: SessionOwnership; owner?: symbol }>();

function removeProcessReferences(proc: AgyProcess): void {
  for (const [id, owner] of activeProcesses) if (owner === proc) activeProcesses.delete(id);
}

function trackProcess(proc: AgyProcess, state: SessionOwnership): void {
  ownedProcesses.set(proc, { state, owner: state.owner });
  state.process = proc;
  proc.once("invalidated", () => {
    removeProcessReferences(proc);
    if (state.process === proc) {
      state.process = undefined;
      if (state.pending > 0) {
        state.needsBootstrap = true;
        state.canResume = false;
      }
    }
  });
  void proc.closed.then(() => {
    removeProcessReferences(proc);
    ownedProcesses.delete(proc);
  });
  proc.once("init", () => {
    const id = proc.conversationId;
    if (!id || !proc.isAlive() || state.process !== proc) return;
    activeProcesses.set(id, proc);
    validPostCompactionConversations.add(id);
    state.activeConversationId = id;
    state.needsBootstrap = false;
  });
}

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

export interface SessionOwnership {
  sessionId: string;
  needsBootstrap: boolean;
  activeConversationId?: string;
  retiredConversationIds: Set<string>;
  process?: AgyProcess;
  owner?: symbol;
  // In-flight callers determine whether process death loses a proven idle boundary.
  // Scheduling remains exclusively AgyProcess.runTurn()'s FIFO.
  pending: number;
  // In-memory authority only: a successful terminal result, no unresolved turn.
  // Never reconstructed from responseId or persisted message metadata.
  canResume: boolean;
  provider?: string;
  api?: string;
}

export const sessionStates = new Map<string, SessionOwnership>();
export const retiredConversationIds = new Set<string>();
export const validPostCompactionConversations = new Set<string>();

export function getSessionState(sessionId: string): SessionOwnership {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      needsBootstrap: false,
      pending: 0,
      canResume: false,
      retiredConversationIds: new Set(),
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

/**
 * Safely retire the active conversation and process for a session.
 * Marks the session as requiring a fresh AGY bootstrap.
 */
export function retireSessionConversation(sessionId: string, owner?: symbol): Promise<void> {
  const state = getSessionState(sessionId);
  if (owner && state.owner && state.owner !== owner) return Promise.resolve();
  state.needsBootstrap = true;
  const processes = new Set<AgyProcess>();
  for (const [proc, owner] of ownedProcesses) if (owner.state === state) processes.add(proc);
  state.process = undefined;
  state.canResume = false;
  if (state.activeConversationId) {
    const id = state.activeConversationId;
    state.retiredConversationIds.add(id);
    retiredConversationIds.add(id);
    validPostCompactionConversations.delete(id);
    state.activeConversationId = undefined;
  }
  return Promise.all([...processes].map(proc => {
    const closed = proc.kill();
    removeProcessReferences(proc);
    return closed;
  })).then(() => {});
}

/** Releasing ownership also revokes native resume authority. */
export function releaseSessionProcesses(sessionId: string, owner?: symbol): Promise<void> {
  const state = sessionStates.get(sessionId);
  if (!state || (owner && state.owner !== owner)) return Promise.resolve();
  state.process = undefined;
  state.canResume = false;
  state.needsBootstrap = true;
  return Promise.all([...ownedProcesses].filter(([, registration]) => registration.state === state && (!owner || registration.owner === owner))
    .map(([proc]) => proc.kill())).then(() => {});
}

/** Runner disposal also owns short-lived requests whose routing ID differs (e.g. compaction). */
export function releaseProviderProcesses(owner: symbol): Promise<void> {
  // Include idle owners whose child already exited and left the process registry.
  for (const state of sessionStates.values()) if (state.owner === owner) {
    state.canResume = false;
    state.needsBootstrap = true;
  }
  return Promise.all([...ownedProcesses].filter(([, registration]) => registration.owner === owner)
    .map(([proc, registration]) => {
      if (registration.state.process === proc) registration.state.process = undefined;
      return proc.kill();
    })).then(() => {});
}

/**
 * Authoritative compaction notification for a session.
 */
export function markSessionCompacted(sessionId: string, owner?: symbol): Promise<void> {
  return retireSessionConversation(sessionId, owner);
}

let shutdownHooksRegistered = false;

/**
 * Clear all active processes and session tracking. Used for test teardown and shutdown.
 */
export function resetActiveProcesses(): Promise<void> {
  const pending = [...new Set([...ownedProcesses.keys(), ...activeProcesses.values()])].map(proc => proc.kill());
  activeProcesses.clear();
  sessionStates.clear();
  retiredConversationIds.clear();
  validPostCompactionConversations.clear();
  return Promise.all(pending).then(() => {});
}

export function handleSignal(
  signal: NodeJS.Signals,
  exitFn?: (code: number) => void,
): void {
  resetActiveProcesses();
  if (exitFn) {
    exitFn(signal === "SIGINT" ? 130 : 143);
  }
}

const onExit = () => {
  resetActiveProcesses();
};
const onSigInt = () => {
  handleSignal("SIGINT");
};
const onSigTerm = () => {
  handleSignal("SIGTERM");
};

export function registerShutdownHooksOnce(): void {
  if (shutdownHooksRegistered) {
    return;
  }
  shutdownHooksRegistered = true;
  process.once("exit", onExit);
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
}

export function unregisterShutdownHooksForTesting(): void {
  process.removeListener("exit", onExit);
  process.removeListener("SIGINT", onSigInt);
  process.removeListener("SIGTERM", onSigTerm);
  shutdownHooksRegistered = false;
}

export function isCompactionMessage(msg: Message): boolean {
  const rawRole = (msg as unknown as Record<string, unknown>).role;
  if (rawRole === "compactionSummary" || rawRole === "branchSummary") {
    return true;
  }
  const raw = msg as unknown as Record<string, unknown>;
  if (raw.customType === "compaction" || raw.customType === "branch_summary") {
    return true;
  }
  if (typeof raw.summary === "string" && raw.tokensBefore !== undefined) {
    return true;
  }
  if (raw.isCompaction === true) {
    return true;
  }
  if (msg.role === "user") {
    const text = contentText(msg.content);
    if (
      text.includes("The conversation history before this point was compacted") ||
      text.includes("The following is a summary of a branch that this conversation came back from") ||
      (text.includes("<summary>") &&
        (text.includes("## Goal") ||
          text.includes("## Progress") ||
          text.includes("## Critical Context") ||
          text.includes("<read-files>")))
    ) {
      return true;
    }
  }
  return false;
}

export interface CompactionDetectionResult {
  hasCompaction: boolean;
  compactionIndex: number;
  compactionMessage?: Message;
  compactionTimestamp?: number;
}

/**
 * Structural compaction detector from actual Pi projected context.
 *
 * Why this fallback exists:
 * The extension lifecycle event `session_compact` is the authoritative signal,
 * but it may not be observed when Pi restarts, the extension reloads, an old Pi
 * session is resumed, or branch/tree navigation occurs. In those cases, this
 * detector inspects the projected context messages for structural evidence of compaction.
 */
export function detectCompaction(
  context: TranscriptContext | { messages?: Message[] },
): CompactionDetectionResult {
  const messages = context?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isCompactionMessage(m)) {
      const rawTs = m.timestamp ?? (m as unknown as Record<string, unknown>).timestamp;
      const compactionTimestamp = typeof rawTs === "number" ? rawTs : undefined;
      return {
        hasCompaction: true,
        compactionIndex: i,
        compactionMessage: m,
        compactionTimestamp,
      };
    }
  }
  return {
    hasCompaction: false,
    compactionIndex: -1,
  };
}

export function extractCompactionSummaryText(msg: Message): string {
  const raw = msg as unknown as Record<string, unknown>;
  const rawSummary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const content = contentText(msg.content).trim();

  if (content) {
    return content;
  }
  if (rawSummary) {
    return `${COMPACTION_SUMMARY_PREFIX}${rawSummary}${COMPACTION_SUMMARY_SUFFIX}`;
  }
  return "";
}

/**
 * Extract authoritative system prompt from context, deduplicating context.systemPrompt
 * and any projected system messages to ensure it appears exactly once.
 */
export function extractAuthoritativeSystemPrompt(
  context: TranscriptContext | { systemPrompt?: string; messages?: Message[] },
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const rawPrompt = (context as { systemPrompt?: string }).systemPrompt?.trim();
  if (rawPrompt) {
    parts.push(rawPrompt);
    seen.add(rawPrompt);
  }

  const messages = context?.messages || [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = contentText(msg.content).trim();
      if (text && !seen.has(text)) {
        parts.push(text);
        seen.add(text);
      }
    }
  }

  return parts.join("\n\n");
}

export interface FindConversationOptions {
  sessionId?: string;
  isPostCompactionBootstrap?: boolean;
  provider?: string;
  api?: string;
}

/**
 * Scan transcript backwards for an assistant message carrying the AGY conversation ID.
 * Ignores stale pre-compaction assistant responseIds when compaction has occurred.
 */
export function findConversationId(
  context: TranscriptContext,
  options?: FindConversationOptions,
): string | undefined {
  if (!context?.messages) {
    return undefined;
  }

  if (options?.isPostCompactionBootstrap) {
    return undefined;
  }

  const sid = options?.sessionId;
  if (sid) {
    const sState = sessionStates.get(sid);
    if (sState?.needsBootstrap) {
      return undefined;
    }
  }

  const compaction = detectCompaction(context);

  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.provider !== (options?.provider ?? DEFAULT_PROVIDER_NAME) ||
          assistantMsg.api !== (options?.api ?? API_IDENTIFIER)) return undefined;
      const convId =
        assistantMsg.responseId ||
        (assistantMsg as unknown as Record<string, unknown>).conversationId;

      if (typeof convId === "string" && convId) {
        if (retiredConversationIds.has(convId)) {
          continue;
        }

        if (!compaction.hasCompaction) {
          return convId;
        }

        if (validPostCompactionConversations.has(convId)) {
          return convId;
        }

        if (compaction.compactionTimestamp !== undefined) {
          const msgTs =
            assistantMsg.timestamp ??
            (assistantMsg as unknown as Record<string, unknown>).timestamp;
          if (typeof msgTs === "number") {
            if (msgTs <= compaction.compactionTimestamp) {
              continue;
            } else {
              return convId;
            }
          }
        }

        if (i <= compaction.compactionIndex) {
          continue;
        }

        if (sid && sessionStates.get(sid)?.activeConversationId === convId) {
          return convId;
        }

        continue;
      }
    }
  }
  return undefined;
}


/**
 * Construct turn prompt for the official AGY stream-json input.
 */
export function buildTurnPrompt(
  context: TranscriptContext,
  isResumed: boolean,
): string {
  const messages = context.messages || [];
  const nonSystem = messages.filter((m) => m.role !== "system");
  const lastMsg = nonSystem[nonSystem.length - 1];
  const lastText = lastMsg ? contentText(lastMsg.content) : "";

  if (isResumed) {
    // Session is already alive or being resumed with --conversation <id>
    return lastText;
  }

  // Fresh conversation or bootstrap: extract system prompt exactly once
  const systemPrompt = extractAuthoritativeSystemPrompt(context);

  const compaction = detectCompaction(context);

  if (compaction.hasCompaction && compaction.compactionIndex >= 0) {
    // Bootstrap fresh AGY conversation from Pi's compacted projection:
    // <System context>
    // <Compaction summary>
    // <Recent retained conversation>
    // <Current request>
    const parts: string[] = [];
    if (systemPrompt) {
      parts.push(systemPrompt);
    }

    const summaryText = extractCompactionSummaryText(compaction.compactionMessage!);
    if (summaryText) {
      parts.push(summaryText);
    }

    for (let i = compaction.compactionIndex + 1; i < messages.length - 1; i++) {
      const msg = messages[i];
      if (msg.role === "system" || msg.role === "toolResult") {
        continue;
      }
      if (msg.role === "user" || msg.role === "assistant") {
        const text = contentText(msg.content).trim();
        if (text) {
          const roleLabel = msg.role === "assistant" ? "Assistant" : "User";
          parts.push(`${roleLabel}: ${text}`);
        }
      }
    }

    if (lastMsg && lastMsg !== compaction.compactionMessage && lastText) {
      parts.push(lastText);
    }

    return parts.join("\n\n");
  }

  // Fresh conversation without compaction:
  if (nonSystem.length <= 1) {
    return systemPrompt ? `${systemPrompt}\n\n${lastText}`.trim() : lastText;
  }

  // Multi-turn transcript without an established conversation ID
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(systemPrompt);
  }
  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i];
    const text = contentText(msg.content);
    if (i === nonSystem.length - 1) {
      parts.push(text);
    } else {
      parts.push(`${msg.role === "assistant" ? "Assistant" : "User"}: ${text}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Resolve reasoning effort flag from model, options, or environment.
 * Official AGY constraints:
 * - Claude models & GPT-OSS: --effort not supported (must be omitted)
 * - Gemini 3.1 Pro: supports "low" and "high" (default: "high")
 * - Gemini Flash models (3.8, 3.7, 3.6): requires --effort (low, medium, high; default: "medium")
 */
export function resolveEffort(
  modelId: string,
  options?: SimpleStreamOptions,
): AgyEffort | undefined {
  if (!modelId.startsWith("gemini-")) {
    return undefined;
  }

  const envVal = process.env.AGY_POOL_EFFORT?.toLowerCase();

  if (modelId === "gemini-3.1-pro") {
    if (options?.reasoning) {
      if (options.reasoning === "low" || options.reasoning === "minimal") {
        return "low";
      }
      if (
        options.reasoning === "medium" ||
        options.reasoning === "high" ||
        options.reasoning === "xhigh" ||
        options.reasoning === "max"
      ) {
        return "high";
      }
    }
    if (envVal === "low" || envVal === "high") {
      return envVal;
    }
    return "high";
  }

  // Gemini Flash models (gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, etc.)
  if (options?.reasoning) {
    switch (options.reasoning) {
      case "minimal":
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
      case "xhigh":
      case "max":
        return "high";
    }
  }

  if (envVal === "low" || envVal === "medium" || envVal === "high") {
    return envVal;
  }

  return "medium";
}

export type AgyProgressCallback = (message?: string) => void;

/** Request-local telemetry state. No timer delays AGY or queues historical UI frames. */
export class AgyProgressAdapter {
  private currentMessage: string | undefined;
  private activities = new Map<string, string>();
  private ended = false;
  private readonly callback: AgyProgressCallback;

  constructor(callback?: AgyProgressCallback) {
    this.callback = callback ?? (() => {});
  }

  update(message?: string): void {
    if (this.ended || message === this.currentMessage) return;
    try {
      this.callback(message);
      this.currentMessage = message;
    } catch {
      // UI failure must not interrupt official AGY execution; a later update can retry.
    }
  }

  step(update: AgyStepUpdatePayload): void {
    if (this.ended) return;
    const type = update.step_type;
    if (type === "tool" || type === "subagent") {
      const subagent = update.subagent_info?.subagents?.[0];
      const identity = update.step_index ?? (type === "tool"
        ? update.tool_name || update.tool_info?.name
        : subagent?.conversation_id || subagent?.role || subagent?.type_name);
      // ponytail: identical unindexed/unnamed activities cannot be distinguished;
      // use an upstream stable ID if AGY exposes one. Ambiguous DONE keeps peers.
      let key = JSON.stringify([update.conversation_id, type, identity]);
      if (update.state === "DONE" && identity === undefined) {
        const candidates = [...this.activities.keys()].filter((candidate) => {
          const [conversation, kind] = JSON.parse(candidate);
          return conversation === (update.conversation_id ?? null) && kind === type;
        });
        if (candidates.length === 1) key = candidates[0];
      }
      const label = this.activities.get(key) ?? (type === "tool"
        ? formatToolProgress(update.tool_name || update.tool_info?.name)
        : formatSubagentProgress(update.subagent_info));
      if (update.state === "DONE") {
        this.activities.delete(key);
        this.update([...this.activities.values()].at(-1) ?? label.replace(/…$/, " — done; continuing…"));
      } else {
        this.activities.set(key, label);
        this.update(label);
      }
    } else if (type === "agent_response") {
      if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
        this.clear();
      } else {
        // Keep a useful completion label across empty response/usage records.
        this.update([...this.activities.values()].at(-1) ?? this.currentMessage ?? "AGY: Working…");
      }
    }
  }

  clear(): void {
    this.update(undefined);
  }

  finish(): void {
    this.clear();
    this.activities.clear();
    this.ended = true;
  }
}

export function formatToolProgress(toolName?: string): string {
  if (!toolName) {
    return "AGY: Running tool…";
  }
  if (typeof toolName !== "string") return "AGY: Running tool…";
  const toolLower = toolName.toLowerCase();
  const normalized = toolLower.replace(/[-_]/g, "");

  if (
    toolLower === "view_file" ||
    toolLower === "read_file" ||
    normalized === "viewfile" ||
    normalized === "readfile" ||
    normalized === "read"
  ) {
    return "AGY: Reading file…";
  }

  if (
    toolLower === "run_command" ||
    toolLower === "bash" ||
    toolLower === "shell" ||
    normalized === "runcommand" ||
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "terminal"
  ) {
    return "AGY: Running command…";
  }

  if (["codesearch", "searchcode", "grep", "find"].includes(normalized)) {
    return "AGY: Searching code…";
  }

  if (
    toolLower.startsWith("search") ||
    normalized.startsWith("search") ||
    normalized === "websearch"
  ) {
    return "AGY: Searching…";
  }

  if (
    toolLower.startsWith("edit") ||
    normalized.startsWith("edit") ||
    normalized === "replacefilecontent"
  ) {
    return "AGY: Editing file…";
  }

  if (
    toolLower.startsWith("write") ||
    normalized.startsWith("write")
  ) {
    return "AGY: Writing file…";
  }

  if (
    normalized === "listdir" ||
    normalized === "listdirectory" ||
    normalized === "directoryanalysis"
  ) {
    return "AGY: Inspecting directory…";
  }

  if (normalized === "invokesubagent") {
    return "AGY: Running subagent…";
  }

  // Unknown names may contain paths or secrets; never echo them.
  return "AGY: Running tool…";
}

export function formatSubagentProgress(info?: { subagents?: Array<{ role?: string; type_name?: string }> }): string {
  const first = info?.subagents?.[0];
  const role = typeof first?.role === "string" ? first.role.trim() : "";
  const typeName = typeof first?.type_name === "string" ? first.type_name.trim() : "";

  const candidate = (role || typeName).replace(/\s+/g, " ").trim();
  // Only display known role labels; arbitrary roles may contain prompts or credentials.
  const roles: Record<string, string> = {
    research: "Research", researcher: "Research", "research subagent": "Research",
    "code reviewer": "Code Reviewer", "architecture auditor": "Architecture Auditor",
    explorer: "Explorer", planner: "Planner", reviewer: "Reviewer",
  };
  const key = candidate.toLowerCase();
  const label = candidate.length <= 30 && Object.hasOwn(roles, key) ? roles[key] : undefined;
  return label ? `AGY: ${label} subagent…` : "AGY: Running subagent…";
}

export interface ExtendedStreamOptions extends SimpleStreamOptions {
  spawnFn?: typeof spawn;
  bin?: string;
  onProgress?: AgyProgressCallback;
  owner?: symbol;
  ephemeral?: boolean;
  sessionId?: string;
}

/**
 * Executes a streaming text-generation turn through official AGY headless via agy-pool.
 *
 * Responsibilities:
 * - One Pi session owns one AGY subprocess.
 * - Captures AGY init.conversation_id to maintain session continuity.
 * - Streams incremental text_delta, usage metadata, and completion.
 * - AbortSignal propagates SIGINT to child process and invalidates it.
 */
export function streamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: ExtendedStreamOptions,
): AssistantMessageEventStream {
  registerShutdownHooksOnce();
  const stream = createAssistantMessageEventStream();

  const previous = options?.sessionId ? sessionStates.get(options.sessionId) : undefined;
  const ephemeral = !options?.sessionId || options.ephemeral ||
    Boolean(previous?.process && previous.owner !== options?.owner);
  const activeSid = ephemeral ? `request:${randomUUID()}` : options!.sessionId!;
  const progressAdapter = new AgyProgressAdapter(options?.onProgress);

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    let proc: AgyProcess | undefined;
    let createdProcess = false;
    let requestState: SessionOwnership | undefined;

    try {
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      progressAdapter.update("AGY: Working…");
      const sessionState = activeSid ? getSessionState(activeSid) : undefined;

      const compaction = detectCompaction(context);
      let isBootstrapTurn = Boolean(sessionState?.needsBootstrap);

      if (!isBootstrapTurn && compaction.hasCompaction) {
        const existingConvId = findConversationId(context, {
          sessionId: activeSid, provider: model.provider, api: model.api,
        });
        if (!existingConvId) {
          isBootstrapTurn = true;
        }
      }

      if (isBootstrapTurn && activeSid && sessionState?.activeConversationId) {
        retireSessionConversation(activeSid);
      }

      const state = getSessionState(activeSid);
      requestState = state;
      state.pending++;
      const lastAssistant = [...context.messages].reverse().find(m => m.role === "assistant") as AssistantMessage | undefined;
      // A different runner cannot inherit idle/dead ownership merely by opening
      // the same Pi session ID. A live conflicting owner was isolated above.
      if (state.owner !== options?.owner || (!state.process?.isBusy() && (
        (state.provider !== undefined && (state.provider !== model.provider || state.api !== model.api)) ||
        (lastAssistant && (lastAssistant.provider !== model.provider || lastAssistant.api !== model.api))))) {
        void retireSessionConversation(activeSid);
        isBootstrapTurn = true;
      }
      // Native continuation requires this in-memory lineage and a completed turn.
      // Historical responseId is useful metadata, never a resume credential.
      let conversationId = !isBootstrapTurn && state.canResume ? state.activeConversationId : undefined;
      // A second owner must never attach to the same mutable conversation.
      if (conversationId && [...ownedProcesses].some(([p, owner]) => owner.state !== state &&
          p.conversationId === conversationId)) conversationId = undefined;
      let isResumed = false;
      let replacementClosed: Promise<void> | undefined;
      const effort = resolveEffort(model.id, options);
      const existing = state.process;
      if (existing?.isAlive()) {
        if (existing.modelId === model.id && existing.effort === effort) {
          proc = existing;
          isResumed = true;
        } else if (existing.isBusy()) {
          // Interrupted native work may already be ahead of the Pi projection.
          void retireSessionConversation(activeSid);
          conversationId = undefined;
        } else {
          state.process = undefined;
          void existing.kill();
        }
      }
      if (!proc) {
        replacementClosed = Promise.all([...ownedProcesses]
          .filter(([owner, session]) => session.state === state && !owner.isAlive())
          .map(([owner]) => owner.closed)).then(() => {});
        proc = new AgyProcess({ modelId: model.id, effort, conversationId,
          bin: options?.bin, spawnFn: options?.spawnFn });
        createdProcess = true;
        state.owner = options?.owner;
        state.provider = model.provider;
        state.api = model.api;
        trackProcess(proc, state);
        isResumed = Boolean(conversationId);
      }

      // A new attempt revokes the proven idle boundary until its terminal success.
      // Even a preparation-only failure may conservatively lose replacement reuse.
      state.canResume = false;
      // Reserve the FIFO slot before an asynchronous payload hook can yield.
      const prompt = Promise.resolve().then(async () => {
        const original = buildTurnPrompt(context, isResumed);
        const replacement = await options?.onPayload?.({ event: "user", message: { content: original } }, model);
        if (replacement && typeof replacement === "object" && "message" in replacement) {
          return (replacement as { message?: { content?: string } }).message?.content || original;
        }
        return original;
      });

      let startedEmitted = false;

      let initialized = false;
      const bindInit = () => {
        const init = proc?.init;
        if (initialized || !init) return;
        initialized = true;
        output.responseId = init.conversation_id;
        (output as unknown as Record<string, unknown>).conversationId = init.conversation_id;
        if (createdProcess && !startedEmitted) {
          startedEmitted = true;
          stream.push({ type: "start", partial: output });
        }
        if (createdProcess && options?.onResponse) void options.onResponse({ status: 200, headers: {} }, model);
      };

      const handleEvent = (event: AgyEvent) => {
        if (event.event === "init") {
          bindInit();
          progressAdapter.update("AGY: Working…");
        } else if (event.event === "step_update") {
          const update = (event as { step_update?: AgyStepUpdatePayload }).step_update;
          if (!update) return;

          if (!startedEmitted) {
            startedEmitted = true;
            stream.push({ type: "start", partial: output });
          }

          // Invariant: Only step_type == "agent_response" (or legacy untyped response) with text_delta contributes to assistant answer text.
          // Tool, subagent, system_message, and unknown telemetry events must NEVER contribute text or emit tool calls.
          const stepType = update.step_type;
          const isNonAgentStep =
            stepType === "tool" ||
            stepType === "subagent" ||
            stepType === "system_message" ||
            stepType === "user_input";

          const isAgentResponse =
            stepType === "agent_response" || (!stepType && !isNonAgentStep);

          const textDelta =
            isAgentResponse && typeof update.text_delta === "string" && update.text_delta.length > 0
              ? update.text_delta
              : undefined;

          if (textDelta) {
            progressAdapter.clear();
            if (output.content.length === 0) {
              output.content.push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex: 0, partial: output });
            }
            (output.content[0] as TextContent).text += textDelta;
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: textDelta,
              partial: output,
            });
          } else {
            progressAdapter.step(update);
          }

          const usage = update.usage;
          if (usage) {
            if (typeof usage.input_tokens === "number") {
              output.usage.input = usage.input_tokens;
            }
            if (typeof usage.output_tokens === "number") {
              output.usage.output = usage.output_tokens;
            }
            if (typeof usage.total_tokens === "number") {
              output.usage.totalTokens = usage.total_tokens;
            }
            if (typeof usage.thinking_tokens === "number") {
              output.usage.reasoning = usage.thinking_tokens;
            }
          }
        }
      };

      // Early init is retained by the process; no event replay is required.
      // A replacement may initialize, but cannot execute while its predecessor lives.
      const preparedPrompt = Promise.all([proc.ready, prompt, replacementClosed]).then(([, prepared]) => {
        bindInit();
        return prepared;
      });

      // Execute the turn
      const result = await proc.runTurn(preparedPrompt, handleEvent, options?.signal);
      progressAdapter.finish();

      // Fallback: If no streaming deltas were received, populate from terminal result response
      let fallbackResponse: string | undefined;
      if (typeof result.result?.response === "string" && result.result.response) {
        fallbackResponse = result.result.response;
      } else if (
        typeof (result as Record<string, unknown>).response === "string" &&
        (result as Record<string, unknown>).response
      ) {
        fallbackResponse = (result as Record<string, unknown>).response as string;
      }

      if (output.content.length === 0 && fallbackResponse) {
        output.content.push({ type: "text", text: fallbackResponse });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: fallbackResponse,
          partial: output,
        });
      }

      // Terminal usage fallback from result event if not already populated or if provided authoritatively
      const finalUsage =
        (result.result?.usage as Record<string, unknown> | undefined) ||
        (result.data?.usage as Record<string, unknown> | undefined);
      if (finalUsage) {
        if (typeof finalUsage.input_tokens === "number") {
          output.usage.input = finalUsage.input_tokens;
        }
        if (typeof finalUsage.output_tokens === "number") {
          output.usage.output = finalUsage.output_tokens;
        }
        if (typeof finalUsage.total_tokens === "number") {
          output.usage.totalTokens = finalUsage.total_tokens;
        }
        if (typeof finalUsage.thinking_tokens === "number") {
          output.usage.reasoning = finalUsage.thinking_tokens;
        }
      }
      if (
        output.usage.totalTokens === 0 &&
        (output.usage.input > 0 || output.usage.output > 0)
      ) {
        output.usage.totalTokens = output.usage.input + output.usage.output;
      }

      const stopReason = result.data?.stop_reason || result.result?.stop_reason;
      if (stopReason) {
        output.rawStopReason = stopReason;
        if (stopReason === "MAX_TOKENS") {
          output.stopReason = "length";
        } else {
          output.stopReason = "stop";
        }
      }

      if (output.content.length > 0 && output.content[0].type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: output.content[0].text,
          partial: output,
        });
      }

      if (state.process === proc) state.canResume = !proc.isBusy();
      const finalReason =
        output.stopReason === "stop" || output.stopReason === "length"
          ? output.stopReason
          : "stop";
      stream.push({ type: "done", reason: finalReason, message: output });
      stream.end();
    } catch (error) {
      progressAdapter.finish();

      const isAborted =
        Boolean(options?.signal?.aborted) ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("aborted")));

      output.stopReason = isAborted ? "aborted" : "error";
      output.errorMessage = isAborted
        ? "Request was aborted"
        : error instanceof Error
          ? error.message
          : String(error);

      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (requestState) requestState.pending--;
      if (ephemeral) {
        await releaseSessionProcesses(activeSid);
        if (requestState) {
          const ids = new Set(requestState.retiredConversationIds);
          if (requestState.activeConversationId) ids.add(requestState.activeConversationId);
          for (const id of ids) {
            validPostCompactionConversations.delete(id);
            retiredConversationIds.delete(id);
          }
        }
        if (sessionStates.get(activeSid) === requestState) sessionStates.delete(activeSid);
      }
      progressAdapter.finish();
    }
  })();

  return stream;
}
