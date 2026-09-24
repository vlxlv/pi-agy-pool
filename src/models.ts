import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PROVIDER_NAME = "agy-pool";
export const API_IDENTIFIER = "agy-pool-api";

/**
 * Primary model catalog matching native Antigravity Switch Model UI.
 *
 * All models are routed through official AGY headless via `agy-pool run --`.
 * Multi-account scheduling, OAuth, and quota management are owned by agy-pool-go.
 *
 * Context & Token limits:
 * - Gemini 3.8 / 3.7 / 3.6 Flash: contextWindow = 1,048,576, maxTokens = 65,536
 * - Gemini 3.1 Pro: contextWindow = 1,048,576, maxTokens = 65,535
 * - Claude Sonnet / Opus 4.6 (Thinking): contextWindow = 250,000, maxTokens = 64,000
 * - GPT-OSS 120B (Medium): contextWindow = 131,072, maxTokens = 32,768
 *
 * Cost: Set to 0 because upstream generation is billed/quota-managed by agy-pool-go.
 */
export const MODELS: ProviderModelConfig[] = [
  // Gemini 3.8 Flash (Current default agent model)
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // Gemini 3.7 Flash
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // Gemini 3.6 Flash
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // Gemini 3.1 Pro
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },

  // Claude Sonnet 4.6 (Thinking)
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250000,
    maxTokens: 64000,
  },

  // Claude Opus 4.6 (Thinking)
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250000,
    maxTokens: 64000,
  },

  // GPT-OSS 120B (Medium)
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  },
];

export const VERIFIED_MODELS = MODELS;
