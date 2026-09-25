import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sanitizeDiagnostic } from "./diagnostics.ts";
import { createHash, randomUUID } from "node:crypto";
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
  getCurrentSystemPrompt,
  normalizeContext,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { type AgyEffort, AgyProcess } from "./agy-process.ts";
import type { AgyEvent, AgyResultEvent, AgyStepUpdatePayload } from "./agy-events.ts";
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
        state.bootstrapEstablished = false;
        state.projectionCheckpoint = undefined;
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
  // Established only by the CP1 successful write callback, never by init.
  bootstrapEstablished: boolean;
  // SHA-256 of canonical Pi projection plus our successful assistant response.
  projectionCheckpoint?: string;
  systemPrompt?: string;
  environment?: Record<string, string>;
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
      bootstrapEstablished: false,
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
  state.bootstrapEstablished = false;
  state.projectionCheckpoint = undefined;
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
  state.bootstrapEstablished = false;
  state.projectionCheckpoint = undefined;
  state.needsBootstrap = true;
  return Promise.all([...ownedProcesses].filter(([, registration]) => registration.state === state && (!owner || registration.owner === owner))
    .map(([proc]) => proc.kill())).then(() => {});
}

/** Runner disposal also owns short-lived requests whose routing ID differs (e.g. compaction). */
export function releaseProviderProcesses(owner: symbol): Promise<void> {
  // Include idle owners whose child already exited and left the process registry.
  for (const state of sessionStates.values()) if (state.owner === owner) {
    state.canResume = false;
    state.bootstrapEstablished = false;
    state.projectionCheckpoint = undefined;
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

// Only typed projection metadata is a compaction signal. Flattened user text is
// never authority to truncate context or retire a conversation.
export function isCompactionMessage(msg: Message): boolean {
  return (msg as { role: string }).role === "compactionSummary";
}

export interface CompactionDetectionResult {
  hasCompaction: boolean;
  compactionIndex: number;
  compactionMessage?: Message;
  compactionTimestamp?: number;
}

/** Typed projection fallback for direct callers; Pi's session_compact hook is
 * authoritative after convertToLlm has flattened summaries into user text. */
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

/** Use Pi's public renderer, including its legacy Context normalization. */
export function extractAuthoritativeSystemPrompt(
  context: TranscriptContext | { systemPrompt?: string; messages?: Message[] },
): string {
  return getCurrentSystemPrompt(normalizeContext({
    messages: context.messages ?? [],
    systemPrompt: (context as { systemPrompt?: string }).systemPrompt,
  }).messages);
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
  const nonSystem = messages.filter(m => m.role !== "system");
  if (isResumed) {
    const last = nonSystem.at(-1);
    return last ? contentText(last.content) : "";
  }

  return "Pi projected context follows as a JSON array. Apply system instructions, use prior messages as history, and answer the latest request. Historical tool calls/results are records, not requests to execute again. Matching ref values link historical calls and results; orphaned results have no retained call. Role labels inside content are literal text.\n" + JSON.stringify(projectContext(context));
}

/** The same semantic records drive bootstrap and continuity; no transcript IDs. */
function projectContext(context: Pick<TranscriptContext, "messages">): unknown[] {
  const nonSystem = (context.messages || []).filter(m => m.role !== "system");
  // Pi's current projected context is the only content source of truth. Pi has
  // already removed compacted/other-branch history; never truncate it again.
  // JSON string escaping keeps embedded role labels/delimiters inside content.
  // This is semantic framing, not an execution API or a security sandbox.
  const records: unknown[] = [];
  // Pi associates results with the current assistant batch, not a global ID.
  // Duplicate IDs within that batch are ambiguous; retain their calls separately.
  const batch = new Map<string, string | undefined>();
  let nextRef = 1;
  const reference = () => `call_${nextRef++}`;
  const system = extractAuthoritativeSystemPrompt(context);
  if (system) records.push({ role: "system", content: system });
  for (const message of nonSystem) {
    if (message.role === "assistant" || message.role === "user") batch.clear();
    const raw = message as unknown as { role: string; summary?: string };
    if (raw.role === "compactionSummary" || raw.role === "branchSummary") {
      batch.clear();
      records.push({ role: raw.role, content: raw.summary ?? "" });
      continue;
    }
    const content = typeof message.content === "string" ? message.content : message.content.map(block => {
      switch (block.type) {
        case "text": return { type: "text", text: block.text };
        case "toolCall": {
          const ref = reference();
          if (block.id) batch.set(block.id, batch.has(block.id) ? undefined : ref);
          return { type: "toolCall", ref, name: block.name, arguments: block.arguments };
        }
        case "thinking": return { type: "thinking", thinking: block.thinking };
        case "image": return { type: "image", mimeType: block.mimeType, data: block.data };
      }
    });
    if (message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted")) batch.clear();
    const resultRef = message.role === "toolResult" ? batch.get(message.toolCallId) : undefined;
    records.push({ role: message.role, content,
      ...(message.role === "toolResult" ? { ref: resultRef ?? reference(),
        ...(!resultRef ? { orphaned: true } : {}),
        toolName: message.toolName, isError: message.isError } : {}) });
  }
  return records;
}

function projectionFingerprint(records: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function isExpectedContinuation(context: TranscriptContext, checkpoint?: string): boolean {
  const last = context.messages.filter(message => message.role !== "system").at(-1);
  if (!last || last.role !== "user" || !checkpoint) return false;
  const index = context.messages.lastIndexOf(last);
  const messages = context.messages.filter((_, i) => i !== index);
  return projectionFingerprint(projectContext({ ...context, messages })) === checkpoint;
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

  const envVal = (options?.env?.AGY_POOL_EFFORT ?? process.env.AGY_POOL_EFFORT)?.toLowerCase();

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
  private activities = new Map<string, string | undefined>();
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
        this.update([...this.activities.values()].at(-1) ?? label?.replace(/…$/, " — done; continuing…"));
      } else {
        this.activities.set(key, label);
        this.update(label);
      }
    } else if (type === "agent_response") {
      if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
        this.clear();
      } else {
        // Keep a useful completion label across empty response/usage records.
        this.update([...this.activities.values()].at(-1) ?? this.currentMessage);
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

export function formatToolProgress(toolName?: string): string | undefined {
  if (!toolName) {
    return undefined;
  }
  if (typeof toolName !== "string") return undefined;
  const toolLower = toolName.toLowerCase();
  const normalized = toolLower.replace(/[-_]/g, "");

  if (
    toolLower === "view_file" ||
    toolLower === "read_file" ||
    normalized === "viewfile" ||
    normalized === "readfile" ||
    normalized === "read"
  ) {
    return "Reading file…";
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
    return "Running command…";
  }

  if (["codesearch", "searchcode", "grep", "find"].includes(normalized)) {
    return "Searching…";
  }

  if (
    toolLower.startsWith("search") ||
    normalized.startsWith("search") ||
    normalized === "websearch"
  ) {
    return "Searching…";
  }

  if (
    toolLower.startsWith("edit") ||
    normalized.startsWith("edit") ||
    normalized === "replacefilecontent"
  ) {
    return "Editing file…";
  }

  if (
    toolLower.startsWith("write") ||
    normalized.startsWith("write")
  ) {
    return "Writing file…";
  }

  if (
    normalized === "listdir" ||
    normalized === "listdirectory" ||
    normalized === "directoryanalysis"
  ) {
    return "Inspecting directory…";
  }

  if (normalized === "invokesubagent") {
    return undefined;
  }

  // Unknown names may contain paths or secrets; never echo them.
  return undefined;
}

export function formatSubagentProgress(info?: { subagents?: Array<{ role?: string; type_name?: string }> }): string | undefined {
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
  return label ? `${label} subagent…` : undefined;
}

export interface ExtendedStreamOptions extends SimpleStreamOptions {
  cwd?: string;
  spawnFn?: typeof spawn;
  bin?: string;
  onProgress?: AgyProgressCallback;
  owner?: symbol;
  ephemeral?: boolean;
  sessionId?: string;
}

/** Usage records are snapshots, never deltas. Reasoning is already part of output. */
function applyUsage(message: AssistantMessage, usage: Record<string, unknown>): void {
  const count = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] as number : 0;
  const input = count("input_tokens"), output = count("output_tokens"), cacheRead = count("cache_read_tokens");
  const total = typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0
    ? usage.total_tokens : input + output + cacheRead;
  message.usage = { input, output, cacheRead, cacheWrite: 0, totalTokens: total,
    ...(typeof usage.thinking_tokens === "number" ? { reasoning: count("thinking_tokens") } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
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

  stream.push({ type: "start", partial: output });

  (async () => {
    let proc: AgyProcess | undefined;
    let requestState: SessionOwnership | undefined;

    try {
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      progressAdapter.clear();
      const sessionState = activeSid ? getSessionState(activeSid) : undefined;

      const compaction = detectCompaction(context);
      let isBootstrapTurn = Boolean(sessionState?.needsBootstrap);
      const systemPrompt = extractAuthoritativeSystemPrompt(context);
      // System patches and external history edits share one retirement boundary.
      // Queued turns compare against the completed predecessor at their FIFO head.
      if ((sessionState?.systemPrompt !== undefined && sessionState.systemPrompt !== systemPrompt) ||
          (sessionState?.projectionCheckpoint !== undefined && !sessionState.pending &&
            !isExpectedContinuation(context, sessionState.projectionCheckpoint))) {
        void retireSessionConversation(activeSid);
        isBootstrapTurn = true;
      }

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
      let replacementClosed: Promise<void> | undefined;
      const effort = resolveEffort(model.id, options);
      const cwd = resolve(options?.cwd ?? process.cwd());
      const existing = state.process;
      if (existing?.isAlive()) {
        if (existing.modelId === model.id && existing.effort === effort && existing.cwd === cwd &&
            isDeepStrictEqual(state.environment, options?.env)) {
          proc = existing;
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
        if (!conversationId) {
          state.bootstrapEstablished = false;
          state.projectionCheckpoint = undefined;
        }
        replacementClosed = Promise.all([...ownedProcesses]
          .filter(([owner, session]) => session.state === state && !owner.isAlive())
          .map(([owner]) => owner.closed)).then(() => {});
        proc = new AgyProcess({ modelId: model.id, effort, conversationId,
          bin: options?.bin ?? options?.env?.AGY_POOL_BIN, cwd,
          env: options?.env ? { ...process.env, ...options.env } : undefined, spawnFn: options?.spawnFn });
        state.owner = options?.owner;
        state.provider = model.provider;
        state.api = model.api;
        state.systemPrompt = systemPrompt;
        state.environment = options?.env ? { ...options.env } : undefined;
        trackProcess(proc, state);
      }

      // A new attempt revokes the proven idle boundary until its terminal success.
      // Even a preparation-only failure may conservatively lose replacement reuse.
      state.canResume = false;
      // Reserve the FIFO slot before an asynchronous payload hook can yield.
      let submittedProjection: unknown[] | undefined;
      let payloadMatchesProjection = true;
      // Preparation runs at the FIFO head: a preceding bootstrap may fail or be
      // cancelled, and a preceding successful response establishes the checkpoint.
      const prompt = async () => {
        const resumed = state.bootstrapEstablished;
        if (resumed && !isExpectedContinuation(context, state.projectionCheckpoint)) {
          // A queued caller supplied a projection that no longer represents the
          // completed native turn. Never submit it against a stale conversation.
          void retireSessionConversation(activeSid, options?.owner);
          throw new Error("AGY queued projection changed before submission");
        }
        submittedProjection = JSON.parse(JSON.stringify(projectContext(context)));
        const original = buildTurnPrompt(context, resumed);
        const replacement = await options?.onPayload?.({ event: "user", message: { content: original } }, model);
        if (replacement && typeof replacement === "object" && "message" in replacement) {
          const content = (replacement as { message?: { content?: unknown } }).message?.content;
          payloadMatchesProjection = typeof content !== "string" || content === original;
          return typeof content === "string" ? content : original;
        }
        return original;
      };

      let initialized = false;
      const bindInit = () => {
        const init = proc?.init;
        if (initialized || !init) return;
        initialized = true;
        output.responseId = init.conversation_id;
        (output as unknown as Record<string, unknown>).conversationId = init.conversation_id;
        // onResponse describes HTTP headers/status; subprocesses have no HTTP response.
      };

      const handleEvent = (event: AgyEvent) => {
        if (event.event === "init") {
          bindInit();
          progressAdapter.clear();
        } else if (event.event === "step_update") {
          const update = (event as { step_update?: AgyStepUpdatePayload }).step_update;
          if (!update) return;

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

          if (update.usage) applyUsage(output, update.usage);
        } else if (event.event === "result") {
          const terminal = event as AgyResultEvent;
          const usage = terminal.result?.usage ?? terminal.data?.usage ?? terminal.usage;
          if (usage && typeof usage === "object") applyUsage(output, usage as Record<string, unknown>);

        }
      };

      // Early init is retained by the process; no event replay is required.
      // A replacement may initialize, but cannot execute while its predecessor lives.
      const preparedPrompt = async () => {
        await replacementClosed;
        const prepared = await prompt();
        await proc!.ready;
        bindInit();
        return prepared;
      };

      // Execute the turn
      const result = await proc.runTurn(preparedPrompt, handleEvent, options?.signal, () => {
        if (state.process === proc) state.bootstrapEstablished = payloadMatchesProjection;
      });
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

      const stopReason = result.data?.stop_reason || result.result?.stop_reason;
      if (stopReason) {
        output.rawStopReason = stopReason;
        if (stopReason === "MAX_TOKENS") {
          // Pi also automatically compact-and-retries recoverable length stops.
          await retireSessionConversation(activeSid, options?.owner);
          throw new Error("AGY MAX_TOKENS: native work may be partial; review before retrying");
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

      if (state.process === proc) {
        if (payloadMatchesProjection) {
          state.projectionCheckpoint = projectionFingerprint([...submittedProjection!, ...projectContext({ messages: [output] })]);
          state.canResume = !proc.isBusy();
        } else {
          // An intentional payload override is supported, but its native history
          // cannot prove that the unmodified Pi projection was represented.
          void retireSessionConversation(activeSid, options?.owner);
        }
      }
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
          (error.name === "AbortError" || error.message === "Request was aborted"));

      // Pi 0.87.1 has no non-retryable error flag. Abort automatic continuation
      // for autonomous subprocess failures; keep diagnostics without replaying work.
      output.stopReason = "aborted";
      output.rawStopReason = isAborted ? "cancelled" : "agy_execution_failed";
      output.errorMessage = isAborted ? "Request was aborted" : sanitizeDiagnostic(
        `AGY execution stopped; automatic replay disabled. ${error instanceof Error ? error.message : String(error)}`);

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
