const activityIcons = ["schedule", "app", "deck", "people", "calendar", "book"] as const;

export interface SuggestedActivity {
  id: string;
  title: string;
  prompt: string;
  icon: string;
  source?: string;
}

interface AppActivity extends SuggestedActivity {
  replaces?: string;
}

export interface ActivitySeeds {
  activities: SuggestedActivity[];
  apps: Record<string, AppActivity[]>;
}

function validIcon(value: string): boolean {
  if ([...activityIcons, "yc"].includes(value)) return true;
  return (
    value.length <= 32 &&
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1 &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
  );
}

function activitiesFrom(parsed: unknown, invalid: () => Error): AppActivity[] {
  if (!Array.isArray(parsed) || parsed.length > 12) throw invalid();
  const ids = new Set<string>();
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const { id, title, prompt, icon, source, replaces } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
      ids.has(id) ||
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 65 ||
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > 1200 ||
      typeof icon !== "string" ||
      !validIcon(icon) ||
      (source !== undefined && (typeof source !== "string" || !source.trim() || source.length > 65)) ||
      (replaces !== undefined && typeof replaces !== "string")
    )
      throw invalid();
    ids.add(id);
    return {
      id,
      title: title.trim(),
      prompt: prompt.trim(),
      icon,
      ...(source ? { source: source.trim() } : {}),
      ...(replaces ? { replaces } : {}),
    };
  });
}

function parseJson(value: string, invalid: () => Error): unknown {
  if (value.length > 20_000) throw invalid();
  try {
    return JSON.parse(value);
  } catch {
    throw invalid();
  }
}

export function parseSuggestedActivities(value: string | undefined): SuggestedActivity[] {
  if (!value?.trim()) return [];
  const invalid = () =>
    new Error(
      "WEB_UI_SUGGESTED_ACTIVITIES must be a JSON array of up to 12 unique activities with id, title, prompt, and icon",
    );
  return activitiesFrom(parseJson(value, invalid), invalid);
}

export function parseActivitySeeds(value: string): ActivitySeeds {
  const invalid = () =>
    new Error(
      "an activity seed file must be a JSON object with activities and optional apps, each a list of up to 12 unique activities with id, title, prompt, and icon",
    );
  const parsed = parseJson(value, invalid);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const { activities, apps = {} } = parsed as Record<string, unknown>;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw invalid();
  return {
    activities: activitiesFrom(activities, invalid),
    apps: Object.fromEntries(Object.entries(apps).map(([app, items]) => [app, activitiesFrom(items, invalid)])),
  };
}
