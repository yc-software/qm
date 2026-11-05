import { currentTenant } from "../tenants/context.ts";

export interface EngagedSession {
  tenantId: string;
  threadRef: string;
}

export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): EngagedSession[];
}

export function createEngagedRegistry(): EngagedRegistry {
  const engaged = new Map<string, EngagedSession>();
  const key = (tenantId: string, threadRef: string) => `${tenantId}\n${threadRef}`;
  return {
    engage(threadRef) {
      const tenantId = currentTenant();
      engaged.set(key(tenantId, threadRef), { tenantId, threadRef });
    },
    settle: (threadRef) => void engaged.delete(key(currentTenant(), threadRef)),
    list: () => [...engaged.values()],
  };
}
