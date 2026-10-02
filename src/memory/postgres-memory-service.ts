import { isDeepStrictEqual } from "node:util";
import { parseMemoryRecords, renderMemoryRecords, restoreMemoryRecords, type MemoryRecords } from "./records.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { captureRecords, queryBullets, recallBody, replaceRecords, type MemoryService } from "./memory-service.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memory_revisions(
    id        BIGSERIAL PRIMARY KEY,
    scope_id  TEXT   NOT NULL,
    seq       BIGINT NOT NULL,
    op        TEXT   NOT NULL,
    body      TEXT   NOT NULL,
    author    TEXT,
    at        BIGINT NOT NULL,
    UNIQUE (scope_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_revisions_by_scope ON memory_revisions(scope_id, seq DESC)`,
];

export function createPostgresMemoryService(connectionString: string): MemoryService {
  const { q, pool } = createPgPool(connectionString, [
    { id: "memory/store/0001", statements: SCHEMA },
    {
      id: "memory/store/0002-records",
      statements: ["ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS records JSONB"],
    },
  ]);

  type Row = { body?: unknown; seq?: unknown; at?: unknown; records?: unknown } | undefined;

  function recordsFor(scopeId: string, row: Row): MemoryRecords {
    return parseMemoryRecords(scopeId, String(row?.body ?? ""), row?.records ?? undefined);
  }

  function bodyFor(scopeId: string, row: Row): string {
    return row?.records == null ? String(row?.body ?? "") : renderMemoryRecords(recordsFor(scopeId, row));
  }

  const HEAD = "SELECT body, seq, at, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1";

  async function headRow(scopeId: string): Promise<Row> {
    return (await q(HEAD, [scopeId]))[0];
  }

  async function currentBody(scopeId: string): Promise<string> {
    return bodyFor(scopeId, await headRow(scopeId));
  }

  async function mutate(
    scopeId: string,
    op: string,
    at: number,
    author: string | undefined,
    expectedSeq: number | undefined,
    derive: (
      current: MemoryRecords,
      seq: number,
      client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }> },
    ) => Promise<MemoryRecords | null>,
  ): Promise<boolean> {
    return withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const row = (await client.query(HEAD, [scopeId])).rows[0] as Row;
      const seq = Number(row?.seq ?? 0);
      if (expectedSeq !== undefined && seq !== expectedSeq) return false;
      const current = recordsFor(scopeId, row);
      const records = await derive(current, seq, client);
      if (!records || (!row && !records.records.length)) return true;
      const body = renderMemoryRecords(records);
      if (body !== bodyFor(scopeId, row) || !isDeepStrictEqual(records, current)) {
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at, records) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [scopeId, seq + 1, op, body, author ?? null, at, JSON.stringify(records)],
        );
      }
      return true;
    });
  }

  return {
    async recall(scopeId) {
      return recallBody(await currentBody(scopeId));
    },

    async capture(scopeId, facts, at, author, context) {
      let added = 0;
      await mutate(scopeId, "capture", at, author, undefined, async (current) => {
        const next = captureRecords(scopeId, current, facts, at, author, context);
        added = next.added;
        return next.records;
      });
      return added;
    },

    async query(scopeId, q2, limit = 20) {
      return queryBullets(await currentBody(scopeId), q2, limit);
    },

    async read(scopeId) {
      return currentBody(scopeId);
    },

    async replace(scopeId, content, author) {
      await mutate(scopeId, "replace", Date.now(), author, undefined, async (current) =>
        replaceRecords(scopeId, current, content),
      );
    },

    async readHead(scopeId) {
      const row = await headRow(scopeId);
      return {
        content: bodyFor(scopeId, row),
        revision: String(Number(row?.seq ?? 0)),
        records: recordsFor(scopeId, row),
        ...(row ? { updatedAt: Number(row.at) } : {}),
      };
    },

    async replaceIfRevision(scopeId, content, revision, author) {
      if (!/^\d+$/.test(revision)) return false;
      return mutate(scopeId, "replace", Date.now(), author, Number(revision), async (current) =>
        replaceRecords(scopeId, current, content),
      );
    },

    async replaceRecordsIfRevision(scopeId, records, revision, author) {
      if (!/^\d+$/.test(revision)) return false;
      const next = parseMemoryRecords(scopeId, "", records);
      return mutate(scopeId, "consolidate", Date.now(), author, Number(revision), async () => next);
    },

    async history(scopeId, limit = 30) {
      const rows = await q(
        "SELECT seq, body, op, author, at, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT $2",
        [scopeId, Math.max(1, Math.min(limit, 100))],
      );
      return rows.map((row) => ({
        revision: String(row.seq),
        content: bodyFor(scopeId, row),
        operation: String(row.op),
        records: recordsFor(scopeId, row),
        ...(row.author ? { author: String(row.author) } : {}),
        at: Number(row.at),
      }));
    },

    async restore(scopeId, revision, expectedRevision, author) {
      if (!/^\d+$/.test(revision) || !/^\d+$/.test(expectedRevision)) return false;
      const from = Number(revision);
      const target = (
        await q("SELECT body, records FROM memory_revisions WHERE scope_id = $1 AND seq = $2", [scopeId, from])
      )[0];
      if (!target) return false;
      const restored = recordsFor(scopeId, target);
      return mutate(scopeId, "restore", Date.now(), author, Number(expectedRevision), async (_current, seq, client) => {
        const intervening = await client.query(
          "SELECT body, records FROM memory_revisions WHERE scope_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq",
          [scopeId, from, seq],
        );
        return restoreMemoryRecords(
          { version: 1, records: intervening.rows.flatMap((row) => recordsFor(scopeId, row).records) },
          restored,
        );
      });
    },

    async updatedAt(scopeId) {
      const rows = await q("SELECT at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [scopeId]);
      const at = rows[0]?.at;
      return at == null ? undefined : Number(at);
    },

    async metadata() {
      const rows = await q(
        `SELECT DISTINCT ON (scope_id) scope_id, octet_length(body) AS bytes, at
           FROM memory_revisions ORDER BY scope_id, seq DESC`,
      );
      const out = new Map<string, { bytes: number; updatedAt?: number }>();
      for (const r of rows) {
        const bytes = Number(r.bytes ?? 0);
        out.set(r.scope_id as string, { bytes, ...(r.at != null ? { updatedAt: Number(r.at) } : {}) });
      }
      return out;
    },
  };
}
