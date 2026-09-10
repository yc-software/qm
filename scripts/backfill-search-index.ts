import { projectedSessionHistory, searchRowsFromEntries } from "../src/harness/tape-projection.ts";
import type { NewSearchEntry, SessionStore } from "../src/sessions/session-store.ts";
import { openSessionStore, parseBackfillArgs, resolveSessions, runBackfill } from "./lib/backfill-runner.ts";

const { apply, only } = parseBackfillArgs();

const store = openSessionStore();
const sessions = await resolveSessions(store, only);

async function tapeSide(
  store: SessionStore,
  sessionId: string,
): Promise<{ unservable: boolean; rows: NewSearchEntry[] }> {
  const view = await projectedSessionHistory(store, sessionId);
  if (view.fromArchive) return { unservable: view.rows.length > 0, rows: [] };
  return { unservable: false, rows: searchRowsFromEntries(view.entries, -1) };
}

await runBackfill({
  verb: { dry: "would index", done: "indexed" },
  store,
  sessions,
  apply,
  preview: async (session) => {
    const missing = await store.missingSearchEntries(session.id);
    const tape = await tapeSide(store, session.id);
    const coverage = await store.searchIndexCoverage(session.id);
    const tapeBehind = tape.rows.filter((row) => row.seq > coverage).length;
    if (!missing && !tapeBehind) {
      if (tape.unservable)
        return { action: "skip", reason: "archive covered; tape unservable — re-import to index it" };
      return { action: "skip", reason: "covered", quiet: true };
    }
    const parts = [
      ...(missing ? [`${missing} missing archive messages`] : []),
      ...(tapeBehind ? [`${tapeBehind} missing tape messages`] : []),
      ...(tape.unservable ? ["tape unservable"] : []),
    ];
    return { action: "work", detail: parts.join("; ") };
  },
  applyStep: async (session, lease) => {
    const tape = await tapeSide(store, session.id);
    const rows = [...searchRowsFromEntries(await store.getEntries(session.id), -1), ...tape.rows];
    for (let i = 0; i < rows.length; i += 500) {
      await store.appendSearchEntries(lease, rows.slice(i, i + 500));
    }
    const missing = await store.missingSearchEntries(session.id);
    if (missing) throw new Error(`${missing} searchable archive messages remain unindexed`);
    const coverage = await store.searchIndexCoverage(session.id);
    const tapeBehind = tape.rows.filter((row) => row.seq > coverage).length;
    if (tapeBehind) throw new Error(`${tapeBehind} searchable tape messages remain unindexed`);
    return {
      action: "work",
      detail: tape.unservable
        ? "archive covered; tape unservable — re-import the session to index its tape"
        : "all searchable messages covered",
    };
  },
});
