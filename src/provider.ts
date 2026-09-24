import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resetActiveProcesses, streamSimple } from "./stream.ts";

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

  // Use Pi session lifecycle hook for child process cleanup where supported
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", () => {
      resetActiveProcesses();
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
