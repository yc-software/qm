import { createMcpClient, type ToolListings } from "../mcp/mcp-client.ts";
import { errMessage } from "../util/errors.ts";
import type { AddressFetch } from "../util/network.ts";
import { createMcpMemoryProvider, type McpMemoryOperation } from "./mcp-memory-provider.ts";
import {
  MAX_PROVIDER_TIMEOUT_MS,
  type MemoryProviderConfig,
  type McpMemoryOperationConfig,
} from "./provider-config.ts";
import type { MemoryService } from "./memory-service.ts";
import { createMemorableMemoryProvider } from "./memorable/provider.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import type { Item } from "../sessions/items.ts";

const MAX_RESPONSE_BYTES = 1_000_000;

function operation(
  url: string,
  { auth, ...spec }: McpMemoryOperationConfig,
  timeoutMs: number,
  fetchFn: AddressFetch,
): McpMemoryOperation {
  return {
    client: createMcpClient({
      url,
      auth: { mode: "client-credentials", ...auth },
      fetch: fetchFn,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    }),
    timeoutMs,
    ...spec,
  };
}

export const logMemoryProviderError = (error: unknown, provider: string, operation: string): void =>
  console.error(`[memory] ${provider} ${operation} failed: ${errMessage(error)}`);

export function createMemoryProviders(
  configs: MemoryProviderConfig["providers"],
  opts: { sessionItems?: (sessionId: string) => Promise<Item[]>; fetch?: AddressFetch; listings?: ToolListings } = {},
): Record<string, MemoryService> {
  const fetchFn = opts.fetch ?? fetch;
  const providers: Record<string, MemoryService> = {};
  for (const provider of configs) {
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
      read: operation(provider.url, provider.read, provider.timeoutMs, fetchFn),
      ...(provider.write ? { write: operation(provider.url, provider.write, MAX_PROVIDER_TIMEOUT_MS, fetchFn) } : {}),
      ...(provider.forget
        ? { forget: operation(provider.url, provider.forget, MAX_PROVIDER_TIMEOUT_MS, fetchFn) }
        : {}),
      label: provider.id,
      ...(opts.listings ? { listings: opts.listings } : {}),
      attestActor: provider.attestActor,
    });
  }
  return providers;
}
