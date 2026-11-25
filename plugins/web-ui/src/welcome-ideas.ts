import type { ActivitySeeds, SuggestedActivity } from "../../chassis/src/suggested-activities.ts";

export function welcomeActivities(
  seeds: ActivitySeeds,
  connected: ReadonlyArray<{ id: string; name: string }>,
  justConnected: string,
): { activities: SuggestedActivity[]; fresh: Set<string> } {
  let activities = seeds.activities;
  const fresh = new Set<string>();
  for (const app of connected) {
    const adds = seeds.apps[app.id] ?? [];
    const replaced = new Set(adds.map((activity) => activity.replaces));
    if (app.id === justConnected) for (const activity of adds) fresh.add(activity.id);
    activities = [
      ...adds.map(({ replaces: _replaces, ...activity }) => ({ ...activity, source: `from ${app.name}` })),
      ...activities.filter((existing) => !replaced.has(existing.id)),
    ];
  }
  return { activities, fresh };
}
