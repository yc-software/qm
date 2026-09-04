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
export function setMentionIndex(index: ReadonlyMap<string, string>): void {
  mentionIdByName = index;
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

export function toSlackMrkdwn(md: string): string {
  if (!md) return md;
  const stash: string[] = [];
  const keep = (s: string): string => `${STASH_OPEN}${stash.push(s) - 1}${STASH_OPEN}`;

  let text = md.replace(/\r\n/g, "\n");

  text = text.replace(/```[\s\S]*?```/g, keep);
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
