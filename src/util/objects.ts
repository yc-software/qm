export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_k, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }),
    );
  });
}
