import { normalizeLocale, type Locale } from "../../chassis/src/locale.ts";
import { webMessage, type WebMessageKey } from "./messages.ts";

export function locale(): Locale {
  return normalizeLocale(document.querySelector<HTMLMetaElement>('meta[name="qm-locale"]')?.content) ?? "en";
}

export function t(key: WebMessageKey, values?: Readonly<Record<string, string | number>>): string {
  return webMessage(locale(), key, values);
}
