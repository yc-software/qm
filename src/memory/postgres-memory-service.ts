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
  const { q, pool } = createPgPool(connectionString, SCHEMA);

  async function currentBody(scopeId: string): Promise<string> {
    const rows = await q("SELECT body FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [scopeId]);
    return (rows[0]?.body as string | undefined) ?? "";
  }

  async function currentHead(scopeId: string): Promise<{ body: string; seq: number; at?: number }> {
    const rows = await q("SELECT body, seq, at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [
      scopeId,
    ]);
    return rows[0]
      ? { body: String(rows[0].body ?? ""), seq: Number(rows[0].seq), at: Number(rows[0].at) }
      : { body: "", seq: 0 };
  }

  async function conditionalReplace(
    scopeId: string,
    content: string,
    expectedSeq: number,
    author: string | undefined,
    op: string,
  ): Promise<boolean> {
    const client = await (await pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const head = await client.query(
        "SELECT body, seq FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
        [scopeId],
      );
      const seq = Number(head.rows[0]?.seq ?? 0);
      if (seq !== expectedSeq) {
        await client.query("ROLLBACK");
        return false;
      }
      const next = normalizeReplace(content);
      if (next !== String(head.rows[0]?.body ?? "")) {
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at) VALUES ($1, $2, $3, $4, $5, $6)",
          [scopeId, seq + 1, op, next, author ?? null, Date.now()],
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
  ): Promise<void> {
    await withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const head = await client.query(
        "SELECT body, seq FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
        [scopeId],
      );
      const existing = (head.rows[0]?.body as string | undefined) ?? "";
      const next = derive(existing);
      if (next && next.body !== existing) {
        const seq = Number(head.rows[0]?.seq ?? 0) + 1;
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at) VALUES ($1, $2, $3, $4, $5, $6)",
          [scopeId, seq, op, next.body, author ?? null, at],
        );
      }
    });
  }

  return {
    async recall(scopeId) {
      return recallBody(await currentBody(scopeId));
    },

    async capture(scopeId, facts, at, author) {
      const trustedProvenance = author?.startsWith("cc:") === true;
      const probe = foldCapture(await currentBody(scopeId), facts, at, trustedProvenance);
      if (!probe.added) return 0;
      let added = 0;
      await append(scopeId, "capture", at, author, (existing) => {
        const folded = foldCapture(existing, facts, at, trustedProvenance);
        added = folded.added;
        return folded.added ? { body: `${folded.body}\n` } : null;
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
      const next = normalizeReplace(content);
      await append(scopeId, "replace", Date.now(), author, () => ({ body: next }));
    },

    async readHead(scopeId) {
      const head = await currentHead(scopeId);
      return {
        content: head.body,
        revision: String(head.seq),
        ...(head.at !== undefined ? { updatedAt: head.at } : {}),
      };
    },

    async replaceIfRevision(scopeId, content, revision, author) {
      if (!/^\d+$/.test(revision)) return false;
      return conditionalReplace(scopeId, content, Number(revision), author, "replace");
    },

    async history(scopeId, limit = 30) {
      const rows = await q(
        "SELECT seq, body, op, author, at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT $2",
        [scopeId, Math.max(1, Math.min(limit, 100))],
      );
      return rows.map((row) => ({
        revision: String(row.seq),
        content: String(row.body ?? ""),
        operation: String(row.op),
        ...(row.author ? { author: String(row.author) } : {}),
        at: Number(row.at),
      }));
    },

    async restore(scopeId, revision, expectedRevision, author) {
      if (!/^\d+$/.test(revision) || !/^\d+$/.test(expectedRevision)) return false;
      const rows = await q("SELECT body FROM memory_revisions WHERE scope_id = $1 AND seq = $2", [
        scopeId,
        Number(revision),
      ]);
      if (!rows[0]) return false;
      return conditionalReplace(scopeId, String(rows[0].body ?? ""), Number(expectedRevision), author, "restore");
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
