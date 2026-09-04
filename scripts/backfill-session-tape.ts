import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { coverageImportEvent } from "../src/harness/replay.ts";
import { lastImportLacksScopes } from "../src/harness/tape-fold.ts";
import type { SessionEntry } from "../src/types.ts";

const apply = process.argv.includes("--apply");
const only = process.argv.includes("--session") ? process.argv[process.argv.indexOf("--session") + 1] : undefined;
const force = process.argv.includes("--force");

if (force && !only) {
  console.error("--force requires --session (a fleet-wide forced re-import flattens every tape; target it)");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const store = createPostgresSessionStore(url);

const needsScopesReimport = async (sessionId: string): Promise<boolean> =>
  lastImportLacksScopes(await store.getTape(sessionId));

const unservable = (entries: readonly SessionEntry[]): boolean =>
  entries.length > 500 ||
  entries.some((e) => (e.payload as { securityTainted?: unknown } | null)?.securityTainted === true);

const sessions = only ? [await store.get(only)].filter((s) => s !== null) : await store.listAll();
let imported = 0;
let covered = 0;
let empty = 0;
let busy = 0;
let skipped = 0;
let failed = 0;

for (const session of sessions) {
  try {
    const latest = await store.getEntries(session.id, { limit: 1 });
    if (!latest.length) {
      empty++;
      continue;
    }
    if (
      !force &&
      (await store.tapeCoverage(session.id)) >= latest[0]!.seq &&
      !(await needsScopesReimport(session.id))
    ) {
      covered++;
      continue;
    }
    if (!apply) {
      imported++;
      console.log(`would import ${session.id} (through seq ${latest[0]!.seq})`);
      continue;
    }
    const { lease } = await store.acquireLease(session.id, "backfill");
    if (!lease) {
      busy++;
      console.log(`busy, skipped: ${session.id}`);
      continue;
    }
    try {
      const held = await store.getEntries(session.id);
      const heldMax = held.length ? held[held.length - 1]!.seq : -1;
      if (!force && (await store.tapeCoverage(session.id)) >= heldMax && !(await needsScopesReimport(session.id))) {
        covered++;
        continue;
      }
      if (unservable(held)) {
        skipped++;
        console.log(`unservable (oversize/tainted), skipped: ${session.id}`);
        continue;
      }
      await store.appendTape(lease, {
        kind: "context_event",
        payload: coverageImportEvent(held),
        scopeLabel: session.scopeId,
        coversEntrySeq: heldMax,
      });
      imported++;
      console.log(`imported ${session.id} (${held.length} entries, through seq ${heldMax})`);
    } finally {
      await store.releaseLease(lease);
    }
  } catch (err) {
    failed++;
    console.error(`failed ${session.id}:`, err instanceof Error ? err.message : err);
  }
}

console.log(
  `${apply ? "imported" : "would import"} ${imported}, already covered ${covered}, empty ${empty}, busy ${busy}, unservable ${skipped}, failed ${failed} (of ${sessions.length} sessions)`,
);
process.exit(failed ? 1 : 0);
