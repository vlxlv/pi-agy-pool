import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  markSessionCompacted,
  releaseProviderProcesses,
  retireSessionConversation,
  streamSimple,
} from "./stream.ts";

import {
  API_IDENTIFIER,
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_NAME,
  MODELS,
  VERIFIED_MODELS,
} from "./models.ts";

export {
  API_IDENTIFIER,
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_NAME,
  MODELS,
  VERIFIED_MODELS,
};

export interface AgyPoolProviderOptions {
  name?: string;
  baseUrl?: string;
  models?: ProviderModelConfig[];
}

/**
 * Register the agy-pool provider with the Pi extension runtime.
 */
export function registerAgyPoolProvider(
  pi: ExtensionAPI,
  options: AgyPoolProviderOptions = {},
): void {
  const providerName = options.name || DEFAULT_PROVIDER_NAME;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const models = options.models || VERIFIED_MODELS;

  // This binding belongs to this extension instance, never to the module/process.
  type Binding = {
    readonly sessionId: string;
    readonly ui: ExtensionUIContext;
    readonly context: ExtensionContext;
    live: boolean;
    requests: Map<symbol, string | undefined>;
  };
  let binding: Binding | undefined;
  let sessionContext: ExtensionContext | undefined;
  const sessionOwner = Symbol("agy-session-owner");
  const requests = new Set<AbortController>();
  const invalidateProgress = (sessionId?: string) => {
    if (!binding || (sessionId && binding.sessionId !== sessionId)) return;
    const old = binding;
    binding = undefined;
    old.live = false;
    old.requests.clear();
    old.ui.setStatus("agy-pool", undefined);
  };
  const bindProgress = (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (ctx.mode !== "tui") {
      invalidateProgress();
      return;
    }
    if (binding?.live && binding.sessionId === sessionId && binding.ui === ctx.ui) return;
    invalidateProgress();
    binding = { sessionId, ui: ctx.ui, context: ctx, live: true, requests: new Map() };
  };

  // Use Pi session lifecycle hooks for child process cleanup, progress reporting, and compaction
  if (typeof pi.on === "function") {
    pi.on("session_start", (event, ctx) => {
      sessionContext = ctx;
      invalidateProgress();
      bindProgress(event, ctx);
    });
    // Rebind after a cancelled switch/fork or tree navigation. Existing tokens
    // remain invalid; only requests started after this boundary can use the UI.
    pi.on("turn_start", (_event, ctx: ExtensionContext) => {
      bindProgress(_event, ctx);
      sessionContext = ctx;
    });

    pi.on("before_provider_request", (_event, ctx: ExtensionContext) => {
      sessionContext = ctx;
    });

    pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
      const sid = ctx.sessionManager.getSessionId();
      return markSessionCompacted(sid, sessionOwner);
    });

    pi.on("session_before_switch", (_event, ctx: ExtensionContext) => {
      const sid = ctx.sessionManager.getSessionId();
      invalidateProgress(sid);
    });

    pi.on("session_before_fork", (_event, ctx: ExtensionContext) => {
      invalidateProgress(ctx.sessionManager.getSessionId());
    });

    pi.on("session_tree", (_event, ctx: ExtensionContext) => {
      const sid = ctx.sessionManager.getSessionId();
      const closed = retireSessionConversation(sid, sessionOwner);
      invalidateProgress(sid);
      return closed;
    });

    pi.on("session_shutdown", (_event, ctx?: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.();
      for (const request of requests) request.abort();
      const closed = releaseProviderProcesses(sessionOwner);
      sessionContext = undefined;
      invalidateProgress(sid);
      return closed;
    });
  }

  pi.registerProvider(providerName, {
    name: "agy-pool",
    apiKey: "none",
    authHeader: false,
    api: API_IDENTIFIER,
    baseUrl,
    models,
    streamSimple(model, context, streamOptions) {
      // Only this live runner may use its session ownership. Transcript IDs and
      // old receipts never authorize native resume, including after reload.
      let bound = false;
      let cwd: string | undefined;
      try {
        bound = Boolean(streamOptions?.sessionId &&
          sessionContext?.sessionManager.getSessionId() === streamOptions.sessionId);
        if (bound) cwd = sessionContext!.cwd;
      } catch { bound = false; cwd = undefined; /* Disposed runners use isolated ownership. */ }
      const controller = new AbortController();
      requests.add(controller);
      const signal = streamOptions?.signal ? AbortSignal.any([streamOptions.signal, controller.signal]) : controller.signal;
      const owner = binding;
      const token = Symbol("agy-request");
      const ownsUI = owner?.live && streamOptions?.sessionId === owner.sessionId && !streamOptions?.signal?.aborted;
      // Newest request owns the row until it settles, even while streaming text.
      // An older request may continue, but cannot overwrite or clear that row.
      if (ownsUI) owner.requests.set(token, undefined);
      const render = () => {
        if (ownsUI && owner.live) {
          try {
            // Pi's context getters reject invalidated runners. Never route to a
            // replacement UI, even if a host disposes/rebinds without a hook.
            if (owner.context.mode !== "tui" || owner.context.ui !== owner.ui ||
                owner.context.sessionManager.getSessionId() !== owner.sessionId) {
              owner.live = false;
              owner.requests.clear();
              return;
            }
            owner.ui.setStatus("agy-pool", [...owner.requests.values()].at(-1));
          } catch {
            // A disposed UI must not reject stream completion or interrupt AGY.
            owner.live = false;
            owner.requests.clear();
          }
        }
      };
      const finish = () => {
        requests.delete(controller);
        streamOptions?.signal?.removeEventListener("abort", finish);
        if (ownsUI && owner.live && owner.requests.delete(token)) render();
      };
      streamOptions?.signal?.addEventListener("abort", finish, { once: true });
      try {
        const result = streamSimple(model, context, {
          ...streamOptions,
          cwd: cwd ?? (streamOptions as { cwd?: string } | undefined)?.cwd,
          owner: sessionOwner,
          ephemeral: !bound,
          signal,
          onProgress(message) {
            if (!ownsUI || !owner.live || !owner.requests.has(token)) return;
            owner.requests.set(token, message);
            if ([...owner.requests.keys()].at(-1) === token) render();
          },
        });
        void result.result().then(finish, finish);
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    },
  });
}
