import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { CONFIG_DEFAULTS } from "../config.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { contextTokenBudgetForModel, DEFAULT_GROK_MODEL_ID, modelSupportedByHarness } from "../model/pi-models.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import { countTokens } from "../util/tokens.ts";
import { swallow } from "../util/errors.ts";
import { runGrokAcp, type GrokAcpResult } from "./grok-acp.ts";
import {
  authenticateGrokHome,
  createGrokTurnHome,
  DEFAULT_GROK_BINARY,
  resolveGrokBinary,
  scavengeGrokHomes,
  verifyGrokRuntime,
  type GrokRuntimeVerificationOptions,
} from "./grok-home.ts";
import { createGrokMcpBridge } from "./grok-mcp.ts";
import { startGrokProcess, type GrokProcessOptions } from "./grok-process.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { coreToolOptions, createPiTools, type PiToolsOptions, type ToolContextRef } from "./pi-tools.ts";
import { reconstructMessagesFromHistory, renderReplayTranscript, seedPriorTurns } from "./replay.ts";

export interface GrokHarnessOptions {
  binaryPath?: string;
  verifyRuntime?: boolean;
  verifyOnCreate?: boolean;
  verification?: GrokRuntimeVerificationOptions;
  env?: NodeJS.ProcessEnv;
  process?: Pick<GrokProcessOptions, "launcherPath" | "eofGraceMs" | "termGraceMs" | "killGraceMs">;
  setupTimeoutMs?: number;
  loginTimeoutMs?: number;
  turnWallClockMs?: number;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
  controlTools?: boolean;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  signals?: RunSignalStore;
}

interface ActiveTurn {
  abort(): void;
  done: Promise<void>;
}

function toolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenExternalContent: turn.screenExternalContent,
    toolApprovalGate: turn.toolApprovalGate,
    screenToolResult: turn.screenToolResult,
  };
}

function toolOptions(options: GrokHarnessOptions, turn: HarnessTurnInput): PiToolsOptions {
  return {
    scratchExec: options.scratchExec,
    ownerAuthExec: options.ownerAuthExec,
    reachExec: options.reachExec,
    ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
    controlTools: options.controlTools,
    execTimeoutMs: options.execTimeoutMs,
    execTimeoutCeilingMs: options.execTimeoutCeilingMs,
    backgroundJobTtlMs: options.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: options.backgroundJobTtlMaxMs,
    readOnly: turn.readOnly,
    surfaceTools: turn.surfaceTools,
    surfaceName: turn.surfaceName,
    credentialExecServices: turn.credentialExecServices,
  };
}

function promptText(turn: HarnessTurnInput): string {
  const replay = renderReplayTranscript(reconstructMessagesFromHistory(turn.history));
  const prior = turn.history.length
    ? ""
    : seedPriorTurns(turn.priorTurns ?? [])
        .map((message) => message.text)
        .join("\n");
  return [replay, prior, turn.input, turn.environment].filter((value) => value?.trim()).join("\n\n");
}

function promptBlocks(turn: HarnessTurnInput, text: string): ContentBlock[] {
  return [
    { type: "text", text },
    ...(turn.images ?? []).map((image) => ({
      type: "image" as const,
      data: image.dataBase64,
      mimeType: image.mimeType,
    })),
  ];
}

function usage(result: GrokAcpResult) {
  if (!result.usage) return null;
  return {
    input: result.usage.inputTokens,
    output: result.usage.outputTokens,
    cacheRead: result.usage.cachedReadTokens,
    cacheWrite: result.usage.cacheCreationTokens,
    totalTokens: result.usage.totalTokens,
    costUsd: result.usage.costUsdTicks / 10_000_000_000,
  };
}

export function grokHarnessConfigOptions(config: Parameters<typeof coreToolOptions>[0]): GrokHarnessOptions {
  return {
    ...(config.grokBinPath ? { binaryPath: config.grokBinPath } : {}),
    env: config.grokProcessEnv,
    ...(config.grokLauncherPath ? { process: { launcherPath: config.grokLauncherPath } } : {}),
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
    verifyOnCreate: config.harness === "grok",
  };
}

export function createGrokHarness(options: GrokHarnessOptions = {}): Harness {
  scavengeGrokHomes();
  let verifiedBinary: string | undefined;
  const binary = () =>
    (verifiedBinary ??=
      options.verifyRuntime === false
        ? resolveGrokBinary(options.binaryPath ?? DEFAULT_GROK_BINARY)
        : verifyGrokRuntime(
            options.binaryPath ?? DEFAULT_GROK_BINARY,
            options.verification,
            options.env,
            options.process?.launcherPath,
          ));
  if (options.verifyOnCreate) binary();
  const active = new Set<ActiveTurn>();
  const defaultTurnWallClockMs = options.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;

  const runTurn = async (turn: HarnessTurnInput): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    if (!turn.grokAuth?.accessToken) throw new NonRetryableTurnError("Connect a Grok subscription before using Grok");
    const model = modelSupportedByHarness(turn.model, "grok") ? turn.model! : DEFAULT_GROK_MODEL_ID;
    const controller = new AbortController();
    let doneResolve: (() => void) | undefined;
    const state: ActiveTurn = {
      abort: () => controller.abort(),
      done: new Promise<void>((resolve) => {
        doneResolve = resolve;
      }),
    };
    const ref = toolContext(turn);
    ref.abortSignal = controller.signal;
    const definitions = createPiTools(ref, toolOptions(options, turn)) as ToolDefinition[];
    let bridge: Awaited<ReturnType<typeof createGrokMcpBridge>> | undefined;
    let process: ReturnType<typeof startGrokProcess> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let stopped = false;
    let signalsStopped = false;
    const abort = () => {
      stopped = true;
      controller.abort();
    };
    const onCancel = () => abort();
    let stopSignals: ReturnType<typeof startSignalPoll> | undefined;
    const userEntry = await turn.emit({
      type: "user",
      payload: {
        text: turn.input,
        ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      },
      scopeLabel: turn.scopeLabel,
    });
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    const prompt = promptText(turn);
    const recordedEnvelope = {
      system: turn.systemPrompt,
      prompt: {
        text: prompt,
        images: (turn.images ?? []).map((image) => ({ mimeType: image.mimeType, artifactId: image.artifactId })),
      },
      tools: definitions.map((tool) => tool.name),
      cwd: "[ephemeral control jail]",
    };
    const home = createGrokTurnHome(model, options.env);
    active.add(state);
    if (turn.cancel) {
      turn.cancel.addEventListener("abort", onCancel, { once: true });
      if (turn.cancel.aborted) abort();
    }
    let result: GrokAcpResult | undefined;
    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    if (wallMs > 0)
      timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, wallMs);
    let turnResult: HarnessTurnResult | undefined;
    let turnFailure: { error: unknown } | undefined;
    let cleanupFailure: unknown;
    try {
      stopSignals =
        options.signals && turn.runId
          ? startSignalPoll(
              options.signals,
              turn.runId,
              { onAbort: async () => abort(), onSteer: async () => undefined },
              { onError: (error) => swallow("grok signal poll", error) },
            )
          : undefined;
      await authenticateGrokHome(
        binary(),
        home,
        turn.grokAuth.accessToken,
        options.process,
        options.loginTimeoutMs,
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error("Grok turn was cancelled during authentication");
      bridge = await createGrokMcpBridge(definitions, { signal: controller.signal, onTerminate: abort });
      process = startGrokProcess(binary(), ["agent", "stdio"], {
        cwd: home.workspace,
        env: home.env,
        ...options.process,
      });
      result = await runGrokAcp({
        process,
        cwd: home.workspace,
        systemPrompt: turn.systemPrompt,
        prompt: promptBlocks(turn, prompt),
        model,
        reasoningEffort: turn.thinkingLevel,
        bridge,
        signal: controller.signal,
        setupTimeoutMs: options.setupTimeoutMs,
        onDelta: turn.onDelta,
        onTextBlockStart: turn.onTextBlockStart,
        onProgress: turn.onProgress,
      });
      if (timedOut) throw new Error("Grok turn timed out");
      if (result.modelId && result.modelId !== model) throw new Error("Grok responded with an unexpected model");
      if (turn.cancel?.aborted) throw new Error("Grok turn was cancelled");
      for (const thinking of result.thoughts)
        await turn.emit({ type: "thinking", payload: { thinking }, scopeLabel: turn.scopeLabel });
      const terminal = ref.silentRequested || ref.pausedOnApproval;
      const reply = terminal ? "" : result.reply.trim();
      const wasStopped = stopped || result.stopReason !== "end_turn";
      if (reply)
        await turn.emit({
          type: "assistant",
          payload: { text: reply, ...(wasStopped ? { stopped: true } : {}) },
          scopeLabel: turn.scopeLabel,
        });
      if (!signalsStopped) {
        await stopSignals?.();
        signalsStopped = true;
      }
      turnResult = {
        reply,
        ...(wasStopped ? { stopped: true as const } : {}),
        ...(ref.silentRequested ? { silent: true } : {}),
        ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
        ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
        ...(result.usage ? { modelCalls: result.usage.modelCalls } : {}),
        ...(result.usage
          ? {
              cacheUsage: {
                cacheRead: result.usage.cachedReadTokens,
                cacheWrite: result.usage.cacheCreationTokens,
                uncachedInput: result.usage.inputTokens,
              },
            }
          : {}),
      };
    } catch (error) {
      if (timedOut) {
        const timeout = new NonRetryableTurnError(`Grok turn exceeded ${Math.round(wallMs / 1000)}s wall clock`);
        timeout.cause = error;
        turnFailure = { error: timeout };
      } else if (!controller.signal.aborted) turnFailure = { error };
      else turnResult = { reply: "", stopped: true };
    } finally {
      if (timer) clearTimeout(timer);
      turn.cancel?.removeEventListener("abort", onCancel);
      controller.abort();
      const cleanup = await Promise.allSettled([
        ...(!signalsStopped && stopSignals ? [stopSignals()] : []),
        ...(bridge ? [bridge.close()] : []),
        ...(process ? [process.stop()] : []),
      ]);
      cleanupFailure = cleanup.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason;
      try {
        home.cleanup();
      } catch (error) {
        cleanupFailure ??= error;
      }
      active.delete(state);
      doneResolve?.();
      const inputTokens = result?.usage?.inputTokens ?? countTokens(prompt);
      if (result) turn.recordModelCall({ model, inputTokens, entryCount: turn.history.length });
      try {
        await turn.recordLlmRequest?.({
          turnSeq: userEntry.seq,
          step: 0,
          model,
          promptEnvelope: recordedEnvelope,
          truncated: false,
          transport: { modelId: result?.modelId ?? model },
          durationMs: result?.usage?.apiDurationMs ?? null,
          usage: result ? usage(result) : null,
        });
      } catch (error) {
        swallow("grok: llm request record", error);
      }
    }
    if (turnFailure) {
      if (cleanupFailure) swallow("grok cleanup after turn failure", cleanupFailure);
      throw turnFailure.error;
    }
    if (cleanupFailure) throw cleanupFailure;
    return turnResult ?? { reply: "", stopped: true };
  };

  return defineHarness(
    {
      id: "grok",
      controlTransport: "json-rpc",
      toolTransport: "mcp",
      transcriptFormat: "acp-v1",
      capabilities: new Set(["abort", "images", "thinking-level"]),
    },
    {
      runTurn,
      resetSession: () => {},
      close: async () => {
        const turns = [...active];
        for (const turn of turns) turn.abort();
        await Promise.allSettled(turns.map((turn) => turn.done));
      },
      contextTokenBudget(_scopeLabel, model) {
        const selected = modelSupportedByHarness(model, "grok") ? model! : DEFAULT_GROK_MODEL_ID;
        return contextTokenBudgetForModel(selected);
      },
    },
  );
}
