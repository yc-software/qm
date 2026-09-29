import type { Principal } from "../../types.ts";

const MENTION_BODY = /^[\p{L}\p{N}_.·-]+/u;

export function mentionsOtherMember(
  text: string,
  audience: readonly Principal[],
  selfId: string,
  botName: string,
): boolean {
  if (!text.includes("@")) return false;
  const bot = botName.trim().toLowerCase();
  if (bot && text.toLowerCase().includes(bot)) return false;
  const names = audience
    .filter((p) => p.id !== selfId && p.displayName?.trim())
    .map((p) => p.displayName!.trim().toLowerCase());
  if (!names.length) return false;
  const tokens = new Set<string>();
  let i = text.indexOf("@");
  while (i !== -1) {
    const prev = i > 0 ? text[i - 1]! : "";
    const m = text.slice(i + 1).match(MENTION_BODY);
    if (m && m[0] && !/[A-Za-z0-9]/.test(prev)) tokens.add(m[0].toLowerCase());
    i = text.indexOf("@", i + 1);
  }
  return [...tokens].some((t) =>
    names.some((n) => {
      if (n === t) return true;
      if (t.length < 2 || n.length < 2) return false;
      if (n.startsWith(t)) return true;
      return t.startsWith(n) && /[^\x00-\x7F]/.test(t.slice(n.length));
    }),
  );
}
