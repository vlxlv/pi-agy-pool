import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PROVIDER_NAME = "agy-pool";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8899";
export const API_IDENTIFIER = "agy-pool-api";

/**
 * Curated static model catalog for V0.1.1 based on Cloud Code PA
 * /v1internal:fetchAvailableModels discovery and Pi end-to-end smoke verification.
 *
 * Source limits:
 * - Google Gemini 3.6 / 3.5 / 3 / 2.5: contextWindow = 1,048,576 tokens, maxTokens = 65,535-65,536 tokens.
 * - Anthropic Claude 4.6 (Sonnet / Opus): contextWindow = 250,000 tokens, maxTokens = 64,000 tokens.
 * - OpenAI GPT-OSS 120B: contextWindow = 131,072 tokens, maxTokens = 32,768 tokens.
 *
 * Cost: Set to 0 because upstream generation is billed/quota-managed by agy-pool-go
 * rather than direct per-token API billing.
 */
export const MODELS: ProviderModelConfig[] = [
  // Current Gemini Flash (3.6) - Default native agent family
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash (Low)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // Current Gemini Pro (3.1) - Native Pro agent family
  {
    id: "gemini-pro-agent",
    name: "Gemini 3.1 Pro (High)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },

  // Utility & Fast Flash Models
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // Anthropic Claude Models (via Cloud Code PA)
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250000,
    maxTokens: 64000,
  },

  // OpenAI / OSS Models (via Cloud Code PA)
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  },

  // Legacy Compatibility (passes smoke test; internally aliased to Gemini 3.5 Flash Lite)
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
];

/**
 * Backward compatibility alias for V0.1
 */
export const VERIFIED_MODELS = MODELS;
