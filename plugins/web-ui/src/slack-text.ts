export type SlackWireSegment =
  { kind: "text"; text: string } | { kind: "mention"; handle: string } | { kind: "link"; href: string; label: string };

export function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function safeHttpHref(url: string): string | null {
  const decoded = decodeSlackEntities(url.trim());
  return /^(?:https?:\/\/|mailto:)/i.test(decoded) ? decoded : null;
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
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

const REACTION_DIRECTIVE = /\[\[react:[^\]]*\]\]/gi;
const TRAILING_OPEN_REACTION = /\[\[react:[^\]]*$/i;
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
