export interface GroupAvatarMember {
  principalId: string;
  displayName: string;
}

export interface GroupAvatarStack {
  shown: GroupAvatarMember[];
  overflow: number;
}

/** At most three slots: up to three faces, or two faces and a "+N" chip, so headers line up. */
export const GROUP_AVATAR_SLOTS = 3;

/** Orders members to match the group DM label ("regan, eve, josh, eric") and fits them into the slots. */
export function groupAvatarStack(
  members: readonly GroupAvatarMember[] | undefined,
  labelNames: readonly string[] = [],
): GroupAvatarStack {
  if (!members?.length) return { shown: [], overflow: 0 };
  const rank = (member: GroupAvatarMember): number => {
    const name = member.displayName.trim().toLowerCase();
    const index = labelNames.findIndex((label) => {
      const l = label.trim().toLowerCase();
      return l !== "" && (name === l || name.startsWith(`${l} `) || name.split(/\s+/u)[0] === l);
    });
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = members
    .map((member, index) => ({ member, index, rank: rank(member) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ member }) => member);
  if (ordered.length <= GROUP_AVATAR_SLOTS) return { shown: ordered, overflow: 0 };
  const shown = ordered.slice(0, GROUP_AVATAR_SLOTS - 1);
  return { shown, overflow: ordered.length - shown.length };
}

export function avatarInitial(displayName: string): string {
  return [...displayName.trim()][0]?.toUpperCase() ?? "?";
}
