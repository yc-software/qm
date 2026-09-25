const activityIcons = ["schedule", "app", "deck", "people", "calendar", "book"] as const;

export interface SuggestedActivity {
  id: string;
  title: string;
  prompt: string;
  icon: string;
}

function validIcon(value: string): boolean {
  if ([...activityIcons, "yc"].includes(value)) return true;
  return (
    value.length <= 32 &&
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1 &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
  );
}

export function parseSuggestedActivities(value: string | undefined): SuggestedActivity[] {
  if (!value?.trim()) return [];
  const invalid = () =>
    new Error(
      "WEB_UI_SUGGESTED_ACTIVITIES must be a JSON array of up to 12 unique activities with id, title, prompt, and icon",
    );
  if (value.length > 20_000) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length > 12) throw invalid();
  const ids = new Set<string>();
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const { id, title, prompt, icon } = item as Record<string, unknown>;
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
      !validIcon(icon)
    )
      throw invalid();
    ids.add(id);
    return { id, title: title.trim(), prompt: prompt.trim(), icon };
  });
}
