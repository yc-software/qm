export function headSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function snippet(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${headSlice(oneLine, max - 1).trimEnd()}…`;
}

export function tailSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

export function pgTextSafe(s: string): string {
  return s.replaceAll("\u0000", "").toWellFormed();
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

export function untrustedText(value: string): string {
  return promptText(value)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replaceAll("</", "<\\/");
}

export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function flatText(value: string): string {
  return value.replace(/[\s\u0085]+/g, " ").trim();
}

export function quotedData(value: string): string {
  const lines = untrustedText(value)
    .split("\n")
    .map((line) => {
      const text = line.trimStart();
      return text.startsWith("#") && "# \t".includes(text[1] ?? " ") ? `\\${line}` : line;
    });
  return ["```untrusted-data", ...lines, "```"].join("\n");
}

export function trimTrailing(s: string, strip: (char: string) => boolean): string {
  let end = s.length;
  while (end > 0 && strip(s[end - 1]!)) end--;
  return s.slice(0, end);
}

export function trimTrailingSlashes(s: string): string {
  return trimTrailing(s, (char) => char === "/");
}
