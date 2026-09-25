import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  markSessionCompacted,
  resetActiveProcesses,
  retireSessionConversation,
  setActiveProgressCallback,
  setCurrentSessionId,
  setSessionProgressCallback,
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

  // Use Pi session lifecycle hooks for child process cleanup, progress reporting, and compaction
  if (typeof pi.on === "function") {
    pi.on("turn_start", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      setCurrentSessionId(sid);
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        setSessionProgressCallback(sid, (message?: string) => {
          ctx.ui.setWorkingMessage(message);
        });
      }
    });

    pi.on("before_provider_request", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      setCurrentSessionId(sid);
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        setSessionProgressCallback(sid, (message?: string) => {
          ctx.ui.setWorkingMessage(message);
        });
      }
    });

    pi.on("turn_end", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(undefined);
      }
      setSessionProgressCallback(sid, undefined);
    });

    pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      markSessionCompacted(sid);
    });

    pi.on("session_before_switch", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      retireSessionConversation(sid);
      setSessionProgressCallback(sid, undefined);
    });

    pi.on("session_before_fork", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      retireSessionConversation(sid);
      setSessionProgressCallback(sid, undefined);
    });

    pi.on("session_tree", (_event, ctx: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.() || "default";
      retireSessionConversation(sid);
      setSessionProgressCallback(sid, undefined);
    });

    pi.on("session_shutdown", (_event, ctx?: ExtensionContext) => {
      const sid = ctx?.sessionManager?.getSessionId?.();
      if (sid) {
        retireSessionConversation(sid);
        setSessionProgressCallback(sid, undefined);
      } else {
        resetActiveProcesses();
      }
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(undefined);
      }
      setActiveProgressCallback(undefined);
    });
  }

  pi.registerProvider(providerName, {
    name: "agy-pool",
    apiKey: "none",
    authHeader: false,
    api: API_IDENTIFIER,
    baseUrl,
    models,
    streamSimple,
  });
}
