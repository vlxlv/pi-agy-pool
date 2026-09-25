import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  resetActiveProcesses,
  setActiveProgressCallback,
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

  // Use Pi session lifecycle hooks for child process cleanup and progress reporting
  if (typeof pi.on === "function") {
    let currentUI: ExtensionUIContext | undefined;

    pi.on("turn_start", (_event, ctx: ExtensionContext) => {
      currentUI = ctx?.ui;
    });

    pi.on("before_provider_request", (_event, ctx: ExtensionContext) => {
      currentUI = ctx?.ui;
    });

    pi.on("turn_end", (_event, ctx: ExtensionContext) => {
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(undefined);
      }
      currentUI = undefined;
    });

    pi.on("session_shutdown", (_event, ctx?: ExtensionContext) => {
      resetActiveProcesses();
      if (typeof ctx?.ui?.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(undefined);
      }
      currentUI = undefined;
      setActiveProgressCallback(undefined);
    });

    setActiveProgressCallback((message?: string) => {
      if (currentUI && typeof currentUI.setWorkingMessage === "function") {
        currentUI.setWorkingMessage(message);
      }
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
