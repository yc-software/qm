import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { resolveMemoryRegistry, type MemoryRegistryStore } from "../../src/memory/registry.ts";

const key = deriveConnectorKey("test-memory-registry-key", "memory-registry");
const overlayIds = new Set<string>();

export const emptyMemoryRegistry: Pick<MemoryRegistryStore, "current" | "overlayIds" | "key" | "resolve"> = {
  overlayIds,
  key,
  current: async () => ({ version: "", record: null }),
  resolve: async (record) => resolveMemoryRegistry(record, { overlayIds, key }),
};
