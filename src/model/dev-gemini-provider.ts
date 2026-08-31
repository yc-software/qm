import type { CustomProviderSpec } from "./custom-providers.ts";

export const DEV_GEMINI_PROVIDER_ID = "google-gemini-dev";
export const DEV_GEMINI_MODEL = "gemini-3.7-flash";
export const DEV_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEV_GEMINI_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
export const DEV_GEMINI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
} as const;

export interface DevGeminiProvider {
  spec: CustomProviderSpec;
  apiKey: string;
}

export function takeDevGeminiApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const apiKey = env.GEMINI_API_KEY;
  delete env.GEMINI_API_KEY;
  return apiKey;
}

export function resolveDevGeminiApiKey(current: string | undefined, supplied: unknown): string | undefined {
  return typeof supplied === "string" && supplied.trim() ? supplied : current;
}

export function normalizeDevGeminiPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const normalized = structuredClone(payload) as Record<string, unknown>;
  delete normalized.store;
  delete normalized.stream_options;
  if (normalized.max_completion_tokens !== undefined && normalized.max_tokens === undefined) {
    normalized.max_tokens = normalized.max_completion_tokens;
  }
  delete normalized.max_completion_tokens;
  if (!Array.isArray(normalized.messages)) return normalized;
  for (const value of normalized.messages) {
    const message = value as { role?: unknown; tool_calls?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const value of message.tool_calls) {
      if (!value || typeof value !== "object") continue;
      const toolCall = value as { extra_content?: { google?: { thought_signature?: unknown } } };
      const google = toolCall.extra_content?.google;
      if (typeof google?.thought_signature === "string" && google.thought_signature) continue;
      toolCall.extra_content = {
        ...toolCall.extra_content,
        google: { ...google, thought_signature: DEV_GEMINI_THOUGHT_SIGNATURE },
      };
    }
  }
  return normalized;
}

export function normalizeConfiguredDevGeminiPayload(
  payload: unknown,
  payloadProvider: unknown,
  configuredProviderId: string | undefined,
): unknown {
  return configuredProviderId && payloadProvider === configuredProviderId
    ? normalizeDevGeminiPayload(payload)
    : payload;
}

export function devGeminiProviderFromEnv(env: NodeJS.ProcessEnv): DevGeminiProvider | undefined {
  const enabled = env.DEV_INSTANCE_GEMINI_PROVIDER?.trim();
  if (!enabled) return undefined;
  if (enabled !== "1") throw new Error('DEV_INSTANCE_GEMINI_PROVIDER must be "1" or unset');
  if (env.NODE_ENV === "production") throw new Error("DEV_INSTANCE_GEMINI_PROVIDER is forbidden in production");
  if (env.HARNESS?.trim() !== "pi") throw new Error("DEV_INSTANCE_GEMINI_PROVIDER requires HARNESS=pi");
  if (env.MODEL_PROVIDER?.trim())
    throw new Error("DEV_INSTANCE_GEMINI_PROVIDER cannot be combined with MODEL_PROVIDER");

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("DEV_INSTANCE_GEMINI_PROVIDER requires GEMINI_API_KEY");

  const baseUrl = env.GEMINI_BASE_URL?.trim().replace(/\/+$/, "") || DEV_GEMINI_BASE_URL;
  if (baseUrl !== DEV_GEMINI_BASE_URL) {
    throw new Error(`GEMINI_BASE_URL must be ${DEV_GEMINI_BASE_URL}`);
  }

  const model = env.GEMINI_MODEL?.trim() || DEV_GEMINI_MODEL;
  if (model !== DEV_GEMINI_MODEL) throw new Error(`GEMINI_MODEL must be ${DEV_GEMINI_MODEL}`);
  for (const name of ["PI_MODEL", "PI_DETECT_MODEL", "PI_TITLE_MODEL", "PI_JUDGE_MODEL"] as const) {
    const value = env[name]?.trim();
    if (value && value !== DEV_GEMINI_MODEL) throw new Error(`${name} must be ${DEV_GEMINI_MODEL}`);
  }

  return {
    apiKey,
    spec: {
      id: DEV_GEMINI_PROVIDER_ID,
      name: "Google Gemini (dev)",
      protocol: "openai",
      baseUrl,
      models: [
        {
          id: model,
          name: "Gemini 3.7 Flash",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          input: 0.75,
          output: 3.75,
          compat: DEV_GEMINI_COMPAT,
        },
      ],
    },
  };
}
