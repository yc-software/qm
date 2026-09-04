import { createHash } from "node:crypto";
import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import {
  foldCapture,
  MemoryOperationConflictError,
  MemoryOperationErasedError,
  normalizeReplace,
  queryBullets,
  recallBody,
  type IdempotentMemoryService,
  type MemoryCaptureOnceInput,
  type MemoryCaptureReceipt,
  type MemoryPurgeOnceInput,
  type MemoryPurgeReceipt,
} from "./memory-service.ts";
import { memoryOperationToken, memoryScopeToken, memoryTombstoneKeyCheck } from "./privacy-tokens.ts";

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
  "CREATE INDEX IF NOT EXISTS memory_revisions_by_scope ON memory_revisions(scope_id, seq DESC)",
  `CREATE TABLE IF NOT EXISTS memory_integration_operations(
    integration_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    added INTEGER NOT NULL,
    revision BIGINT NOT NULL,
    updated_at BIGINT,
    created_at BIGINT NOT NULL,
    erased_at BIGINT,
    PRIMARY KEY (integration_id, operation_id)
  )`,
  "ALTER TABLE memory_integration_operations ADD COLUMN IF NOT EXISTS erased_at BIGINT",
  `CREATE TABLE IF NOT EXISTS memory_erased_scopes(
    scope_hash TEXT PRIMARY KEY,
    erased_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_tombstone_key_guard(
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    key_check TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_erasure_receipts(
    integration_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    erased_revisions INTEGER NOT NULL,
    tombstoned_operations INTEGER NOT NULL,
    completed_at BIGINT NOT NULL,
    PRIMARY KEY (integration_id, operation_id)
  )`,
];

export function createPostgresMemoryService(
  connectionString: string,
  scopeTombstoneKey: string,
): IdempotentMemoryService {
  if (scopeTombstoneKey.length < 32) throw new Error("memory scope tombstone key must be at least 32 characters");
  const { q, pool } = createPgPool(connectionString, SCHEMA);
  const scopeToken = (scopeId: string): string => memoryScopeToken(scopeTombstoneKey, scopeId);
  const operationToken = (integrationId: string, operationId: string): string =>
    memoryOperationToken(scopeTombstoneKey, integrationId, operationId);
  const keyCheck = memoryTombstoneKeyCheck(scopeTombstoneKey);
  let keyGuard: Promise<void> | undefined;

  async function assertTombstoneKey(): Promise<void> {
    keyGuard ??= withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory-tombstone-key-guard'))");
      const current = await client.query("SELECT key_check FROM memory_tombstone_key_guard WHERE singleton = TRUE");
      if (!current.rows[0]) {
        await client.query("INSERT INTO memory_tombstone_key_guard (singleton, key_check) VALUES (TRUE, $1)", [
          keyCheck,
        ]);
        return;
      }
      if (current.rows[0].key_check !== keyCheck) {
        throw new Error("memory tombstone key does not match the key registered for this database");
      }
    });
    return keyGuard;
  }

  async function guardedPool() {
    await assertTombstoneKey();
    return pool();
  }

  async function guardedQuery(text: string, params: unknown[] = []) {
    await assertTombstoneKey();
    return q(text, params);
  }

  async function assertScopeWritable(client: PoolClient, scopeId: string): Promise<void> {
    const erasedScope = await client.query("SELECT 1 FROM memory_erased_scopes WHERE scope_hash = $1", [
      scopeToken(scopeId),
    ]);
    if (erasedScope.rows[0]) throw new MemoryOperationErasedError();
  }

  async function currentBody(scopeId: string): Promise<string> {
    const rows = await guardedQuery("SELECT body FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [
      scopeId,
    ]);
    return (rows[0]?.body as string | undefined) ?? "";
  }

  async function currentHead(scopeId: string): Promise<{ body: string; seq: number; at?: number }> {
    const rows = await guardedQuery(
      "SELECT body, seq, at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
      [scopeId],
    );
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
    const client = await (await guardedPool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      await assertScopeWritable(client, scopeId);
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
    await withPgTransaction(await guardedPool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      await assertScopeWritable(client, scopeId);
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

  async function captureOnce(input: MemoryCaptureOnceInput): Promise<MemoryCaptureReceipt> {
    const storedOperationId = operationToken(input.integrationId, input.operationId);
    const requestHash = createHash("sha256")
      .update(JSON.stringify([input.scopeId, input.facts, input.at, input.author ?? null]))
      .digest("hex");
    return withPgTransaction(await guardedPool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [input.scopeId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory-operation'), hashtext($1))", [
        `${input.integrationId}:${storedOperationId}`,
      ]);
      await assertScopeWritable(client, input.scopeId);
      const prior = await client.query(
        `SELECT request_hash, added, revision, updated_at, erased_at
           FROM memory_integration_operations
          WHERE integration_id = $1 AND operation_id = $2`,
        [input.integrationId, storedOperationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].erased_at != null) throw new MemoryOperationErasedError();
        if (prior.rows[0].request_hash !== requestHash) throw new MemoryOperationConflictError();
        return {
          added: Number(prior.rows[0].added),
          revision: String(prior.rows[0].revision),
          ...(prior.rows[0].updated_at == null ? {} : { updatedAt: Number(prior.rows[0].updated_at) }),
        };
      }

      const head = await client.query(
        "SELECT body, seq, at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1",
        [input.scopeId],
      );
      const existing = String(head.rows[0]?.body ?? "");
      const currentSeq = Number(head.rows[0]?.seq ?? 0);
      const folded = foldCapture(existing, input.facts, input.at, input.author?.startsWith("cc:") === true);
      const revision = folded.added ? currentSeq + 1 : currentSeq;
      let updatedAt: number | undefined;
      if (folded.added) updatedAt = input.at;
      else if (head.rows[0]?.at != null) updatedAt = Number(head.rows[0].at);
      if (folded.added) {
        await client.query(
          "INSERT INTO memory_revisions (scope_id, seq, op, body, author, at) VALUES ($1, $2, $3, $4, $5, $6)",
          [input.scopeId, revision, "capture", `${folded.body}\n`, input.author ?? null, input.at],
        );
      }
      await client.query(
        `INSERT INTO memory_integration_operations
           (integration_id, operation_id, request_hash, scope_id, added, revision, updated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.integrationId,
          storedOperationId,
          requestHash,
          input.scopeId,
          folded.added,
          revision,
          updatedAt ?? null,
          Date.now(),
        ],
      );
      return { added: folded.added, revision: String(revision), ...(updatedAt === undefined ? {} : { updatedAt }) };
    });
  }

  async function purgeScope(
    scopeId: string,
    at: number,
  ): Promise<{ erasedRevisions: number; tombstonedOperations: number }> {
    return withPgTransaction(await guardedPool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
      const scopeHash = scopeToken(scopeId);
      const deleted = await client.query("DELETE FROM memory_revisions WHERE scope_id = $1", [scopeId]);
      const tombstoned = await client.query(
        `UPDATE memory_integration_operations
            SET request_hash = '', scope_id = '', added = 0, revision = 0,
                updated_at = NULL, erased_at = $2
          WHERE scope_id = $1`,
        [scopeId, at],
      );
      await client.query(
        `INSERT INTO memory_erased_scopes (scope_hash, erased_at)
         VALUES ($1, $2)
         ON CONFLICT (scope_hash) DO UPDATE SET erased_at = GREATEST(memory_erased_scopes.erased_at, EXCLUDED.erased_at)`,
        [scopeHash, at],
      );
      return {
        erasedRevisions: deleted.rowCount ?? 0,
        tombstonedOperations: tombstoned.rowCount ?? 0,
      };
    });
  }

  async function purgeOnce(input: MemoryPurgeOnceInput): Promise<MemoryPurgeReceipt> {
    const scopeHash = scopeToken(input.scopeId);
    const storedOperationId = operationToken(input.integrationId, input.operationId);
    const requestHash = createHash("sha256")
      .update(JSON.stringify([scopeHash, input.at]))
      .digest("hex");
    return withPgTransaction(await guardedPool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [input.scopeId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('memory-erasure'), hashtext($1))", [
        `${input.integrationId}:${storedOperationId}`,
      ]);
      const prior = await client.query(
        `SELECT request_hash, scope_hash, erased_revisions, tombstoned_operations, completed_at
           FROM memory_erasure_receipts
          WHERE integration_id = $1 AND operation_id = $2`,
        [input.integrationId, storedOperationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash || prior.rows[0].scope_hash !== scopeHash) {
          throw new MemoryOperationConflictError();
        }
        return {
          erasedRevisions: Number(prior.rows[0].erased_revisions),
          tombstonedOperations: Number(prior.rows[0].tombstoned_operations),
          completedAt: Number(prior.rows[0].completed_at),
          scopeHash: String(prior.rows[0].scope_hash),
        };
      }
      const deleted = await client.query("DELETE FROM memory_revisions WHERE scope_id = $1", [input.scopeId]);
      const tombstoned = await client.query(
        `UPDATE memory_integration_operations
            SET request_hash = '', scope_id = '', added = 0, revision = 0,
                updated_at = NULL, erased_at = $2
          WHERE scope_id = $1`,
        [input.scopeId, input.at],
      );
      await client.query(
        `INSERT INTO memory_erased_scopes (scope_hash, erased_at)
         VALUES ($1, $2)
         ON CONFLICT (scope_hash) DO UPDATE SET erased_at = GREATEST(memory_erased_scopes.erased_at, EXCLUDED.erased_at)`,
        [scopeHash, input.at],
      );
      const receipt = {
        erasedRevisions: deleted.rowCount ?? 0,
        tombstonedOperations: tombstoned.rowCount ?? 0,
        completedAt: input.at,
        scopeHash,
      };
      await client.query(
        `INSERT INTO memory_erasure_receipts
           (integration_id, operation_id, request_hash, scope_hash, erased_revisions, tombstoned_operations, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.integrationId,
          storedOperationId,
          requestHash,
          scopeHash,
          receipt.erasedRevisions,
          receipt.tombstonedOperations,
          receipt.completedAt,
        ],
      );
      return receipt;
    });
  }

  return {
    captureOnce,
    purgeOnce,

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

    async purge(scopeId) {
      await purgeScope(scopeId, Date.now());
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
      const rows = await guardedQuery(
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
      const rows = await guardedQuery("SELECT body FROM memory_revisions WHERE scope_id = $1 AND seq = $2", [
        scopeId,
        Number(revision),
      ]);
      if (!rows[0]) return false;
      return conditionalReplace(scopeId, String(rows[0].body ?? ""), Number(expectedRevision), author, "restore");
    },

    async updatedAt(scopeId) {
      const rows = await guardedQuery("SELECT at FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1", [
        scopeId,
      ]);
      const at = rows[0]?.at;
      return at == null ? undefined : Number(at);
    },

    async metadata() {
      const rows = await guardedQuery(
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
