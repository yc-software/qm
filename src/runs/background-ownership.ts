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
  generation: number;
  desiredDeploymentId: string | null;
  members: unknown[];
}

type StoredOwnership = BackgroundOwnership | MemberProtocolRecord | (BackgroundOwnership & MemberProtocolRecord);

function memberProtocolOwner(value: MemberProtocolRecord): BackgroundOwnership {
  return { ownerDeploymentId: value.enabled ? value.desiredDeploymentId : null, setAt: null, setBy: null };
}

function fromStored(value: StoredOwnership): BackgroundOwnership {
  if (!("ownerDeploymentId" in value)) return memberProtocolOwner(value);
  if ("desiredDeploymentId" in value && value.desiredDeploymentId !== value.ownerDeploymentId)
    return memberProtocolOwner(value);
  return { ownerDeploymentId: value.ownerDeploymentId, setAt: value.setAt, setBy: value.setBy };
}

function readableByMemberProtocol(state: BackgroundOwnership, previous?: StoredOwnership): BackgroundOwnership {
  const members = previous && "members" in previous ? previous : { generation: 0, members: [] };
  return {
    ...state,
    enabled: true,
    generation: members.generation,
    desiredDeploymentId: state.ownerDeploymentId,
    lastRequestId: null,
    lastRequest: null,
    members: members.members,
  } as BackgroundOwnership;
}

export function createBackgroundOwnershipStore(map: DurableMap<BackgroundOwnership>) {
  if (!map.update) throw new Error("Background ownership requires atomic updates");
  const key = "ownership";
  const initial: BackgroundOwnership = { ownerDeploymentId: null, setAt: null, setBy: null };
  const ready = () => map.putIfAbsent(key, readableByMemberProtocol(initial));
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
        if (current.ownerDeploymentId === change.ownerDeploymentId) return stored;
        return readableByMemberProtocol(
          { ownerDeploymentId: change.ownerDeploymentId, setAt: new Date().toISOString(), setBy: change.setBy },
          stored,
        );
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
