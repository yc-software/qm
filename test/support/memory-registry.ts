import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import type { MemoryRegistryStore } from "../../src/memory/registry.ts";

export const emptyMemoryRegistry: Pick<MemoryRegistryStore, "current" | "overlayIds" | "key"> = {
  overlayIds: new Set(),
  key: deriveConnectorKey("test-memory-registry-key", "memory-registry"),
  current: async () => ({ version: "", record: null }),
};
