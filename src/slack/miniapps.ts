import { extractDirectives } from "./directives.ts";
import { clip } from "./util.ts";

export interface MiniappEmbed {
  url: string;
  title: string;
}

const MINIAPP_DIRECTIVE = /\[\[miniapp:\s*(\S+?)\s*(?:\|\s*([^\]]*?))?\]\]/gi;
const TRAILING_OPEN_MINIAPP_DIRECTIVE = /\[\[miniapp:[\s\S]*$/i;
const BUTTON_TEXT_MAX = 75;
const MAX_MINIAPPS = 5;

export function parseMiniappUrl(raw: string): string | null {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (value.startsWith("/m/")) {
    const parts = value.slice(3).split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] && parts[1]) return `/m/${parts[0]}/${parts[1]}`;
    return null;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "m" || parts.length !== 3) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function extractMiniapps(reply: string): { text: string; miniapps: MiniappEmbed[] } {
  const { text, matches } = extractDirectives(
    reply,
    MINIAPP_DIRECTIVE,
    TRAILING_OPEN_MINIAPP_DIRECTIVE,
    ([url, title]) => {
      const parsed = parseMiniappUrl(url ?? "");
      if (!parsed) return undefined;
      const label = (title ?? "").trim() || "Playground";
      return { url: parsed, title: label };
    },
  );
  const seen = new Set<string>();
  const miniapps: MiniappEmbed[] = [];
  for (const item of matches) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    miniapps.push(item);
  }
  return { text, miniapps: miniapps.slice(0, MAX_MINIAPPS) };
}

export function stripMiniappDirectives(partial: string): string {
  if (!partial) return partial ?? "";
  return extractMiniapps(partial).text;
}

export function miniappActionBlocks(miniapps: readonly MiniappEmbed[]): Array<Record<string, unknown>> {
  const buttons = miniapps
    .filter((m) => /^https?:\/\//i.test(m.url))
    .slice(0, MAX_MINIAPPS)
    .map((m, i) => ({
      type: "button",
      action_id: `miniapp_open:${i}`,
      text: { type: "plain_text", text: clip(m.title, BUTTON_TEXT_MAX) || "Open playground" },
      url: m.url,
    }));
  if (!buttons.length) return [];
  return [{ type: "actions", block_id: "miniapp_open", elements: buttons }];
}
