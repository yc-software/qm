import type { ChildIsolation, Principal, SpawnMeta } from "../types.ts";

export interface MoveTarget {
  groupRef: string;
  channelName: string;
  audience: Principal[];
  version: string | undefined;
}

export function rehomedSpawnMeta(
  meta: SpawnMeta,
  target: MoveTarget,
  computers: ReadonlyMap<string, string | null>,
): SpawnMeta {
  const { isPrivate: _isPrivate, isMpim: _isMpim, teamIds: _teamIds, ...conversation } = meta.conversation;
  const { scopeVersion: _scopeVersion, isolation, ...rest } = meta;
  const rebound = (child: ChildIsolation): ChildIsolation => {
    const computer = child.sandboxId ? computers.get(child.sandboxId) : undefined;
    if (computer === undefined) return child;
    const { sandboxId: _sandboxId, ...kept } = child;
    return computer ? { ...kept, sandboxId: computer } : kept;
  };
  return {
    ...rest,
    conversation: {
      ...conversation,
      kind: "group",
      channelRef: target.groupRef,
      channelName: target.channelName,
      audience: target.audience,
      publishMembers: target.audience,
    },
    sessionParticipantIds: target.audience.map((principal) => principal.id),
    ...(target.version ? { scopeVersion: target.version } : {}),
    ...(isolation ? { isolation: rebound(isolation) } : {}),
  };
}

export function newReaders(memberIds: readonly string[], readers: readonly (readonly string[])[]): string[] {
  return memberIds.filter((member) => readers.some((sessionReaders) => !sessionReaders.includes(member)));
}
