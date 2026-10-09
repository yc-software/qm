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
  return JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v));
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

export const MAX_TOOL_RESULT_CHARS = 100_000;
const TRUNCATED_TAIL_CHARS = 10_000;

export function capResultText(t: string): string {
  if (t.length <= MAX_TOOL_RESULT_CHARS) return t;
  const notice =
    `\n…[truncated — full result was ${t.length} chars and the middle was dropped; ` +
    `refetch narrower (filter or paginate the call, or redirect to a file and read it in pieces) if you need it]…\n`;
  return (
    headSlice(t, MAX_TOOL_RESULT_CHARS - TRUNCATED_TAIL_CHARS - notice.length) +
    notice +
    tailSlice(t, TRUNCATED_TAIL_CHARS)
  );
}

export function capPayloadStrings(v: unknown): unknown {
  if (typeof v === "string") return capResultText(v);
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const c = capPayloadStrings(v[i]);
      if (c !== v[i]) (out ??= v.slice())[i] = c;
    }
    return out ?? v;
  }
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      const c = capPayloadStrings(x);
      if (c !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = c;
    }
    return out ?? v;
  }
  return v;
}
