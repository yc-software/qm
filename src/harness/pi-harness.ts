import { baseModelProviders, configuredModel, CONFIG_DEFAULTS, type Config } from "../config.ts";
import { auxiliaryModelFor, defaultModel } from "../model/pi-models.ts";
import { type ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import { defineHarness, type Harness } from "./harness.ts";
import { coreToolOptions, type CoreToolOptions } from "./agent-tools.ts";
import { type RunSignalStore } from "../runs/run-signal-store.ts";
import { type ProviderKeys, resolveConfiguredModelId } from "./pi-model-runtime.ts";
import { runPiTurn, type PiTurnOptions } from "./pi-run-turn.ts";
import { createPiModelAccess } from "./pi-model-access.ts";
import {
  piShouldRespond,
  piCompactHistory,
  piContextTokenBudget,
  piOneShot,
  piJudge,
  piScreenSecurity,
  piPickAckEmoji,
  piGenerateTitle,
  piSummarizeApproval,
} from "./pi-side-calls.ts";

export interface PiHarnessOptions extends CoreToolOptions {
  defaultModelId?: string;
  resolveBaseModelId?: () => string | undefined;
  resolveFallbackRuntime?: () => { modelId: string; effortLevel?: string; fastMode?: boolean } | undefined;
  companyModelId?: (id: string) => string;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  apiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelGateway?: ModelGatewayTransportConfig;
  resolveProviderKeys?: () => Promise<ProviderKeys>;
  tempDirPrefix?: string;
  captureRequests?: boolean;
  turnWallClockMs?: number;
  signals?: RunSignalStore;
}

export function piHarnessConfigOptions(config: Config): PiHarnessOptions {
  const defaultModelId =
    configuredModel(config) ?? (config.modelProvider ? defaultModel(undefined, baseModelProviders(config)) : undefined);
  return {
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(config.detectModelId ? { detectModelId: config.detectModelId } : {}),
    ...(config.titleModelId ? { titleModelId: config.titleModelId } : {}),
    ...(config.judgeModelId ? { judgeModelId: config.judgeModelId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...(config.openrouterApiKey ? { openrouterApiKey: config.openrouterApiKey } : {}),
    ...(config.modelGateway ? { modelGateway: config.modelGateway } : {}),
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export { modelSupportsFastMode } from "../model/pi-models.ts";

export function createPiHarness(opts?: PiHarnessOptions): Harness {
  const access = createPiModelAccess(opts);
  const primaryModelId = (): string => resolveConfiguredModelId(undefined, opts?.defaultModelId);
  const auxiliaryModelId = (): string =>
    auxiliaryModelFor(resolveConfiguredModelId(opts?.resolveBaseModelId?.(), opts?.defaultModelId));
  const detectModelId = (): string => opts?.detectModelId ?? auxiliaryModelId();
  const titleModelId = (): string => opts?.titleModelId ?? auxiliaryModelId();
  const judgeModelId = (): string => opts?.judgeModelId ?? auxiliaryModelId();
  const resolveFallbackRuntime = () => opts?.resolveFallbackRuntime?.();
  const turnOptions: PiTurnOptions = {
    access,
    primaryModelId,
    toolOptions: opts,
    tempDirPrefix: opts?.tempDirPrefix ?? "pi",
    captureRequests: opts?.captureRequests ?? true,
    turnWallClockMs: opts?.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000,
    signals: opts?.signals,
    resolveFallbackRuntime,
  };
  return defineHarness({
    runTurn: (turn) => runPiTurn(turnOptions, turn),
    shouldRespond: (detect) => piShouldRespond(access, detectModelId, detect),
    compactHistory: (input) => piCompactHistory(access, primaryModelId, () => resolveFallbackRuntime()?.modelId, input),
    contextTokenBudget: (_scopeLabel, model) => piContextTokenBudget(primaryModelId, model),
    oneShot: (systemPrompt, prompt) => piOneShot(access, primaryModelId, systemPrompt, prompt),
    judge: (systemPrompt, prompt, signal) => piJudge(access, judgeModelId, systemPrompt, prompt, signal),
    screenSecurity: (input) => piScreenSecurity(access, detectModelId, input),
    pickAckEmoji: (text, candidates) => piPickAckEmoji(access, text, candidates),
    generateTitle: (transcript) => piGenerateTitle(access, titleModelId, transcript),
    summarizeApproval: (command, reason, purpose) =>
      piSummarizeApproval(access, titleModelId, command, reason, purpose),
  });
}
