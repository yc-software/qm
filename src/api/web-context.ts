import type { SurfaceContextQuery, SurfaceContextResult } from "../types.ts";
import { isUserMessage, type Item } from "../sessions/items.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";

const WEB_CONTEXT_MESSAGE_CHARS = 600;
const WEB_CONTEXT_READ_CAP = 500;

type WindowMessage = { ts: string; time: string; author: string; text: string; threadTs: string };

function ownerOfWebThread(threadRef: string): string | null {
  const m = threadRef.match(/^web:(.+):[^:]+$/);
  return m ? m[1]! : null;
}

function contextTs(seq: unknown): string {
  return String(typeof seq === "number" ? seq : 0).padStart(12, "0");
}

function clip(t: string): string {
  return t.length > WEB_CONTEXT_MESSAGE_CHARS ? `${t.slice(0, WEB_CONTEXT_MESSAGE_CHARS)}…` : t;
}

export function webConversationWindow(
  entries: readonly Item[],
  owner: string,
  threadRoot: string,
  q: Partial<Pick<SurfaceContextQuery, "count" | "before" | "match">>,
): SurfaceContextResult {
  const sentCallIds = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "ToolResult") continue;
    if (e.callId && e.body.action === "post" && e.isError !== true && e.body.ok !== false) sentCallIds.add(e.callId);
  }
  const all: WindowMessage[] = [];
  const self = new Set<string>();
  for (const e of entries) {
    const p = e.body;
    const time = new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ");
    if (isUserMessage(e) && !e.hidden) {
      const text = e.text ?? "";
      const display = typeof p.display === "string" && p.display.trim() ? p.display : text;
      if (display.trim()) {
        all.push({
          ts: contextTs(e.seq),
          time,
          author: typeof p.name === "string" && p.name ? p.name : owner,
          text: clip(display),
          threadTs: threadRoot,
        });
      }
    } else if (
      e.kind === "ToolCall" &&
      p.action === "post" &&
      typeof p.text === "string" &&
      p.text.trim() &&
      e.callId &&
      sentCallIds.has(e.callId)
    ) {
      all.push({ ts: contextTs(e.seq), time, author: "you", text: clip(p.text), threadTs: threadRoot });
      self.add(contextTs(e.seq));
    }
  }
  const bounded = q.before ? all.filter((m) => m.ts < q.before!) : all;
  const needle = q.match?.trim().toLowerCase();
  const matched = needle ? bounded.filter((m) => m.text.toLowerCase().includes(needle)) : bounded;
  const count = Math.max(1, Math.min(WEB_CONTEXT_READ_CAP, Number(q.count) || 100));
  const kept = matched.slice(-count);
  const hasMore = matched.length > kept.length;
  const selfTs = kept.filter((m) => self.has(m.ts)).map((m) => m.ts);
  return {
    messages: kept,
    hasMore,
    ...(hasMore && kept[0] ? { nextBefore: kept[0].ts } : {}),
    ...(selfTs.length ? { selfTs } : {}),
  };
}

export async function answerWebContextRequest(
  sessions: Pick<
    SessionStore,
    "sessionsByThreadRefs" | "visibleItems" | "getItems" | "countItemsBefore" | "latestItemSeq" | "participantWindowsOf"
  >,
  query: SurfaceContextQuery,
): Promise<{ result?: SurfaceContextResult; error?: string }> {
  if (query.file)
    return { error: "the web surface can't fetch files this way — shared files are already in the workspace" };
  if (typeof query.searchAll === "string" && query.searchAll)
    return { result: { messages: [], liveSearch: "unconfigured" } };
  const target = query.conversationTarget;
  if (!target) return { error: "only this conversation is readable on the web surface" };
  const owner = ownerOfWebThread(target);
  if (!owner) return { error: "that conversation isn't readable on the web surface" };
  const [session] = await sessions.sessionsByThreadRefs([target]);
  if (!session) return { error: "that conversation isn't readable on the web surface" };
  const viewer = query.viewer?.trim() || owner;
  const { items } = await createTranscriptSource(sessions).forViewer(session.id, viewer);
  const root = target.slice(target.lastIndexOf(":") + 1);
  return { result: webConversationWindow(items, owner, root, query) };
}
