import { parseSuggestedActivities } from "../../chassis/src/suggested-activities.ts";
import { api } from "./core-bridge";
import type { Me } from "./shell-state";

const requests = new WeakMap<Me, { until: number; pending: Promise<void> }>();

export function loadGeneratedActivities(me: Me): Promise<void> {
  if (!me.suggestedActivitiesGeneration) return Promise.resolve();
  const cached = requests.get(me);
  if (cached && cached.until > Date.now()) return cached.pending;
  const pending = api<{ activities: unknown }>("/api/suggested-activities", { method: "POST" })
    .then((response) => {
      const activities = parseSuggestedActivities(JSON.stringify(response.activities));
      me.suggestedActivities = activities;
    })
    .catch(() => undefined);
  requests.set(me, { until: Date.now() + 5 * 60_000, pending });
  return pending;
}
