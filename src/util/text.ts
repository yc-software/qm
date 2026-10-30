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

function jsonbSafe(_key: string, value: unknown): unknown {
  if (typeof value === "string") return pgTextSafe(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.every((key) => pgTextSafe(key) === key)) return value;
  return Object.fromEntries(keys.map((key) => [pgTextSafe(key), (value as Record<string, unknown>)[key]]));
}

export function jsonbStringify(value: unknown): string {
  return JSON.stringify(value, jsonbSafe);
}

export function outermostJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end < start ? undefined : text.slice(start, end + 1);
}

export function promptText(value: string): string {
  return value.replaceAll("```", "ʼʼʼ");
}
