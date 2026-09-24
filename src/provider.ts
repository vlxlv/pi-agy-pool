import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "./stream.ts";

export const DEFAULT_PROVIDER_NAME = "agy-pool";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8899";
export const API_IDENTIFIER = "agy-pool-api";

/**
 * Explicit model list verified against the local environment / Cloud Code PA gateway.
 */
export const VERIFIED_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (agy-pool)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (agy-pool)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

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
  const baseUrl =
    options.baseUrl || process.env.AGY_POOL_BASE_URL || DEFAULT_BASE_URL;
  const models = options.models || VERIFIED_MODELS;

  pi.registerProvider(providerName, {
    name: "agy-pool",
    baseUrl,
    apiKey: "none",
    authHeader: false,
    api: API_IDENTIFIER,
    models,
    streamSimple,
  });
}
