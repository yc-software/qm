import type { ModelMetadata } from "../src/pi-models.ts";

export function metadata(id: string, name = id, provider = "openai"): ModelMetadata {
  return {
    id,
    name,
    label: name,
    buttonLabel: name,
    provider,
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 98765,
    maxTokens: 4321,
    cost: { input: 7, output: 17, cacheRead: 0.2, cacheWrite: 9 },
    fastMode: false,
  };
}
