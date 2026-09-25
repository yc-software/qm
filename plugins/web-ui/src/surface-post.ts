export function postCallText(payload: unknown): string | null {
  const p = (payload ?? {}) as { action?: unknown; text?: unknown; files?: unknown };
  if (p.action !== "post" || typeof p.text !== "string") return null;
  if (!p.text.trim() && !(Array.isArray(p.files) && p.files.length)) return null;
  return p.text;
}

export function postResultOk(payload: unknown): boolean {
  const p = (payload ?? {}) as {
    ok?: unknown;
    isError?: unknown;
    error?: unknown;
    denied?: unknown;
    blocked?: unknown;
  };
  return payload != null && p.isError !== true && p.ok !== false && !p.error && p.denied !== true && !p.blocked;
}
