import { createMcpClient } from "../mcp/mcp-client.ts";
import { errMessage } from "../util/errors.ts";
import type { AddressFetch } from "../util/network.ts";
import { createMcpMemoryProvider, type McpMemoryOperation } from "./mcp-memory-provider.ts";
import type { MemoryProviderConfig, McpMemoryOperationConfig } from "./provider-config.ts";
import type { MemoryService } from "./memory-service.ts";
import { createMemorableMemoryProvider } from "./memorable/provider.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import type { Item } from "../sessions/items.ts";

const MAX_RESPONSE_BYTES = 1_000_000;

function operation(
  url: string,
  spec: McpMemoryOperationConfig,
  timeoutMs: number,
  fetchFn: AddressFetch,
): McpMemoryOperation {
  return {
    client: createMcpClient({
      url,
      auth: { mode: "client-credentials", ...spec.auth },
      fetch: fetchFn,
      maxResponseBytes: MAX_RESPONSE_BYTES,
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

export const logMemoryProviderError = (error: unknown, provider: string, operation: string): void =>
  console.error(`[memory] ${provider} ${operation} failed: ${errMessage(error)}`);

export function createMemoryProviders(
  configs: MemoryProviderConfig["providers"],
  opts: {
    sessionItems?: (sessionId: string) => Promise<Item[]>;
    fetchFor?: (providerId: string) => AddressFetch | undefined;
  } = {},
): Record<string, MemoryService> {
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
    const fetchFn = opts.fetchFor?.(provider.id) ?? fetch;
    providers[provider.id] = createMcpMemoryProvider({
      read: operation(provider.url, provider.read, provider.timeoutMs, fetchFn),
      ...(provider.write ? { write: operation(provider.url, provider.write, provider.timeoutMs, fetchFn) } : {}),
      attestActor: provider.attestActor,
    });
  }
  return providers;
}
