export const SUPPORTED_LOCALES = ["en", "zh-CN", "ja", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
};

export type Catalog = Record<string, string>;

const PRIMARY_TAG: Record<string, Locale> = { en: "en", zh: "zh-CN", ja: "ja", ko: "ko" };
const TRADITIONAL_CHINESE_MARKERS = new Set(["hant", "tw", "hk", "mo"]);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const parts = tag.trim().toLowerCase().split("-");
  const primary = parts[0] ?? "";
  if (primary === "zh" && parts.slice(1).some((part) => TRADITIONAL_CHINESE_MARKERS.has(part))) return null;
  return PRIMARY_TAG[primary] ?? null;
}

export function normalizeLocale(tag: string | null | undefined): Locale {
  return matchLocale(tag) ?? "en";
}

export function negotiateLocale(header: string | null | undefined, fallback: Locale = "en"): Locale {
  if (!header) return fallback;
  const choices = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: (tag ?? "").trim(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .sort((a, b) => b.weight - a.weight);
  for (const choice of choices) {
    const matched = matchLocale(choice.tag);
    if (matched) return matched;
  }
  return fallback;
}

export function translate(
  catalog: Catalog | null | undefined,
  key: string,
  params?: Record<string, string | number>,
): string {
  let message = catalog?.[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }
  return message;
}
