import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { GrokMcpBridge } from "./grok-mcp.ts";
import type { GrokProcess } from "./grok-process.ts";

interface GrokPromptUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs: number;
  costUsdTicks: number;
}

export interface GrokAcpResult {
  stopReason: acp.StopReason;
  reply: string;
  thoughts: string[];
  modelId?: string;
  usage?: GrokPromptUsage;
  toolCalls: number;
}

export interface GrokAcpOptions {
  process: GrokProcess;
  cwd: string;
  systemPrompt: string;
  prompt: acp.ContentBlock[];
  model: string;
  reasoningEffort?: string;
  bridge: GrokMcpBridge;
  signal: AbortSignal;
  setupTimeoutMs?: number;
  onDelta?(text: string): void;
  onTextBlockStart?(): void;
  onProgress?(progress: { toolCalls: number; tokens?: number }): void;
}

interface GrokPromptMeta {
  modelId?: unknown;
  usage?: Record<string, unknown>;
}

const CANCEL_GRACE_MS = 500;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function grokPromptUsage(meta: unknown): GrokPromptUsage | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const usage = (meta as GrokPromptMeta).usage;
  if (!usage) return undefined;
  const values = {
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    totalTokens: finite(usage.totalTokens),
    cachedReadTokens: finite(usage.cachedReadTokens),
    cacheCreationTokens: finite(usage.cacheCreationTokens),
    reasoningTokens: finite(usage.reasoningTokens),
    modelCalls: finite(usage.modelCalls),
    apiDurationMs: finite(usage.apiDurationMs),
    costUsdTicks: finite(usage.costUsdTicks),
  };
  if (Object.values(values).some((value) => value === undefined)) return undefined;
  return values as GrokPromptUsage;
}

function text(update: acp.SessionUpdate): string | undefined {
  if (
    (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
    update.content.type === "text"
  )
    return update.content.text;
  return undefined;
}

function inventory(update: acp.SessionUpdate): string[] | false | undefined {
  if (update.sessionUpdate !== "available_commands_update") return undefined;
  const tools = update._meta?.tools;
  if (!Array.isArray(tools)) return false;
  const names: string[] = [];
  for (const tool of tools) {
    if (typeof tool === "string" && tool.length > 0) {
      names.push(tool);
      continue;
    }
    if (!tool || typeof tool !== "object") return false;
    const record = tool as Record<string, unknown>;
    const value = typeof record.name === "string" ? record.name : record.id;
    if (typeof value !== "string" || value.length === 0) return false;
    names.push(value);
  }
  return names;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasoningEffort(value: string | undefined): string | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

export async function runGrokAcp(options: GrokAcpOptions): Promise<GrokAcpResult> {
  if (options.signal.aborted) throw new Error("Grok ACP was cancelled before startup");
  const stream = acp.ndJsonStream(
    Writable.toWeb(options.process.child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(options.process.child.stdout) as ReadableStream<Uint8Array>,
  );
  let cancelSession: (() => void) | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = () => {
    cancelSession?.();
    cancelTimer ??= setTimeout(() => {
      void options.process
        .stop()
        .then(() => rejectCancelled(new Error("Grok ACP did not stop after cancellation")), rejectCancelled);
    }, CANCEL_GRACE_MS);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const setupTimeoutMs = options.setupTimeoutMs ?? 15_000;
  const advertisedSurfaces = new Map<string, string[] | false>();
  try {
    const connected = acp
      .client({ name: "qm" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => options.bridge.requestPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const names = inventory(params.update);
        if (names !== undefined) advertisedSurfaces.set(params.sessionId, names);
      })
      .connectWith(stream, async (context) => {
        const initialized = await within(
          context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "qm", version: "1" },
          }),
          setupTimeoutMs,
          "Grok ACP initialization timed out",
        );
        if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
          throw new Error(`Grok ACP protocol ${initialized.protocolVersion} is unsupported`);
        if (!initialized.authMethods?.some((method) => method.id === "cached_token"))
          throw new Error("Grok ACP cached-token authentication is unavailable");
        await within(
          context.request(acp.methods.agent.authenticate, { methodId: "cached_token", _meta: { headless: true } }),
          setupTimeoutMs,
          "Grok ACP authentication timed out",
        );
        return await context
          .buildSession({
            cwd: options.cwd,
            mcpServers: [
              {
                type: "http",
                name: "qm",
                url: options.bridge.url,
                headers: [{ name: "Authorization", value: `Bearer ${options.bridge.bearerToken}` }],
              },
            ],
            _meta: { headless: true, yoloMode: false, systemPromptOverride: options.systemPrompt },
          })
          .withSession(async (session) => {
            const models = (
              session.newSessionResponse as unknown as {
                models?: { currentModelId?: unknown; availableModels?: unknown };
              }
            ).models;
            const availableModels = Array.isArray(models?.availableModels) ? models.availableModels : [];
            const availableModelIds = availableModels.flatMap((available) => {
              if (!available || typeof available !== "object") return [];
              const record = available as Record<string, unknown>;
              const id = record.modelId ?? record.id;
              return typeof id === "string" ? [id] : [];
            });
            if (typeof models?.currentModelId !== "string" || !availableModelIds.includes(options.model))
              throw new Error("Grok ACP model catalog does not contain the requested model");
            cancelSession = () => {
              void context
                .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
                .catch(() => undefined);
            };
            if (options.signal.aborted) cancelSession();
            await within(
              context.request("session/set_model", {
                sessionId: session.sessionId,
                modelId: options.model,
                ...(reasoningEffort(options.reasoningEffort)
                  ? { _meta: { reasoningEffort: reasoningEffort(options.reasoningEffort) } }
                  : {}),
              }),
              setupTimeoutMs,
              "Grok ACP model selection timed out",
            );
            await within(options.bridge.waitUntilListed, setupTimeoutMs, "Grok MCP tool discovery timed out");
            const replies: string[] = [];
            const thoughtByMessage = new Map<string, string>();
            const startedMessages = new Set<string>();
            const seenToolCalls = new Set<string>();
            const pendingUpdates: acp.SessionUpdate[] = [];
            let surfaceVerified = false;
            const initialSurface = advertisedSurfaces.get(session.sessionId);
            if (initialSurface !== undefined) {
              if (initialSurface === false || !options.bridge.confirmAcpToolSurface(initialSurface))
                throw new Error("Grok exposed an unexpected tool surface");
              surfaceVerified = true;
            }
            const consume = (update: acp.SessionUpdate): void => {
              if (update.sessionUpdate === "agent_message_chunk") {
                const value = text(update);
                if (!value) return;
                const messageId = update.messageId ?? "default";
                if (!startedMessages.has(messageId)) {
                  startedMessages.add(messageId);
                  options.onTextBlockStart?.();
                }
                replies.push(value);
                options.onDelta?.(value);
              } else if (update.sessionUpdate === "agent_thought_chunk") {
                const value = text(update);
                if (!value) return;
                const messageId = update.messageId ?? "default";
                thoughtByMessage.set(messageId, `${thoughtByMessage.get(messageId) ?? ""}${value}`);
              } else if (update.sessionUpdate === "tool_call") {
                seenToolCalls.add(update.toolCallId);
                options.onProgress?.({ toolCalls: seenToolCalls.size });
              } else if (update.sessionUpdate === "usage_update") {
                options.onProgress?.({ toolCalls: seenToolCalls.size, tokens: update.used });
              }
            };
            const promptFinished = session.prompt(options.prompt);
            void promptFinished.catch(() => undefined);
            while (!surfaceVerified) {
              const message = await within(
                session.nextUpdate(),
                setupTimeoutMs,
                "Grok tool-surface discovery timed out",
              );
              if (message.kind === "stop") throw new Error("Grok ACP stopped before tool-surface verification");
              const names = inventory(message.update);
              if (names !== undefined) {
                if (names === false || !options.bridge.confirmAcpToolSurface(names))
                  throw new Error("Grok exposed an unexpected tool surface");
                surfaceVerified = true;
                continue;
              }
              if (message.update.sessionUpdate === "tool_call")
                throw new Error("Grok attempted a tool call before tool-surface verification");
              pendingUpdates.push(message.update);
            }
            for (const update of pendingUpdates) consume(update);
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                await promptFinished;
                const meta = message.response._meta as GrokPromptMeta | null | undefined;
                const modelId = typeof meta?.modelId === "string" ? meta.modelId : undefined;
                return {
                  stopReason: message.stopReason,
                  reply: replies.join(""),
                  thoughts: [...thoughtByMessage.values()].filter((value) => value.trim()),
                  ...(modelId ? { modelId } : {}),
                  ...(grokPromptUsage(meta) ? { usage: grokPromptUsage(meta) } : {}),
                  toolCalls: seenToolCalls.size,
                };
              }
              const names = inventory(message.update);
              if (names !== undefined && (names === false || !options.bridge.confirmAcpToolSurface(names)))
                throw new Error("Grok exposed an unexpected tool surface");
              consume(message.update);
            }
          });
      });
    return await Promise.race([connected, cancelled]);
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    options.signal.removeEventListener("abort", onAbort);
  }
}
