export const SUPPORTED_LOCALES = ["en", "zh-CN", "ja", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
