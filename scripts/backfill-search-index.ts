import { syncSearchIndex } from "../src/harness/tape-projection.ts";
import { openSessionStore, parseBackfillArgs, resolveSessions, runBackfill } from "./lib/backfill-runner.ts";

const { apply, only } = parseBackfillArgs();

const store = openSessionStore();
const sessions = await resolveSessions(store, only);

await runBackfill({
  verb: { dry: "would index", done: "indexed" },
  store,
  sessions,
  apply,
  preview: async (session) => {
    const latest = await store.latestEntrySeq(session.id);
    if (latest < 0) return { action: "skip", reason: "empty", quiet: true };
    const lastSearchable = await store.lastSearchableEntrySeq(session.id);
    const watermark = await store.searchIndexCoverage(session.id);
    if (watermark >= lastSearchable) return { action: "skip", reason: "covered", quiet: true };
    return { action: "work", detail: `seq ${watermark + 1}..${lastSearchable}` };
  },
  applyStep: async (_session, lease) => {
    const sync = await syncSearchIndex(store, lease);
    if (!sync.servable) return { action: "skip", reason: "unservable projection (entries index keeps serving)" };
    return { action: "work", detail: `${sync.indexed} rows, covered through seq ${sync.coveredSeq}` };
  },
});
