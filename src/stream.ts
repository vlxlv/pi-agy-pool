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
import type { AgyEvent, AgyInitEvent, AgyStepUpdatePayload } from "./agy-events.ts";
import type { spawn } from "node:child_process";

// ponytail: in-memory conversation map per process, external persistence/daemon handled by agy-pool-go
export const activeProcesses = new Map<string, AgyProcess>();

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

export interface SessionCompactionState {
  sessionId: string;
  needsBootstrap: boolean;
  activeConversationId?: string;
  retiredConversationIds: Set<string>;
}

export const sessionStates = new Map<string, SessionCompactionState>();
export const conversationToSession = new Map<string, string>();
export const retiredConversationIds = new Set<string>();
export const validPostCompactionConversations = new Set<string>();

let currentSessionId: string | undefined;

export function setCurrentSessionId(sessionId?: string): void {
  currentSessionId = sessionId;
}

export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}

export function getSessionState(sessionId: string): SessionCompactionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      needsBootstrap: false,
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
export function retireSessionConversation(sessionId: string): void {
  const state = getSessionState(sessionId);
  state.needsBootstrap = true;

  if (state.activeConversationId) {
    const oldConvId = state.activeConversationId;
    state.retiredConversationIds.add(oldConvId);
    retiredConversationIds.add(oldConvId);
    validPostCompactionConversations.delete(oldConvId);

    const proc = activeProcesses.get(oldConvId);
    if (proc) {
      if (!proc.isBusy()) {
        proc.kill();
        activeProcesses.delete(oldConvId);
      } else {
        // Safe retirement: child is executing a turn; terminate once settled
        proc.once("result", () => {
          proc.kill();
          activeProcesses.delete(oldConvId);
        });
      }
    } else {
      activeProcesses.delete(oldConvId);
    }

    state.activeConversationId = undefined;
  }
}

/**
 * Authoritative compaction notification for a session.
 */
export function markSessionCompacted(sessionId: string): void {
  retireSessionConversation(sessionId);
}

let shutdownHooksRegistered = false;

/**
 * Clear all active processes and session tracking. Used for test teardown and shutdown.
 */
export function resetActiveProcesses(): void {
  for (const proc of activeProcesses.values()) {
    proc.kill();
  }
  activeProcesses.clear();
  sessionStates.clear();
  conversationToSession.clear();
  retiredConversationIds.clear();
  validPostCompactionConversations.clear();
  currentSessionId = undefined;
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

  const sid = options?.sessionId ?? currentSessionId;
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

let globalProgressCallback: AgyProgressCallback | undefined;

export function setActiveProgressCallback(callback?: AgyProgressCallback): void {
  globalProgressCallback = callback;
}

export function getActiveProgressCallback(): AgyProgressCallback | undefined {
  return globalProgressCallback;
}

export function formatToolProgress(toolName?: string): string {
  if (!toolName) {
    return "AGY: Running tool…";
  }
  const normalized = toolName.toLowerCase().replace(/[-_]/g, "");
  switch (normalized) {
    case "viewfile":
    case "readfile":
    case "read":
      return "AGY: Reading file…";
    case "runcommand":
    case "bash":
    case "terminal":
    case "shell":
      return "AGY: Running command…";
    case "searchweb":
    case "websearch":
      return "AGY: Searching…";
    case "codesearch":
    case "searchcode":
    case "grep":
    case "find":
      return "AGY: Searching code…";
    case "editfile":
    case "replacefilecontent":
    case "edit":
      return "AGY: Editing file…";
    case "writetofile":
    case "writefile":
    case "write":
      return "AGY: Writing file…";
    case "listdir":
    case "listdirectory":
    case "directoryanalysis":
      return "AGY: Inspecting directory…";
    case "invokesubagent":
      return "AGY: Running subagent…";
    default:
      return `AGY: Running ${toolName}…`;
  }
}

export function formatSubagentProgress(info?: { subagents?: Array<{ role?: string; type_name?: string }> }): string {
  const first = info?.subagents?.[0];
  const role = typeof first?.role === "string" ? first.role.trim() : "";
  const typeName = typeof first?.type_name === "string" ? first.type_name.trim() : "";

  const candidate = role || typeName;
  if (candidate) {
    const clean = candidate.replace(/[^\w\s-]/g, "").slice(0, 30).trim();
    if (clean) {
      if (clean.toLowerCase().includes("subagent")) {
        return `AGY: ${clean}…`;
      }
      return `AGY: ${clean} subagent…`;
    }
  }
  return "AGY: Running subagent…";
}

export function classifyAgyProgress(
  update: AgyStepUpdatePayload,
): string | undefined {
  const stepType = update.step_type;

  if (stepType === "tool") {
    const toolName = update.tool_name || update.tool_info?.name;
    if (update.state === "ACTIVE") {
      return formatToolProgress(toolName);
    }
    if (update.state === "DONE") {
      return "AGY: Working…";
    }
    return formatToolProgress(toolName);
  }

  if (stepType === "subagent") {
    return formatSubagentProgress(update.subagent_info);
  }

  if (stepType === "agent_response") {
    if (!update.text_delta) {
      return "AGY: Working…";
    }
    return undefined;
  }

  return undefined;
}

export interface ExtendedStreamOptions extends SimpleStreamOptions {
  spawnFn?: typeof spawn;
  bin?: string;
  onProgress?: AgyProgressCallback;
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

  const rawReportProgress: AgyProgressCallback =
    options?.onProgress ?? globalProgressCallback ?? (() => {});

  let currentWorkingMessage: string | undefined;
  const setProgress = (msg?: string) => {
    if (msg !== currentWorkingMessage) {
      currentWorkingMessage = msg;
      try {
        rawReportProgress(msg);
      } catch {
        // Safe no-op on handler errors
      }
    }
  };

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
    let boundConversationId: string | undefined;

    try {
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const activeSid = options?.sessionId ?? currentSessionId;
      const sessionState = activeSid ? getSessionState(activeSid) : undefined;

      const compaction = detectCompaction(context);
      let isBootstrapTurn = Boolean(sessionState?.needsBootstrap);

      if (!isBootstrapTurn && compaction.hasCompaction) {
        const existingConvId = findConversationId(context, {
          sessionId: activeSid,
        });
        if (!existingConvId) {
          isBootstrapTurn = true;
        }
      }

      if (isBootstrapTurn && activeSid && sessionState?.activeConversationId) {
        retireSessionConversation(activeSid);
      }

      const conversationId = isBootstrapTurn
        ? undefined
        : findConversationId(context, { sessionId: activeSid });

      let isResumed = false;
      const effort = resolveEffort(model.id, options);

      if (conversationId) {
        const existing = activeProcesses.get(conversationId);
        if (existing && existing.isAlive()) {
          if (existing.modelId === model.id && existing.effort === effort) {
            proc = existing;
            boundConversationId = conversationId;
            output.responseId = conversationId;
            (output as unknown as Record<string, unknown>).conversationId = conversationId;
            isResumed = true;
          } else {
            // Model or effort changed: do not silently reuse mismatched process configuration.
            // Terminate old process; conversation continuity is preserved via --conversation <id>.
            existing.kill();
            activeProcesses.delete(conversationId);
          }
        } else if (existing) {
          activeProcesses.delete(conversationId);
        }
      }

      if (!proc) {
        proc = new AgyProcess({
          modelId: model.id,
          effort,
          conversationId,
          bin: options?.bin,
          spawnFn: options?.spawnFn,
        });
        isResumed = Boolean(conversationId);
      }

      let prompt = buildTurnPrompt(context, isResumed);

      if (options?.onPayload) {
        const turnPayload = {
          event: "user",
          message: { content: prompt },
        };
        const replacement = await options.onPayload(turnPayload, model);
        if (
          replacement &&
          typeof replacement === "object" &&
          "message" in replacement &&
          (replacement as { message?: { content?: string } }).message?.content
        ) {
          prompt = (replacement as { message: { content: string } }).message.content;
        }
      }

      let startedEmitted = false;

      const handleEvent = (event: AgyEvent) => {
        if (event.event === "init") {
          const init = event as AgyInitEvent;
          boundConversationId = init.conversation_id;
          output.responseId = init.conversation_id;
          (output as unknown as Record<string, unknown>).conversationId = init.conversation_id;
          if (init.conversation_id && proc) {
            const alreadyBound = activeProcesses.get(init.conversation_id) === proc;
            activeProcesses.set(init.conversation_id, proc);
            validPostCompactionConversations.add(init.conversation_id);
            if (activeSid) {
              const sState = getSessionState(activeSid);
              sState.activeConversationId = init.conversation_id;
              sState.needsBootstrap = false;
              conversationToSession.set(init.conversation_id, activeSid);
            }
            if (!alreadyBound) {
              proc.once("exit", () => {
                if (boundConversationId) {
                  activeProcesses.delete(boundConversationId);
                }
              });
            }
          }
          if (!startedEmitted) {
            startedEmitted = true;
            stream.push({ type: "start", partial: output });
          }
          setProgress("AGY: Working…");
          if (options?.onResponse) {
            void options.onResponse({ status: 200, headers: {} }, model);
          }
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
            setProgress(undefined);
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
            const progress = classifyAgyProgress(update);
            if (progress) {
              setProgress(progress);
            }
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

      // Execute the turn
      const result = await proc.runTurn(prompt, handleEvent, options?.signal);
      setProgress(undefined);

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

      const finalReason =
        output.stopReason === "stop" || output.stopReason === "length"
          ? output.stopReason
          : "stop";
      stream.push({ type: "done", reason: finalReason, message: output });
      stream.end();
    } catch (error) {
      setProgress(undefined);
      if (boundConversationId) {
        activeProcesses.delete(boundConversationId);
      }
      if (proc) {
        proc.abort().catch(() => {});
      }

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
      setProgress(undefined);
    }
  })();

  return stream;
}
