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

let shutdownHooksRegistered = false;

/**
 * Clear all active processes. Used for test teardown and shutdown.
 */
export function resetActiveProcesses(): void {
  for (const proc of activeProcesses.values()) {
    proc.kill();
  }
  activeProcesses.clear();
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

/**
 * Scan transcript backwards for an assistant message carrying the AGY conversation ID.
 */
export function findConversationId(context: TranscriptContext): string | undefined {
  if (!context?.messages) {
    return undefined;
  }
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.responseId) {
        return assistantMsg.responseId;
      }
      const raw = assistantMsg as unknown as Record<string, unknown>;
      if (typeof raw.conversationId === "string" && raw.conversationId) {
        return raw.conversationId;
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

  // Fresh conversation: prepend system message if present
  const systemTexts = messages
    .filter((m) => m.role === "system")
    .map((m) => contentText(m.content))
    .filter(Boolean);
  const systemPrompt = systemTexts.join("\n\n");

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

export interface ExtendedStreamOptions extends SimpleStreamOptions {
  spawnFn?: typeof spawn;
  bin?: string;
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

      const conversationId = findConversationId(context);
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
    }
  })();

  return stream;
}
