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
  const unbound = (child: ChildIsolation): ChildIsolation => {
    const { sandboxId: _sandboxId, ...kept } = child;
    return kept;
  };
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
    ...(isolation
      ? {
          isolation:
            computer === undefined ? isolation : computer ? { ...isolation, sandboxId: computer } : unbound(isolation),
        }
      : {}),
  };
}

export function newReaders(memberIds: readonly string[], readers: readonly (readonly string[])[]): string[] {
  return memberIds.filter((member) => readers.some((sessionReaders) => !sessionReaders.includes(member)));
}
