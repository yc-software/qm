import type { Api, Model } from "@earendil-works/pi-ai";

export interface ModelEntry {
  id: string;
  name: string;
  fastMode: boolean;
  buttonLabel?: string;
  webui: boolean;
  base: boolean;
  auxiliary?: boolean;
  request?: { model: string; service_tier: "ultrafast" };
  clone?: {
    template: string;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];

    tiers?: ReadonlyArray<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
}

const GPT_56_CLONE = {
  template: "gpt-5.5",
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  thinkingLevelMap: { max: "max" },
} as const;

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      template: "claude-opus-4-8",
      thinkingLevelMap: { off: null },
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    fastMode: false,
    webui: true,
    base: true,
    clone: {
      template: "claude-fable-5",
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  { id: "claude-fable-5", name: "Claude Fable 5", fastMode: false, webui: true, base: true },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      template: "claude-opus-4-8",
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", fastMode: true, webui: true, base: true },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    fastMode: false,
    webui: true,
    base: true,
    clone: {
      template: "claude-opus-4-8",
      thinkingLevelMap: { off: null },
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", fastMode: false, webui: true, base: true },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    fastMode: false,
    webui: true,
    base: true,
    auxiliary: true,
    clone: {
      template: "claude-opus-4-8",
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    },
  },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", fastMode: false, webui: true, base: true },
  {
    id: "gpt-5.6-sol",
    buttonLabel: "5.6 Sol",
    name: "GPT-5.6 Sol",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      input: 4,
      output: 20,
      cacheWrite: 5,
      tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
    },
  },
  {
    id: "gpt-5.6-terra",
    buttonLabel: "5.6 Terra",
    name: "GPT-5.6 Terra",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      input: 2,
      output: 12,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
    },
  },
  {
    id: "gpt-5.6-luna",
    buttonLabel: "5.6 Luna",
    name: "GPT-5.6 Luna",
    fastMode: true,
    webui: true,
    base: true,
    auxiliary: true,
    clone: {
      ...GPT_56_CLONE,
      input: 0.2,
      output: 1.2,
      cacheWrite: 0.25,
      tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
    },
  },
  {
    id: "gpt-6-astra",
    buttonLabel: "Astra",
    name: "GPT-6 Astra",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      thinkingLevelMap: { ...GPT_56_CLONE.thinkingLevelMap, off: null },
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
  },
  {
    id: "gpt-6-astra-ultrafast",
    buttonLabel: "Astra Ultrafast",
    name: "GPT-6 Astra · Ultrafast (6× cost)",
    fastMode: false,
    webui: true,
    base: true,
    request: { model: "gpt-6-astra", service_tier: "ultrafast" },
    clone: {
      ...GPT_56_CLONE,
      thinkingLevelMap: { ...GPT_56_CLONE.thinkingLevelMap, off: null },
      input: 60,
      output: 300,
      cacheRead: 6,
      cacheWrite: 75,
      tiers: [{ inputTokensAbove: 272_000, input: 120, output: 450, cacheRead: 12, cacheWrite: 150 }],
    },
  },
  {
    id: "gpt-6.1-sol",
    buttonLabel: "6.1 Sol",
    name: "GPT-6.1 Sol",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      thinkingLevelMap: { off: null, minimal: null, max: "max" },
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
  },
  {
    id: "gpt-6.1-sol-ultrafast",
    buttonLabel: "6.1 Sol Ultrafast",
    name: "GPT-6.1 Sol · Ultrafast (6× cost)",
    fastMode: false,
    webui: true,
    base: true,
    request: { model: "gpt-6.1-sol", service_tier: "ultrafast" },
    clone: {
      ...GPT_56_CLONE,
      thinkingLevelMap: { off: null, minimal: null, max: "max" },
      input: 12,
      output: 60,
      cacheRead: 0.6,
      cacheWrite: 15,
      tiers: [{ inputTokensAbove: 272_000, input: 24, output: 90, cacheRead: 1.2, cacheWrite: 30 }],
    },
  },
  {
    id: "gpt-6.1-terra",
    buttonLabel: "6.1 Terra",
    name: "GPT-6.1 Terra",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      input: 1,
      output: 5,
      cacheRead: 0.05,
      cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
    },
  },
  {
    id: "gpt-6-sol",
    buttonLabel: "6 Sol",
    name: "GPT-6 Sol",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
    },
  },
  {
    id: "gpt-6-luna",
    buttonLabel: "6 Luna",
    name: "GPT-6 Luna",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      ...GPT_56_CLONE,
      input: 0.1,
      output: 0.5,
      cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
    },
  },
  { id: "openrouter/auto", name: "OpenRouter Auto", fastMode: false, webui: true, base: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", fastMode: false, webui: false, base: false },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", fastMode: false, webui: false, base: false },
];
