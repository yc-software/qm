import {
  isLocale,
  LOCALE_NATIVE_NAMES,
  negotiateLocale,
  SUPPORTED_LOCALES,
  translate,
  type Catalog,
  type Locale,
} from "../../chassis/src/i18n.ts";

export { type Locale };

const CATALOG_LOADERS: Record<Exclude<Locale, "en">, () => Promise<Catalog>> = {
  "zh-CN": async () => (await import("./locales/zh-CN.json")).default as Catalog,
  ja: async () => (await import("./locales/ja.json")).default as Catalog,
  ko: async () => (await import("./locales/ko.json")).default as Catalog,
};

let active: Locale = "en";
let catalog: Catalog | null = null;
let localeOptions: Array<{ id: Locale; name: string }> = SUPPORTED_LOCALES.map((id) => ({
  id,
  name: LOCALE_NATIVE_NAMES[id],
}));

export function t(key: string, params?: Record<string, string | number>): string {
  return translate(catalog, key, params);
}

export function activeLocale(): Locale {
  return active;
}

export function availableLocales(): Array<{ id: Locale; name: string }> {
  return localeOptions.map((option) => ({ ...option }));
}

export function advertiseLocales(list: unknown): void {
  if (!Array.isArray(list)) return;
  const options = list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    return isLocale(id) && typeof name === "string" && name ? [{ id, name }] : [];
  });
  if (options.length) localeOptions = options;
}

async function applyLocale(locale: Locale): Promise<void> {
  catalog = locale === "en" ? null : await CATALOG_LOADERS[locale]();
  active = locale;
  document.documentElement.lang = locale;
}

function negotiateStoredLocale(stored: unknown, orgDefault: unknown, tags: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  if (isLocale(orgDefault)) return orgDefault;
  return negotiateLocale(tags.join(","), "en");
}

export async function initI18n(opts: { stored?: unknown; orgDefault?: unknown }): Promise<Locale> {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  const locale = negotiateStoredLocale(opts.stored, opts.orgDefault, tags);
  await applyLocale(locale);
  return locale;
}
