import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import {
  defaultInteractiveThinkingLevel,
  modelSupportsAdaptiveThinking,
  modelSupportsProviderDefault,
} from "../model/pi-models.ts";

const TURN_EFFORT_LEVELS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "auto",
  "default",
  "adaptive",
]);

export function applyTurnEffort(session: AgentSession, level?: string): void {
  if (!level || !TURN_EFFORT_LEVELS.has(level)) return;
  if (level === "adaptive" || level === "default") {
    session.setThinkingLevel("off");
    return;
  }
  const effectiveLevel =
    level === "auto" && session.state.model ? defaultInteractiveThinkingLevel(session.state.model) : level;
  const normalizedLevel = effectiveLevel === "auto" ? "medium" : effectiveLevel;
  const providerLevel = normalizedLevel === "ultracode" ? "max" : normalizedLevel;
  session.setThinkingLevel(providerLevel as ModelThinkingLevel);
}

export function applyReasoningMode<T>(payload: T, model: Model<Api>, level?: string): T {
  if (level !== "adaptive" && level !== "default") return payload;
  if (level === "adaptive" ? !modelSupportsAdaptiveThinking(model) : !modelSupportsProviderDefault(model))
    throw new NonRetryableTurnError(`${level} reasoning is not supported by ${model.id}`);
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  delete body.thinking;
  delete body.reasoning;
  delete body.reasoning_effort;
  if (body.output_config && typeof body.output_config === "object") {
    const outputConfig = { ...body.output_config } as Record<string, unknown>;
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    else delete body.output_config;
  }
  if (model.reasoning && ["openai-responses", "openai-codex-responses"].includes(model.api))
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
  if (level === "adaptive") body.thinking = { type: "adaptive", display: "summarized" };
  return payload;
}
