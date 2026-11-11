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
