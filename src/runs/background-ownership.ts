import type { DurableMap } from "../persistence/durable-map.ts";

export interface BackgroundOwnership {
  ownerDeploymentId: string | null;
  setAt: string | null;
  setBy: string | null;
}

export interface BackgroundOwnershipChange {
  ownerDeploymentId: string | null;
  expectedOwnerDeploymentId?: string | null;
  setBy: string;
}

export class BackgroundOwnershipConflict extends Error {}

interface MemberProtocolRecord {
  enabled: boolean;
  desiredDeploymentId: string | null;
}

function fromStored(value: BackgroundOwnership | MemberProtocolRecord): BackgroundOwnership {
  if ("enabled" in value)
    return { ownerDeploymentId: value.enabled ? value.desiredDeploymentId : null, setAt: null, setBy: null };
  return { ownerDeploymentId: value.ownerDeploymentId, setAt: value.setAt, setBy: value.setBy };
}

export function createBackgroundOwnershipStore(map: DurableMap<BackgroundOwnership>) {
  if (!map.update) throw new Error("Background ownership requires atomic updates");
  const key = "ownership";
  const initial: BackgroundOwnership = { ownerDeploymentId: null, setAt: null, setBy: null };
  const ready = () => map.putIfAbsent(key, { ...initial });
  return {
    async get(): Promise<BackgroundOwnership> {
      return fromStored((await map.get(key)) ?? (await ready()));
    },
    async set(change: BackgroundOwnershipChange): Promise<BackgroundOwnership> {
      await ready();
      const result = await map.update!(key, (stored) => {
        const current = fromStored(stored);
        if (
          change.expectedOwnerDeploymentId !== undefined &&
          current.ownerDeploymentId !== change.expectedOwnerDeploymentId &&
          current.ownerDeploymentId !== change.ownerDeploymentId
        )
          throw new BackgroundOwnershipConflict("Background owner changed");
        if (current.ownerDeploymentId === change.ownerDeploymentId) return current;
        return { ownerDeploymentId: change.ownerDeploymentId, setAt: new Date().toISOString(), setBy: change.setBy };
      });
      if (!result) throw new Error("Background ownership disappeared");
      return fromStored(result);
    },
  };
}

export type BackgroundOwnershipStore = ReturnType<typeof createBackgroundOwnershipStore>;

export interface BackgroundOwnershipControl {
  store: BackgroundOwnershipStore;
  instanceId: string;
  deploymentId: string;
  active: () => boolean;
}
