export const RECALL_MAX_CHARS = 6_000;

export function dateStr(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
