import { api } from "./core-bridge.ts";

const labels = new Map<string, string>();

export async function loadScopeLabels(scopes: Iterable<string>): Promise<void> {
  const missing = [...new Set(scopes)].filter((scope) => scope.startsWith("personal:") && !labels.has(scope));
  if (!missing.length) return;
  const query = missing.map((scope) => `scope=${encodeURIComponent(scope)}`).join("&");
  rememberScopeLabels((await api<{ labels: Record<string, string> }>(`/api/scope-labels?${query}`)).labels);
}

export function scopePerson(scope: string): string {
  return (labels.get(scope) ?? scope).slice("personal:".length);
}

export function rememberScopeLabels(found: Record<string, string> | undefined): void {
  for (const [scope, label] of Object.entries(found ?? {})) labels.set(scope, label);
}
