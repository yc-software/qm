export interface ReactionTally {
  name: string;
  count: number;
}

export function countedReactions(reactions: readonly ReactionTally[]): ReactionTally[] {
  return reactions.filter((r) => r.name && r.count > 0);
}

export function summarizeReactions(reactions: readonly ReactionTally[] | undefined): string {
  if (!reactions?.length) return "";
  return countedReactions(reactions)
    .map((r) => (r.count > 1 ? `:${r.name}:×${r.count}` : `:${r.name}:`))
    .join(" ");
}
