import { z } from "zod";
import {
  validIcon,
  type ActivitySeeds,
  type SuggestedActivity,
} from "../../plugins/chassis/src/suggested-activities.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { scopeId, type ScopeId } from "../types.ts";

const activity = {
  id: z.string().min(1).max(64, "must be at most 64 characters, the longest id a dismissal accepts"),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  icon: z.string().refine(validIcon, "must be one emoji or a built-in icon name"),
};

const seedsSchema = z
  .strictObject({
    activities: z.array(z.strictObject({ ...activity, source: z.string().trim().min(1).optional() })),
    apps: z
      .record(z.string().min(1), z.array(z.strictObject({ ...activity, replaces: z.string().min(1).optional() })))
      .default({}),
  })
  .superRefine((seeds, ctx) => {
    const base = new Set(seeds.activities.map((entry) => entry.id));
    const seen = new Set<string>();
    const all = [
      ...seeds.activities.map((entry, index) => ({ entry, path: ["activities", index] })),
      ...Object.entries(seeds.apps).flatMap(([app, list]) =>
        list.map((entry, index) => ({ entry, path: ["apps", app, index] })),
      ),
    ];
    for (const { entry, path } of all) {
      if (seen.has(entry.id)) ctx.addIssue({ code: "custom", path: [...path, "id"], message: "repeats an earlier id" });
      seen.add(entry.id);
      const replaces = "replaces" in entry ? entry.replaces : undefined;
      if (replaces && !base.has(replaces))
        ctx.addIssue({ code: "custom", path: [...path, "replaces"], message: `names no activity in activities` });
    }
  });

export function parseActivitySeeds(value: unknown): ActivitySeeds {
  const parsed = seedsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues.map((issue) => `${["seeds", ...issue.path].join(".")}: ${issue.message}`).join("; "),
  );
}

export async function starterActivities(
  deps: {
    featureFlags?: Pick<FeatureFlagStore, "enabled">;
    config?: Pick<ScopedConfigStore, "getActivitySeeds">;
    fallback: SuggestedActivity[];
  },
  org: ScopeId,
  person: string,
): Promise<{ welcome?: ActivitySeeds; activities: SuggestedActivity[] }> {
  const on = await deps.featureFlags?.enabled("company_welcome", scopeId("personal", person));
  const welcome = on ? ((await deps.config?.getActivitySeeds(org)) ?? undefined) : undefined;
  return welcome ? { welcome, activities: welcome.activities } : { activities: deps.fallback };
}
