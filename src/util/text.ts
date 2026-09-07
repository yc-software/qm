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

export function hasLoneSurrogate(s: string): boolean {
  return !s.isWellFormed();
}

export function pgTextSafeOrNull(s: string | null | undefined): string | null {
  return s === undefined || s === null ? null : pgTextSafe(s);
}

export function pgTextSafe(s: string): string {
  const out = s.includes("\u0000") ? s.replaceAll("\u0000", "") : s;
  return out.isWellFormed() ? out : out.toWellFormed();
}

function withPgSafeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  let dirty = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const safe = pgTextSafe(k);
    if (safe !== k) dirty = true;
    if (safe === k || !Object.hasOwn(obj, safe)) out[safe] = obj[k];
  }
  return dirty ? out : obj;
}

const JSONB_REJECTED_ESCAPE = /\\u0000|\\ud[89a-f]/i;

function pgSafeReplacer(_key: string, v: unknown): unknown {
  if (typeof v === "string") return pgTextSafe(v);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return withPgSafeKeys(v as Record<string, unknown>);
  return v;
}

export function jsonbSafeStringify(value: unknown): string {
  const plain = JSON.stringify(value);
  return JSONB_REJECTED_ESCAPE.test(plain) ? JSON.stringify(value, pgSafeReplacer) : plain;
}
