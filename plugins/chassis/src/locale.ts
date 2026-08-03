export const LOCALES = ["en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "qm_locale";
export const LOCALE_HEADER = "x-qm-locale";
export const DEFAULT_LOCALE_ENV = "QM_DEFAULT_LOCALE";

export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^(en|ja)(?:-[a-z0-9]+)*$/.test(normalized)) return null;
  return normalized.startsWith("ja") ? "ja" : "en";
}

export function acceptLanguageLocale(value: string | readonly string[] | undefined): Locale | null {
  const entries = (Array.isArray(value) ? value : [value ?? ""]).flatMap((header) => header.split(","));
  let selected: { locale: Locale; quality: number; index: number } | undefined;
  for (const [index, entry] of entries.entries()) {
    const [tag, ...parameters] = entry.trim().split(";");
    const locale = normalizeLocale(tag);
    if (!locale) continue;
    const qualityValue = parameters.find((parameter) => /^\s*q\s*=/i.test(parameter));
    const quality = qualityValue === undefined ? 1 : Number(qualityValue.replace(/^\s*q\s*=\s*/i, ""));
    if (!Number.isFinite(quality) || quality < 0 || quality > 1 || quality === 0) continue;
    if (!selected || quality > selected.quality || (quality === selected.quality && index < selected.index)) {
      selected = { locale, quality, index };
    }
  }
  return selected?.locale ?? null;
}

export function defaultLocale(value: unknown): Locale {
  return normalizeLocale(value) ?? "en";
}

export function resolveLocale(input: {
  explicit?: unknown;
  defaultLocale?: unknown;
  acceptLanguage?: string | readonly string[];
}): Locale {
  return normalizeLocale(input.explicit) ?? normalizeLocale(input.defaultLocale) ?? acceptLanguageLocale(input.acceptLanguage) ?? "en";
}

export function formatMessage(template: string, values: Record<string, unknown> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
}

export function catalogProblems(en: Record<string, string>, translated: Record<string, string>): string[] {
  const missing = Object.keys(en)
    .filter((key) => !(key in translated))
    .sort()
    .map((key) => `missing key: ${key}`);
  const extra = Object.keys(translated)
    .filter((key) => !(key in en))
    .sort()
    .map((key) => `extra key: ${key}`);
  const mismatches = Object.keys(en)
    .filter((key) => key in translated)
    .filter((key) => {
      const english = [...new Set(placeholders(en[key]!))].sort();
      const localized = [...new Set(placeholders(translated[key]!))].sort();
      return english.length !== localized.length || english.some((value, index) => value !== localized[index]);
    })
    .sort()
    .map((key) => `placeholder mismatch: ${key}`);
  return [...missing, ...extra, ...mismatches];
}
