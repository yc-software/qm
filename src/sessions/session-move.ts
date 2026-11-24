import type { Principal, SpawnMeta } from "../types.ts";

export interface MoveTarget {
  groupRef: string;
  channelName: string;
  audience: Principal[];
  version: string | undefined;
}

export function rehomedSpawnMeta(
  meta: SpawnMeta,
  target: MoveTarget,
  computers: ReadonlyMap<string, string>,
): SpawnMeta {
  const { isPrivate: _isPrivate, isMpim: _isMpim, teamIds: _teamIds, ...conversation } = meta.conversation;
  const { scopeVersion: _scopeVersion, isolation, ...rest } = meta;
  const computer = isolation?.sandboxId ? computers.get(isolation.sandboxId) : undefined;
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
    ...(isolation ? { isolation: computer ? { ...isolation, sandboxId: computer } : isolation } : {}),
  };
}

export function newReaders(memberIds: readonly string[], readers: readonly (readonly string[])[]): string[] {
  return memberIds.filter((member) => readers.some((sessionReaders) => !sessionReaders.includes(member)));
}
