import type { Locale } from "../../chassis/src/locale.ts";
import { ADMIN_MESSAGES, adminMessage, type AdminMessageKey } from "./messages.ts";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const inertJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export function localizeAdminShell(template: string, locale: Locale): string {
  const withLang = template.replace(/<html\b([^>]*)>/i, (tag, attributes: string) => {
    if (/\slang\s*=/i.test(attributes)) return tag.replace(/\slang\s*=\s*(["'])[^"']*\1/i, ` lang="${locale}"`);
    return `<html lang="${locale}"${attributes}>`;
  });
  const withTokens = withLang.replace(/\{\{t:([A-Za-z0-9.]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(ADMIN_MESSAGES.en, key)) throw new Error(`unknown Admin message: ${key}`);
    return escapeHtml(adminMessage(locale, key as AdminMessageKey));
  });
  return withTokens.replaceAll("__ADMIN_MESSAGES__", () => inertJson(ADMIN_MESSAGES[locale]));
}
