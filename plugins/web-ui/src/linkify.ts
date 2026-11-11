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
