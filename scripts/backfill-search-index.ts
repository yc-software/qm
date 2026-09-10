import { searchRowsFromEntries } from "../src/harness/tape-projection.ts";
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
    const missing = await store.missingSearchEntries(session.id);
    if (!missing) return { action: "skip", reason: "covered", quiet: true };
    return { action: "work", detail: `${missing} missing messages` };
  },
  applyStep: async (session, lease) => {
    const rows = searchRowsFromEntries(await store.getEntries(session.id), -1);
    for (let i = 0; i < rows.length; i += 500) {
      await store.appendSearchEntries(lease, rows.slice(i, i + 500));
    }
    const missing = await store.missingSearchEntries(session.id);
    if (missing) throw new Error(`${missing} searchable messages remain unindexed`);
    return { action: "work", detail: "all searchable messages covered" };
  },
});
