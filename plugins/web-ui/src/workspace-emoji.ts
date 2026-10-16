import { withBase } from "./core-bridge";
import type { EmojiRow } from "./emoji-data";
import { rowForName } from "./emoji-picker";

export type CompletionEmoji = EmojiRow & { url?: string; custom?: boolean };

function workspaceEmojiRows(catalog: Record<string, string>): CompletionEmoji[] {
  const rows: CompletionEmoji[] = [];
  for (const name of Object.keys(catalog)) {
    if (!/^[a-zA-Z0-9_+-]+$/.test(name)) continue;
    const seen = new Set<string>();
    let target = name;
    let value = catalog[target];
    while (typeof value === "string" && value.startsWith("alias:") && !seen.has(target)) {
      seen.add(target);
      target = value.slice(6);
      value = catalog[target];
    }
    if (typeof value === "string" && value.startsWith("https://")) {
      try {
        const url = new URL(value);
        if (url.username || url.password) continue;
        rows.push({ n: name, c: `:${name}:`, g: "Workspace", url: url.href, custom: true });
      } catch {
        continue;
      }
    } else if (!value && rowForName(target)) {
      rows.push({ n: name, c: `:${name}:`, g: "Workspace", a: [target], custom: true });
    }
  }
  return rows;
}

let rows: CompletionEmoji[] = [];
let expires = 0;
let pending: Promise<CompletionEmoji[]> | undefined;
export function loadWorkspaceEmoji(): Promise<CompletionEmoji[]> {
  if (Date.now() < expires) return Promise.resolve(rows);
  if (pending) return pending;
  pending = fetch(withBase("/api/slack/emoji"), { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) return rows;
      const data = await response.json();
      rows = workspaceEmojiRows(data.emoji ?? {});
      expires = Date.now() + 5 * 60_000;
      return rows;
    })
    .catch(() => rows)
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
