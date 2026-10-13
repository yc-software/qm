export function headSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function tailSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

export function jsonbSafeStringify(value: unknown): string {
  const normalized = new WeakMap<object, object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return pgTextSafe(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const existing = normalized.get(item);
    if (existing) return existing;
    const keys = Object.keys(item);
    if (keys.every((key) => key === pgTextSafe(key))) return item;
    const result = Object.fromEntries(keys.map((key) => [pgTextSafe(key), (item as Record<string, unknown>)[key]]));
    normalized.set(item, result);
    return result;
  });
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE, "g");

export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

export function pgTextSafe(s: string): string {
  let out = s;
  if (out.includes("\u0000")) out = out.replaceAll("\u0000", "");
  if (hasLoneSurrogate(out)) out = out.replace(LONE_SURROGATE_ALL, "\uFFFD");
  return out;
}

export function absoluteAppLinks(text: string, baseUrl: string | undefined): string {
  if (!baseUrl) return text;
  return text.replace(
    /(^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\2[ \t]*$|(`+)[^\n]*?\3)|\[([^\]\n]+)\]\((\/d\/[^\s)]+)\)/gm,
    (match, code, _fence, _ticks, label, path) => (code ? match : `[${label}](${new URL(path, baseUrl).href})`),
  );
}
