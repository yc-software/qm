import type { McpFetch } from "../mcp/mcp-client.ts";
import { createMcpClient } from "../mcp/mcp-client.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpMemoryProvider, type McpMemoryOperation } from "./mcp-memory-provider.ts";
import type { MemoryProviderConfig, McpMemoryOperationConfig } from "./provider-config.ts";
import { createRoutedMemoryService } from "./provider-router.ts";
import type { MemoryService } from "./memory-service.ts";
import { createMemorableMemoryProvider, type MemorableProviderDeps } from "./memorable/provider.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";

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
  /** Required when any provider has type "memorable": how it reads a session's entries and redacts secrets. */
  memorable?: Pick<MemorableProviderDeps, "loadEntries">;
  onError?: (error: unknown, provider: string, operation: "recall" | "query") => void;
}): MemoryService {
  if (!opts.config) return opts.defaultMemory;
  const providers: Record<string, MemoryService> = { default: opts.defaultMemory };
  for (const provider of opts.config.providers) {
    if (provider.type === "memorable") {
      if (!opts.memorable) throw new Error(`memory provider ${provider.id} needs session access to record procedures`);
      providers[provider.id] = createMemorableMemoryProvider({
        bin: provider.bin,
        env: provider.env,
        injectTimeoutMs: provider.injectTimeoutMs,
        recordTimeoutMs: provider.recordTimeoutMs,
        mask: createSecretValueMasker(provider.redactValues),
        ...opts.memorable,
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
