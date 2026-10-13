import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { GetEntriesOptions, GetTapeOptions, SessionStore } from "../src/sessions/session-store.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { scopeId } from "../src/types.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `earlier transcript pages stay bounded and tile the session, even across a projection gap: ${backend}`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async () => {
      const store =
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
      const scope = scopeId("channel", "paging-test");
      const session = await store.getOrCreateByThread(`channel:paging-test:${randomUUID()}`, "channel", scope);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.appendMany(
        lease,
        Array.from({ length: 600 }, (_, i) => ({
          type: i % 2 ? ("assistant" as const) : ("user" as const),
          payload: { text: `message ${i}` },
          scopeLabel: scope,
        })),
      );
      await store.releaseLease(lease);
      if (backend === "postgres") {
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          await pool.query(
            `DELETE FROM session_tape WHERE session_id = $1 AND entry_seq = 250
               AND kind = 'annotation' AND safe_json(payload)->>'event' = 'transcript_entry'`,
            [session.id],
          );
        } finally {
          await pool.end();
        }
      }
      const reads: Array<{ kind: string; opts: GetTapeOptions | GetEntriesOptions | undefined }> = [];
      const spied: SessionStore = {
        ...store,
        getTape: (id: string, opts?: GetTapeOptions) => {
          reads.push({ kind: "tape", opts });
          return store.getTape(id, opts);
        },
        getEntries: (id: string, opts?: GetEntriesOptions) => {
          reads.push({ kind: "entries", opts });
          return store.getEntries(id, opts);
        },
      };
      const source = createTranscriptSource(spied);
      const all = (await store.getEntries(session.id)).map((e) => e.seq);
      const seen: number[] = [];
      let beforeSeq: number | undefined;
      for (;;) {
        const page = (await source.forRender(session.id, { limit: 101, beforeSeq })).entries;
        assert.ok(page.length <= 101);
        const fresh = page.length > 100 ? page.slice(1) : page;
        seen.unshift(...fresh.map((e) => e.seq));
        if (page.length <= 100) break;
        beforeSeq = fresh[0]!.seq;
      }
      assert.deepEqual(seen, all);
      assert.ok(
        reads.every((r) => r.opts && "limit" in r.opts && r.opts.limit !== undefined),
        `every fallback read is bounded: ${JSON.stringify(reads)}`,
      );
      if (backend === "postgres")
        assert.ok(
          reads.some((r) => r.kind === "entries"),
          "the gap exercised the fallback",
        );
    },
  );
}
