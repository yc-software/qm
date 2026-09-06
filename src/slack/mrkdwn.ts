import { safeChunks } from "./safe-cut.ts";
export function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function resolveMentionsInText(text: string, lookup: (id: string) => string | undefined): string {
  return text.replace(/<@(U\w+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
    const name = (label && label.trim()) || lookup(id);
    return name ? `@${name}` : `@${id}`;
  });
}

export function stripMention(text: string, botUserId: string): string {
  const withoutMention = botUserId ? text.replace(new RegExp(`<@${botUserId}>`, "g"), "") : text;
  return decodeSlackEntities(withoutMention).trim();
}

const BOLD_SENTINEL = String.fromCharCode(1);
const STASH_OPEN = String.fromCharCode(0);

const MASS_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/gi;
export function neutralizeMassMentions(text: string): string {
  return text.replace(MASS_MENTION, (_m, word: string) => `@\u200b${word.toLowerCase()}`);
}

const RESERVED_MENTION_NAMES = new Set(["here", "channel", "everyone"]);

let mentionIdByName: ReadonlyMap<string, string> = new Map();
let mentionNameById: ReadonlyMap<string, string> = new Map();
export function setMentionIndex(index: ReadonlyMap<string, string>): void {
  mentionIdByName = index;
  const byId = new Map<string, string>();
  for (const [name, id] of index) if (!byId.has(id)) byId.set(id, name);
  mentionNameById = byId;
}
const WIRE_MENTION = /<(@[UW]\w+|!(?:here|channel|everyone|subteam\^\w+))(?:\|([^>]*))?>/gi;

function neutralizedMention(kind: string, label: string | undefined): string {
  const name = label?.trim().replace(/^@/, "") || "";
  if (kind.startsWith("@")) return `@${name || mentionNameById.get(kind.slice(1)) || kind.slice(1)}`;
  const command = kind.slice(1);
  if (command.toLowerCase().startsWith("subteam^")) return `@${name || command.slice("subteam^".length)}`;
  return `@\u200b${command.toLowerCase()}`;
}

export function wireMentionKeys(text: string): Set<string> {
  return new Set([...text.matchAll(WIRE_MENTION)].map((m) => m[1]!.toLowerCase()));
}

export function neutralizeMentions(text: string, only?: ReadonlySet<string>): string {
  return text.replace(WIRE_MENTION, (m, kind: string, label?: string) =>
    only && !only.has(kind.toLowerCase()) ? m : neutralizedMention(kind, label),
  );
}

export function isReservedMentionName(name: string): boolean {
  return RESERVED_MENTION_NAMES.has(name);
}

const MENTION_SEGMENT = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}_'-]*[\p{L}\p{N}])?`;
const MENTION_WORD = String.raw`${MENTION_SEGMENT}(?:\.${MENTION_SEGMENT})*`;
const PLAIN_MENTION = new RegExp(
  String.raw`(?<![\p{L}\p{N}<@])@(${MENTION_WORD}(?: ${MENTION_WORD}){0,2})(?![/@])`,
  "gu",
);

function armUserMentions(text: string, wrap: (armed: string) => string = (s) => s): string {
  if (!mentionIdByName.size || !text.includes("@")) return text;
  return text.replace(PLAIN_MENTION, (match, name: string) => {
    const words = name.split(" ");
    for (let n = words.length; n >= 1; n--) {
      const candidate = words.slice(0, n).join(" ");
      const key = candidate.toLowerCase();
      if (RESERVED_MENTION_NAMES.has(key)) continue;
      const id = mentionIdByName.get(key);
      if (!id) continue;
      if (n < words.length && /^\p{Lu}/u.test(words[n] ?? "")) return match;
      return `${wrap(`<@${id}>`)}${name.slice(candidate.length)}`;
    }
    return match;
  });
}

const TILDE_OPENER = /^[ \t]*~{3,}[^\n]*$/m;
const TILDE_CLOSER = /^[ \t]*~{3,}[ \t]*$/m;

function nextLineMatch(text: string, from: number, re: RegExp): { start: number; end: number } | undefined {
  const scoped = new RegExp(re.source, "gm");
  scoped.lastIndex = from;
  const m = scoped.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}

function stashFencedBlocks(text: string, keep: (s: string) => string): string {
  let out = "";
  let i = 0;
  let tildesExhausted = !text.includes("~~~");
  while (i < text.length) {
    const backtick = text.indexOf("```", i);
    const tilde = tildesExhausted ? undefined : nextLineMatch(text, i, TILDE_OPENER);
    if (tilde === undefined && backtick < 0) break;
    if (backtick >= 0 && (tilde === undefined || backtick < tilde.start)) {
      const close = text.indexOf("```", backtick + 3);
      if (close < 0) break;
      out += text.slice(i, backtick) + keep(text.slice(backtick, close + 3));
      i = close + 3;
      continue;
    }
    const opener = tilde!;
    const closer = opener.end < text.length ? nextLineMatch(text, opener.end + 1, TILDE_CLOSER) : undefined;
    if (closer === undefined) {
      tildesExhausted = true;
      continue;
    }
    const info = text.slice(opener.start, opener.end).replace(/^[ \t]*~+/, "");
    const body = text.slice(opener.end + 1, closer.start);
    const block = text.slice(opener.start, closer.end);
    out += text.slice(i, opener.start);
    out += keep(body.includes("```") ? block : "```" + info + "\n" + body + "```");
    i = closer.end;
  }
  return out + text.slice(i);
}

export function toSlackMrkdwn(md: string): string {
  if (!md) return md;
  const stash: string[] = [];
  const keep = (s: string): string => `${STASH_OPEN}${stash.push(s) - 1}${STASH_OPEN}`;

  let text = md.replace(/\r\n/g, "\n");

  text = stashFencedBlocks(text, keep);
  text = text.replace(/`[^`\n]+`/g, keep);
  text = neutralizeMassMentions(text);

  text = reformatTables(text, keep);

  text = text.replace(/!?\[([^\]]*)\]\(\s*<?([^()\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, url) =>
    keep(label ? `<${url}|${label}>` : `<${url}>`),
  );

  text = text.replace(/<(?:https?:\/\/|mailto:|[@#!])[^<>\n\x00]*>/g, keep);
  text = text.replace(/(?<![a-zA-Z0-9])https?:\/\/[^\s<>|\x00\x01]+/g, (url) => {
    const kept = trimUrlTail(url);
    return keep(`<${kept}>`) + url.slice(kept.length);
  });

  text = armUserMentions(text, keep);

  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "──────────");

  text = text.replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);
  text = text.replace(/__(?!\s)([^\n]+?)(?<!\s)__/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);

  text = text.replace(/~~(?!\s)([^\n]+?)(?<!\s)~~/g, "~$1~");

  text = text.replace(
    /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/gm,
    (_m, h) => `${BOLD_SENTINEL}${(h as string).replaceAll(BOLD_SENTINEL, "")}${BOLD_SENTINEL}`,
  );

  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");

  text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1_$2_");

  text = text.replaceAll(BOLD_SENTINEL, "*");
  text = text.replace(new RegExp(`${STASH_OPEN}(\\d+)${STASH_OPEN}`, "g"), (_m, i) => stash[Number(i)] ?? "");

  return text;
}

function trimUrlTail(url: string): string {
  const openerOf: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if ("*_~.,;:!?'\"".includes(ch)) {
      end--;
      continue;
    }
    const opener = openerOf[ch];
    if (opener) {
      const head = url.slice(0, end);
      const opens = head.split(opener).length - 1;
      const closes = head.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

const stripEdgePipes = (t: string): string => t.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
const splitTableRow = (line: string): string[] =>
  stripEdgePipes(line.trim())
    .split("|")
    .map((c) => c.trim());
const looksLikeTableRow = (line: string | undefined): boolean =>
  line != null && line.includes("|") && line.trim().length > 0;

function isTableDelimiter(line: string | undefined): boolean {
  if (line == null || !line.includes("-")) return false;
  const cells = stripEdgePipes(line.trim()).split("|");
  return cells.length >= 1 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function renderAlignedTable(rows: string[][]): string {
  const ncols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: ncols }, (_, c) => Math.max(1, ...rows.map((r) => (r[c] ?? "").length)));
  const fmtRow = (r: string[]): string =>
    widths
      .map((w, c) => (r[c] ?? "").padEnd(w))
      .join(" | ")
      .trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const [head, ...body] = rows;
  return [fmtRow(head ?? []), sep, ...body.map(fmtRow)].join("\n");
}

function reformatTables(text: string, keep: (s: string) => string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeTableRow(lines[i]) && isTableDelimiter(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(lines[i]!)];
      let j = i + 2;
      for (; j < lines.length && looksLikeTableRow(lines[j]); j++) rows.push(splitTableRow(lines[j]!));
      out.push(keep("```\n" + renderAlignedTable(rows) + "\n```"));
      i = j - 1;
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join("\n");
}

export function slackSectionBlocks(text: string): Array<Record<string, unknown>> {
  return safeChunks(text, 2_900).map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } }));
}
