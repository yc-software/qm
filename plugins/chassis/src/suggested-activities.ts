import { errMessage } from "./errors.ts";

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

function activityProblem(item: Record<string, unknown>, ids: Set<string>): string | undefined {
  const { id, title, prompt, icon, source, replaces } = item;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    return "id must be a lowercase slug of at most 64 characters";
  if (ids.has(id)) return "id repeats an earlier activity's id";
  if (typeof title !== "string" || !title.trim()) return "title is required";
  if (title.length > 65) return `title is ${title.length} characters and a suggestion row fits 65`;
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt is required";
  if (prompt.length > 1200) return `prompt is ${prompt.length} characters and the limit is 1200`;
  if (typeof icon !== "string" || !validIcon(icon)) return "icon must be one emoji or a built-in icon name";
  if (source !== undefined && (typeof source !== "string" || !source.trim())) return "source must be text";
  if (replaces !== undefined && typeof replaces !== "string") return "replaces must be an activity id";
  return undefined;
}

function activitiesFrom(parsed: unknown, where: string, ids = new Set<string>()): AppActivity[] {
  if (!Array.isArray(parsed)) throw new Error(`${where} must be a list of activities`);
  return parsed.map((item: unknown, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${where}[${index}] must be an object`);
    const problem = activityProblem(item as Record<string, unknown>, ids);
    if (problem) throw new Error(`${where}[${index}]: ${problem}`);
    const { id, title, prompt, icon, source, replaces } = item as Record<string, string>;
    ids.add(id!);
    return {
      id: id!,
      title: title!.trim(),
      prompt: prompt!.trim(),
      icon: icon!,
      ...(source ? { source: source.trim() } : {}),
      ...(replaces ? { replaces } : {}),
    };
  });
}

export function parseSuggestedActivities(value: string | undefined): SuggestedActivity[] {
  if (!value?.trim()) return [];
  const where = "WEB_UI_SUGGESTED_ACTIVITIES";
  if (value.length > 20_000) throw new Error(`${where} is ${value.length} characters and the limit is 20,000`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  if (Array.isArray(parsed) && parsed.length > 12)
    throw new Error(`${where} lists ${parsed.length} activities and the limit is 12`);
  return activitiesFrom(parsed, where);
}

export function parseActivitySeeds(value: string, where: string): ActivitySeeds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${where} is not valid JSON: ${errMessage(cause)}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${where} must be a JSON object`);
  const { activities, apps = {} } = parsed as Record<string, unknown>;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw new Error(`${where}: apps must be an object`);
  const ids = new Set<string>();
  const base = activitiesFrom(activities, `${where}: activities`, ids);
  const known = new Set(ids);
  const perApp = Object.entries(apps).map(([app, items]): [string, AppActivity[]] => {
    const list = activitiesFrom(items, `${where}: apps.${app}`, ids);
    const stray = list.find((activity) => activity.replaces && !known.has(activity.replaces));
    if (stray)
      throw new Error(`${where}: apps.${app} activity "${stray.id}" replaces unknown activity "${stray.replaces}"`);
    return [app, list];
  });
  return { activities: base, apps: Object.fromEntries(perApp) };
}
