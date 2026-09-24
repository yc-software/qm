import { isDeepStrictEqual } from "node:util";
import {
  legacyMemoryRecords,
  updateMemoryRecords,
  restoreMemoryRecords,
  type MemoryRecords,
  type MemoryCaptureMetadata,
} from "./records.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { foldCapture, normalizeReplace, queryBullets, recallBody, type MemoryService } from "./memory-service.ts";

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

  function recordsFor(scopeId: string, body: string, records: unknown): MemoryRecords {
    if (records == null) return legacyMemoryRecords(scopeId, body);
    const snapshot = records as MemoryRecords;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.records))
      throw new Error("Unsupported memory records version");
    return snapshot;
  }

  async function currentBody(scopeId: string): Promise<string> {
    const rows = await q("SELECT body FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [scopeId]);
    return (rows[0]?.body as string | undefined) ?? "";
  }

  async function currentHead(
    scopeId: string,
  ): Promise<{ body: string; seq: number; at?: number; records: MemoryRecords }> {
    const rows = await q(
      "SELECT body, seq, at, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
      [scopeId],
    );
    return rows[0]
      ? {
          body: String(rows[0].body ?? ""),
          seq: Number(rows[0].seq),
          at: Number(rows[0].at),
          records: recordsFor(scopeId, String(rows[0].body ?? ""), rows[0].records),
        }
      : { body: "", seq: 0, records: legacyMemoryRecords(scopeId, "") };
  }

  async function conditionalReplace(
    scopeId: string,
    content: string,
    expectedSeq: number,
    author: string | undefined,
    op: string,
    restoreFrom?: { seq: number; records: MemoryRecords },
  ): Promise<boolean> {
    const client = await (await pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const head = await client.query(
        "SELECT body, seq, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
        [scopeId],
      );
      const seq = Number(head.rows[0]?.seq ?? 0);
      if (seq !== expectedSeq) {
        await client.query("ROLLBACK");
        return false;
      }
      const next = normalizeReplace(content);
      const current = recordsFor(scopeId, String(head.rows[0]?.body ?? ""), head.rows[0]?.records);
      let records: MemoryRecords;
      if (restoreFrom) {
        const intervening = await client.query(
          "SELECT body, records FROM memory_revisions WHERE scope_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq",
          [scopeId, restoreFrom.seq, seq],
        );
        records = restoreMemoryRecords(
          {
            version: 1,
            records: intervening.rows.flatMap(
              (row) => recordsFor(scopeId, String(row.body ?? ""), row.records).records,
            ),
          },
          restoreFrom.records,
        );
      } else records = updateMemoryRecords(scopeId, current, next);
      if (next !== String(head.rows[0]?.body ?? "") || !isDeepStrictEqual(records, current)) {
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at, records) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [scopeId, seq + 1, op, next, author ?? null, Date.now(), JSON.stringify(records)],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function append(
    scopeId: string,
    op: string,
    at: number,
    author: string | undefined,
    derive: (existing: string) => { body: string } | null,
    capture?: MemoryCaptureMetadata,
    capturedBody?: string,
  ): Promise<void> {
    await withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const head = await client.query(
        "SELECT body, seq, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
        [scopeId],
      );
      const existing = (head.rows[0]?.body as string | undefined) ?? "";
      const next = derive(existing);
      if (!next) return;
      const current = recordsFor(scopeId, existing, head.rows[0]?.records);
      const records = updateMemoryRecords(scopeId, current, next.body, capture, capturedBody);
      if (next.body !== existing || !isDeepStrictEqual(records, current)) {
        const seq = Number(head.rows[0]?.seq ?? 0) + 1;
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at, records) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [scopeId, seq, op, next.body, author ?? null, at, JSON.stringify(records)],
        );
      }
    });
  }

  return {
    async recall(scopeId) {
      return recallBody(await currentBody(scopeId));
    },

    async capture(scopeId, facts, at, author, context) {
      const trustedProvenance = author?.startsWith("cc:") === true;
      let added = 0;
      await append(
        scopeId,
        "capture",
        at,
        author,
        (existing) => {
          const folded = foldCapture(existing, facts, at, trustedProvenance);
          added = folded.added;
          return { body: folded.added ? `${folded.body}\n` : existing };
        },
        context ?? {},
        foldCapture("", facts, at, trustedProvenance).body,
      );
      return added;
    },

    async query(scopeId, q2, limit = 20) {
      return queryBullets(await currentBody(scopeId), q2, limit);
    },

    async read(scopeId) {
      return currentBody(scopeId);
    },

    async replace(scopeId, content, author) {
      const next = normalizeReplace(content);
      await append(scopeId, "replace", Date.now(), author, () => ({ body: next }));
    },

    async readHead(scopeId) {
      const head = await currentHead(scopeId);
      return {
        content: head.body,
        revision: String(head.seq),
        records: head.records,
        ...(head.at !== undefined ? { updatedAt: head.at } : {}),
      };
    },

    async replaceIfRevision(scopeId, content, revision, author) {
      if (!/^\d+$/.test(revision)) return false;
      return conditionalReplace(scopeId, content, Number(revision), author, "replace");
    },

    async history(scopeId, limit = 30) {
      const rows = await q(
        "SELECT seq, body, op, author, at, records FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT $2",
        [scopeId, Math.max(1, Math.min(limit, 100))],
      );
      return rows.map((row) => ({
        revision: String(row.seq),
        content: String(row.body ?? ""),
        operation: String(row.op),
        records: recordsFor(scopeId, String(row.body ?? ""), row.records),
        ...(row.author ? { author: String(row.author) } : {}),
        at: Number(row.at),
      }));
    },

    async restore(scopeId, revision, expectedRevision, author) {
      if (!/^\d+$/.test(revision) || !/^\d+$/.test(expectedRevision)) return false;
      const rows = await q("SELECT body, records FROM memory_revisions WHERE scope_id = $1 AND seq = $2", [
        scopeId,
        Number(revision),
      ]);
      if (!rows[0]) return false;
      return conditionalReplace(scopeId, String(rows[0].body ?? ""), Number(expectedRevision), author, "restore", {
        seq: Number(revision),
        records: recordsFor(scopeId, String(rows[0].body ?? ""), rows[0].records),
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
