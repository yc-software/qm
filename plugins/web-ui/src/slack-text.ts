export type SlackWireSegment =
  { kind: "text"; text: string } | { kind: "mention"; handle: string } | { kind: "link"; href: string; label: string };

export function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function safeHttpHref(url: string): string | null {
  const decoded = decodeSlackEntities(url.trim());
  return /^(?:https?:\/\/|mailto:)/i.test(decoded) ? decoded : null;
}

export function splitOnce(s: string, sep: string): [string, string | undefined] {
  const at = s.indexOf(sep);
  return at < 0 ? [s, undefined] : [s.slice(0, at), s.slice(at + sep.length)];
}

const WIRE_TOKEN = /<([^<>\n]+)>/g;
const BROADCASTS = new Set(["here", "channel", "everyone"]);

function segmentForToken(inner: string): SlackWireSegment {
  if (inner.startsWith("@")) {
    const [id, label] = splitOnce(inner.slice(1), "|");
    return { kind: "mention", handle: decodeSlackEntities(((label ?? "").trim() || id.trim()).replace(/^@+/, "")) };
  }
  if (inner.startsWith("#")) {
    const [id, label] = splitOnce(inner.slice(1), "|");
    return { kind: "text", text: `#${decodeSlackEntities((label ?? "").trim() || id.trim())}` };
  }
  if (inner.startsWith("!")) {
    const [command, label] = splitOnce(inner.slice(1), "|");
    if (BROADCASTS.has(command.toLowerCase())) return { kind: "mention", handle: command.toLowerCase() };
    const subteam = command.startsWith("subteam^");
    const fallback = decodeSlackEntities((label ?? "").trim());
    if (subteam && fallback) return { kind: "mention", handle: fallback.replace(/^@/, "") };
    return { kind: "text", text: fallback || `<${decodeSlackEntities(inner)}>` };
  }
  const [href, label] = splitOnce(inner, "|");
  const safe = safeHttpHref(href);
  if (safe) return { kind: "link", href: safe, label: decodeSlackEntities((label ?? "").trim()) || safe };
  return { kind: "text", text: `<${decodeSlackEntities(inner)}>` };
}

export function splitSlackWire(text: string): SlackWireSegment[] {
  const segments: SlackWireSegment[] = [];
  let cursor = 0;
  const pushText = (raw: string): void => {
    if (raw) segments.push({ kind: "text", text: decodeSlackEntities(raw) });
  };
  for (const match of text.matchAll(WIRE_TOKEN)) {
    pushText(text.slice(cursor, match.index));
    segments.push(segmentForToken(match[1] ?? ""));
    cursor = match.index + match[0].length;
  }
  pushText(text.slice(cursor));
  return segments;
}

export function slackWireToPlain(text: string): string {
  return splitSlackWire(text)
    .map((seg) => {
      if (seg.kind === "mention") return `@${seg.handle}`;
      if (seg.kind === "link") return seg.label;
      return seg.text;
    })
    .join("");
}

const SLACK_MARKS: Record<string, string> = { "*": "**", _: "_", "~": "~~" };
const MARKDOWN_SYNTAX = new Set("\\`*_~[]()<>#+-=.!|&");

function joinsWord(c: string | undefined, mark: string): boolean {
  return c !== undefined && (c === mark || (c >= "0" && c <= "9") || c.toLowerCase() !== c.toUpperCase());
}

function spanClose(text: string, open: number): number {
  const mark = text[open]!;
  const next = text[open + 1];
  if (joinsWord(text[open - 1], mark) || next === undefined || !next.trim() || next === mark) return -1;
  for (let i = open + 1; i < text.length && text[i] !== "\n" && text[i] !== "`"; i++)
    if (text[i] === mark) return !text[i - 1]!.trim() || joinsWord(text[i + 1], mark) ? -1 : i;
  return -1;
}

function codeEnd(text: string, open: number): number {
  const fence = text.startsWith("```", open) ? "```" : "`";
  const close = text.indexOf(fence, open + fence.length);
  if (close < 0 || (fence === "`" && text.slice(open, close).includes("\n"))) return -1;
  return close + fence.length;
}

function slackMarkdown(text: string, lineStart: boolean): string {
  let out = "";
  let leading = lineStart;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c === "`" ? codeEnd(text, i) : -1;
    const close = SLACK_MARKS[c] ? spanClose(text, i) : -1;
    if (code > 0) {
      out += text.slice(i, code);
      i = code - 1;
    } else if (close > 0) {
      out += SLACK_MARKS[c] + slackMarkdown(text.slice(i + 1, close), false) + SLACK_MARKS[c];
      i = close;
    } else if (c === ">" && (i ? text[i - 1] === "\n" : lineStart)) out += c;
    else if (c === " " && leading) out += "\u00a0";
    else out += MARKDOWN_SYNTAX.has(c) ? `\\${c}` : c;
    leading = code < 0 && close < 0 && (c === "\n" || (leading && c === " "));
  }
  return out;
}

export function slackWireToMarkdown(text: string, emojiFor: (name: string) => string | null): string {
  let out = "";
  for (const seg of splitSlackWire(text)) {
    if (seg.kind === "mention") out += `<@${seg.handle}>`;
    else if (seg.kind === "link") out += `[${seg.label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${seg.href}>)`;
    else out += slackMarkdown(withEmoji(seg.text, emojiFor), !out || out.endsWith("\n"));
  }
  return out;
}

const REACTION_DIRECTIVE = /\[\[react:[^[\]]*\]\]/gi;
const TRAILING_OPEN_REACTION = /\[\[react:[^[\]]*$/i;
const ANY_DIRECTIVE = /\[\[react:/i;
const CODE_REGION = /```[\s\S]*?```|`[^`\n]*`/g;
const CODE_PLACEHOLDER = /\u0000CODE(\d+)\u0000/g;

export function stripSlackDirectives(text: string): string {
  if (!text || !ANY_DIRECTIVE.test(text)) return text;
  const code: string[] = [];
  const masked = text.replace(CODE_REGION, (m) => `\u0000CODE${code.push(m) - 1}\u0000`);
  const stripped = masked.replace(REACTION_DIRECTIVE, "").replace(TRAILING_OPEN_REACTION, "");
  if (stripped === masked) return text;
  return stripped
    .replace(CODE_PLACEHOLDER, (_m, i: string) => code[Number(i)] ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const REACTION_PREFIX = "[Slack reaction] ";

export const FORWARD_PREFIX = "[forwarded message from ";

function withEmoji(text: string, emojiFor: (name: string) => string | null): string {
  const parts = text.split(":");
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const emoji = i < parts.length - 1 ? emojiFor(parts[i]!) : null;
    if (emoji) {
      out += emoji + parts[i + 1]!;
      i++;
    } else out += `:${parts[i]}`;
  }
  return out;
}

export function slackPreviewText(text: string, emojiFor: (name: string) => string | null): string {
  return withEmoji(slackWireToPlain(stripSlackDirectives(text)), emojiFor).trim();
}
