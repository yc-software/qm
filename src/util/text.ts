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

export function pgTextSafeOrNull(s: string | null | undefined): string | null {
  return s === undefined || s === null ? null : pgTextSafe(s);
}

export function pgTextSafe(s: string): string {
  const out = s.includes("\u0000") ? s.replaceAll("\u0000", "") : s;
  return out.isWellFormed() ? out : out.toWellFormed();
}

function withPgSafeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj);
  const safeKeys = keys.map(pgTextSafe);
  if (safeKeys.every((safe, i) => safe === keys[i])) return obj;
  const taken = new Set(keys.filter((k, i) => safeKeys[i] === k && obj[k] !== undefined));
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  keys.forEach((k, i) => {
    const safe = safeKeys[i]!;
    if (safe === k) {
      if (obj[k] !== undefined) out[k] = obj[k];
    } else if (!taken.has(safe)) {
      taken.add(safe);
      out[safe] = obj[k];
    }
  });
  return out;
}

const JSONB_REJECTED_ESCAPE = /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f])/i;

function pgSafeReplacer(_key: string, v: unknown): unknown {
  if (typeof v === "string") return pgTextSafe(v);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return withPgSafeKeys(v as Record<string, unknown>);
  return v;
}

export function jsonbSafeStringify(value: unknown): string {
  const plain = JSON.stringify(value);
  return JSONB_REJECTED_ESCAPE.test(plain) ? JSON.stringify(value, pgSafeReplacer) : plain;
}

export function pgSafeValue<T>(value: T): T {
  const plain = JSON.stringify(value);
  return JSONB_REJECTED_ESCAPE.test(plain) ? (JSON.parse(JSON.stringify(value, pgSafeReplacer)) as T) : value;
}
