import { appendCoverageImport } from "../src/harness/replay.ts";
import { lastImportLacksScopes } from "../src/harness/tape-fold.ts";
import { openSessionStore, parseBackfillArgs, resolveSessions, runBackfill } from "./lib/backfill-runner.ts";

const { apply, only, force } = parseBackfillArgs("a fleet-wide forced re-import flattens every tape; target it");

const store = openSessionStore();
const sessions = await resolveSessions(store, only);

const needsImport = async (sessionId: string, latestSeq: number): Promise<boolean> =>
  force || (await store.tapeCoverage(sessionId)) < latestSeq || lastImportLacksScopes(await store.getTape(sessionId));

await runBackfill({
  verb: { dry: "would import", done: "imported" },
  store,
  sessions,
  apply,
  preview: async (session) => {
    const latest = await store.getEntries(session.id, { limit: 1 });
    if (!latest.length) return { action: "skip", reason: "empty", quiet: true };
    if (!(await needsImport(session.id, latest[0]!.seq))) return { action: "skip", reason: "covered", quiet: true };
    return { action: "work", detail: `through seq ${latest[0]!.seq}` };
  },
  applyStep: async (session, lease) => {
    const held = await store.getEntries(session.id);
    const heldMax = held.length ? held[held.length - 1]!.seq : -1;
    if (heldMax < 0) return { action: "skip", reason: "empty", quiet: true };
    if (!(await needsImport(session.id, heldMax))) return { action: "skip", reason: "covered", quiet: true };
    const record = await appendCoverageImport(store, lease, held, session.scopeId);
    if (!record) return { action: "skip", reason: "unservable (oversize/tainted/empty)" };
    return { action: "work", detail: `${held.length} entries, through seq ${heldMax}` };
  },
});
