import { projectedSessionHistory, projectTapeEntries } from "../../src/harness/tape-projection.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { SessionEntry } from "../../src/types.ts";

export async function projectedEntries(
  sessions: Pick<SessionStore, "getTape">,
  sessionId: string,
): Promise<SessionEntry[]> {
  const projection = projectTapeEntries(sessionId, await sessions.getTape(sessionId), { openTail: true });
  return projection?.entries ?? [];
}

export async function sessionHistoryEntries(
  sessions: Pick<SessionStore, "getTape" | "getEntries" | "latestEntrySeq">,
  sessionId: string,
): Promise<SessionEntry[]> {
  return (await projectedSessionHistory(sessions, sessionId)).entries;
}
