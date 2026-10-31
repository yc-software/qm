export interface GroupAvatarMember {
  principalId: string;
  displayName: string;
  avatarUrl?: string;
}

export interface GroupAvatarStack {
  shown: GroupAvatarMember[];
  overflow: number;
}

const GROUP_AVATAR_SLOTS = 3;

export function groupAvatarStack(members: readonly GroupAvatarMember[] | undefined): GroupAvatarStack {
  if (!members?.length) return { shown: [], overflow: 0 };
  if (members.length <= GROUP_AVATAR_SLOTS) return { shown: [...members], overflow: 0 };
  const shown = members.slice(0, GROUP_AVATAR_SLOTS - 1);
  return { shown, overflow: members.length - shown.length };
}

export function avatarInitial(displayName: string): string {
  return [...displayName.trim()][0]?.toUpperCase() ?? "?";
}
