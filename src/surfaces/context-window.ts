import { utcMinute } from "../util/time.ts";

interface ContextReaction {
  name: string;
  count: number;
}

export interface ContextWireMessage {
  ts: string;
  time?: string;
  author: string;
  text: string;
  threadTs?: string;
  files?: string[];
  reactions?: ContextReaction[];
}

export interface ContextSourceMessage {
  ts: string;
  name: string;
  text: string;
  isSelf?: boolean;
  parentTs?: string;
  files?: string[];
  reactions?: ContextReaction[];
}

export function clipText(t: string, max: number): string {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function epochTsTime(ts: string): string {
  const sec = Number(ts);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return utcMinute(sec * 1000);
}

export function compareTs(a: { ts: string }, b: { ts: string }): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return 0;
}

export function buildContextWindow(
  scanned: readonly ContextSourceMessage[],
  opts: {
    count: number;
    match?: string;
    scanHasMore?: boolean;
    renderText?: (text: string) => string;
  },
): { messages: ContextWireMessage[]; hasMore: boolean; nextBefore?: string; selfTs?: string[] } {
  const asc = [...scanned].sort(compareTs);
  const needle = opts.match?.trim().toLowerCase();
  const matched = needle ? asc.filter((m) => (m.text ?? "").toLowerCase().includes(needle)) : asc;
  const count = Math.max(1, Math.floor(opts.count));
  const kept = matched.slice(-count);
  const render = opts.renderText ?? ((text: string) => text);
  const messages = kept.map((m) => {
    const time = epochTsTime(m.ts);
    const text = render(m.text ?? "");
    return {
      ts: m.ts,
      ...(time ? { time } : {}),
      author: m.isSelf ? "you" : m.name || "someone",
      text,
      ...(m.parentTs ? { threadTs: m.parentTs } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
      ...(m.reactions ? { reactions: m.reactions } : {}),
    };
  });
  const droppedMatches = matched.length > kept.length;
  let nextBefore = opts.scanHasMore ? asc[0]?.ts : undefined;
  if (droppedMatches) nextBefore = kept[0]?.ts;
  const selfTs = kept.filter((m) => m.isSelf).map((m) => m.ts);
  return {
    messages,
    hasMore: Boolean(opts.scanHasMore) || droppedMatches,
    ...(nextBefore ? { nextBefore } : {}),
    ...(selfTs.length ? { selfTs } : {}),
  };
}
