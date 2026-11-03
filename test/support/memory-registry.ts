import type { MemoryRegistryStore } from "../../src/memory/registry.ts";

export const emptyMemoryRegistry: Pick<MemoryRegistryStore, "current" | "overlayIds"> = {
  overlayIds: new Set(),
  current: async () => ({ version: "", record: null }),
};
