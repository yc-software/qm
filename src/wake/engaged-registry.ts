import { boundTenant } from "../tenants/context.ts";

export interface EngagedSession {
  tenantId?: string;
  threadRef: string;
}

export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): EngagedSession[];
}

export function createEngagedRegistry(): EngagedRegistry {
  const engaged = new Map<string, EngagedSession>();
  const key = (threadRef: string) => `${boundTenant() ?? ""}\n${threadRef}`;
  return {
    engage(threadRef) {
      const tenantId = boundTenant();
      engaged.set(key(threadRef), { ...(tenantId ? { tenantId } : {}), threadRef });
    },
    settle: (threadRef) => void engaged.delete(key(threadRef)),
    list: () => [...engaged.values()],
  };
}
