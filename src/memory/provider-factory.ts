import { createMcpClient } from "../mcp/mcp-client.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpMemoryProvider, type McpMemoryOperation } from "./mcp-memory-provider.ts";
import {
  MAX_PROVIDER_TIMEOUT_MS,
  type MemoryProviderConfig,
  type McpMemoryOperationConfig,
} from "./provider-config.ts";
import { createRoutedMemoryService } from "./provider-router.ts";
import type { MemoryService } from "./memory-service.ts";
import { createMemorableMemoryProvider } from "./memorable/provider.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import type { Item } from "../sessions/items.ts";

function operation(url: string, { auth, ...spec }: McpMemoryOperationConfig, timeoutMs: number): McpMemoryOperation {
  return { client: createMcpClient({ url, auth: { mode: "client-credentials", ...auth }, fetch }), timeoutMs, ...spec };
}

export function createConfiguredMemoryService(opts: {
  defaultMemory: MemoryService;
  config?: MemoryProviderConfig;
  sessionItems?: (sessionId: string) => Promise<Item[]>;
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture") => void;
}): MemoryService {
  if (!opts.config) return opts.defaultMemory;
  const providers: Record<string, MemoryService> = { default: opts.defaultMemory };
  for (const provider of opts.config.providers) {
    if (provider.type === "memorable") {
      if (!opts.sessionItems)
        throw new Error(`memory provider ${provider.id} needs session access to record procedures`);
      providers[provider.id] = createMemorableMemoryProvider({
        argv: provider.argv,
        env: provider.env,
        injectTimeoutMs: provider.injectTimeoutMs,
        recordTimeoutMs: provider.recordTimeoutMs,
        mask: createSecretValueMasker(provider.redactValues),
        loadItems: opts.sessionItems,
      });
      continue;
    }
    providers[provider.id] = createMcpMemoryProvider({
      read: operation(provider.url, provider.read, provider.timeoutMs),
      ...(provider.write ? { write: operation(provider.url, provider.write, MAX_PROVIDER_TIMEOUT_MS) } : {}),
      attestActor: provider.attestActor,
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
