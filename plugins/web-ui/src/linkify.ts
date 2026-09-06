export type LinkSegment = { kind: "text"; text: string } | { kind: "link"; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;

function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1] ?? "";
    if (".,;:!?".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")" && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

export type MentionSegment = { kind: "text"; text: string } | { kind: "mention"; handle: string };

const MENTION_RE = /@[A-Za-z0-9][A-Za-z0-9._-]*/g;

function trimHandle(handle: string): string {
  let out = handle;
  while (out && "._-".includes(out[out.length - 1] ?? "")) out = out.slice(0, -1);
  return out;
}

export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index;
    if (/[\w.@<-]/.test(text[start - 1] ?? "")) continue;
    const handle = trimHandle(match[0].slice(1));
    if (!handle) continue;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "mention", handle });
    cursor = start + 1 + handle.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export function splitLinks(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const href = trimTrailing(raw);
    if (!href) continue;
    const start = match.index;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "link", href });
    cursor = start + href.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
