import type { McpFetch } from "../mcp/mcp-client.ts";
import { createMcpClient } from "../mcp/mcp-client.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpMemoryProvider, type McpMemoryOperation } from "./mcp-memory-provider.ts";
import type { MemoryProviderConfig, McpMemoryOperationConfig } from "./provider-config.ts";
import { createRoutedMemoryService } from "./provider-router.ts";
import type { MemoryService } from "./memory-service.ts";
import { createMemorableMemoryProvider } from "./memorable/provider.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import type { SessionEntry } from "../types.ts";

function operation(
  url: string,
  spec: McpMemoryOperationConfig,
  timeoutMs: number,
  fetchImpl?: McpFetch,
): McpMemoryOperation {
  return {
    client: createMcpClient({
      url,
      auth: { mode: "client-credentials", ...spec.auth },
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    tool: spec.tool,
    timeoutMs,
    ...(spec.queryArg ? { queryArg: spec.queryArg } : {}),
    ...(spec.contentArg ? { contentArg: spec.contentArg } : {}),
    ...(spec.actorArg ? { actorArg: spec.actorArg } : {}),
    ...(spec.scopeArg ? { scopeArg: spec.scopeArg } : {}),
    ...(spec.maxCharsArg ? { maxCharsArg: spec.maxCharsArg } : {}),
    ...(spec.inputArg ? { inputArg: spec.inputArg } : {}),
    ...(spec.replyArg ? { replyArg: spec.replyArg } : {}),
    ...(spec.capturedAtArg ? { capturedAtArg: spec.capturedAtArg } : {}),
    ...(spec.sourceArg ? { sourceArg: spec.sourceArg } : {}),
    ...(spec.idempotencyArg ? { idempotencyArg: spec.idempotencyArg } : {}),
  };
}

export function createConfiguredMemoryService(opts: {
  defaultMemory: MemoryService;
  config?: MemoryProviderConfig;
  fetchImpl?: McpFetch;
  /** Session trace access for providers that derive memory from tool-call history (currently "memorable"). */
  sessionEntries?: (sessionId: string) => Promise<SessionEntry[]>;
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture") => void;
}): MemoryService {
  if (!opts.config) return opts.defaultMemory;
  const providers: Record<string, MemoryService> = { default: opts.defaultMemory };
  for (const provider of opts.config.providers) {
    if (provider.type === "memorable") {
      if (!opts.sessionEntries)
        throw new Error(`memory provider ${provider.id} needs session access to record procedures`);
      providers[provider.id] = createMemorableMemoryProvider({
        argv: provider.argv,
        env: provider.env,
        injectTimeoutMs: provider.injectTimeoutMs,
        recordTimeoutMs: provider.recordTimeoutMs,
        mask: createSecretValueMasker(provider.redactValues),
        loadEntries: opts.sessionEntries,
      });
      continue;
    }
    providers[provider.id] = createMcpMemoryProvider({
      read: operation(provider.url, provider.read, provider.timeoutMs, opts.fetchImpl),
      ...(provider.write ? { write: operation(provider.url, provider.write, provider.timeoutMs, opts.fetchImpl) } : {}),
    });
  }
  return createRoutedMemoryService({
    providers,
    routes: opts.config.routes,
    onError:
      opts.onError ??
      ((error, provider, operation) => console.error(`[memory] ${provider} ${operation} failed: ${errMessage(error)}`)),
  });
}
