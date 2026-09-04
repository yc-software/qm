import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { DurableByteStore } from "./durable-byte-store.ts";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type FileArtifact,
  type FileArtifactStore,
  type FileDirection,
  type FilePage,
  type FileSource,
  type ListOwnedOptions,
} from "./file-artifact-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS file_artifacts(
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL DEFAULT 'file',
    owner_scope_id   TEXT NOT NULL,
    path             TEXT NOT NULL,
    name             TEXT NOT NULL,
    mimetype         TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    blob_key         TEXT,
    sha256           TEXT,
    direction        TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    created_in_scope TEXT,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    source           TEXT NOT NULL DEFAULT 'live'
  )`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_created
    ON file_artifacts (owner_scope_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_path
    ON file_artifacts (owner_scope_id, path)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_scope_created
    ON file_artifacts (created_in_scope, created_at DESC, id DESC) WHERE enabled = TRUE`,
];

function rowToArtifact(r: Record<string, unknown>): FileArtifact {
  return {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as ScopeId,
    createdBy: r.created_by as string,
    name: r.name as string,
    path: r.path as string,
    mimetype: r.mimetype as string,
    sizeBytes: Number(r.size_bytes),
    blobKey: (r.blob_key as string | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    direction: r.direction as FileDirection,
    source: r.source as FileSource,
    ...(r.created_in_scope != null ? { createdInScope: r.created_in_scope as ScopeId } : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    enabled: r.enabled as boolean,
  };
}

export function createPostgresFileArtifactStore(
  connectionString: string,
  byteStore: DurableByteStore,
): FileArtifactStore {
  const { q, query } = createPgPool(connectionString, SCHEMA);

  async function getRow(id: string): Promise<FileArtifact | null> {
    const rows = await q("SELECT * FROM file_artifacts WHERE id = $1", [id]);
    return rows.length ? rowToArtifact(rows[0]!) : null;
  }

  return {
    async put(input) {
      const existing = await getRow(input.id);
      if (existing) return { artifact: existing, created: false };

      const { blobKey, sizeBytes, sha256 } = await byteStore.put(
        input.data,
        input.maxBytes != null ? { maxBytes: input.maxBytes } : {},
      );
      const at = input.createdAt ?? Date.now();
      const ins = await query(
        `INSERT INTO file_artifacts
           (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
            direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
         VALUES ($1,'file',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,TRUE,'live')
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.ownerScopeId,
          input.path,
          input.name,
          input.mimetype,
          sizeBytes,
          blobKey,
          sha256,
          input.direction,
          input.createdBy,
          input.createdInScope ?? null,
          at,
        ],
      );
      const row = (await getRow(input.id))!;
      return { artifact: row, created: ins.rowCount > 0 };
    },

    async get(id, opts) {
      const r = await getRow(id);
      if (!r) return null;
      if (!r.enabled && !opts?.includeDisabled) return null;
      return r;
    },

    async open(id) {
      const r = await getRow(id);
      if (!r || !r.enabled || !r.blobKey) return null;
      const bytes = await byteStore.open(r.blobKey);
      if (!bytes) return null;
      return { artifact: r, sizeBytes: bytes.sizeBytes, stream: bytes.stream };
    },

    async listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage> {
      if (scopes.length === 0) return { files: [] };
      const limit = clampLimit(opts?.limit);
      const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;
      const params: unknown[] = [scopes as string[]];
      const filters = ["owner_scope_id = ANY($1::text[])"];
      if (!opts?.includeDisabled) filters.push("enabled = TRUE");
      if (opts?.createdInScope != null) {
        params.push(opts.createdInScope);
        filters.push(`created_in_scope = $${params.length}::text`);
      }
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        filters.push(`(created_at, id) < ($${params.length - 1}::bigint, $${params.length}::text)`);
      }
      params.push(limit + 1);
      const rows = await q(
        `SELECT * FROM file_artifacts
           WHERE ${filters.join(" AND ")}
           ORDER BY created_at DESC, id DESC
           LIMIT $${params.length}`,
        params,
      );
      const all = rows.map(rowToArtifact);
      const page = all.slice(0, limit);
      const nextCursor = all.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : undefined;
      return { files: page, ...(nextCursor ? { nextCursor } : {}) };
    },

    async resolveByOwnerPaths(refs) {
      if (refs.length === 0) return [];
      const owners = refs.map((r) => r.ownerScopeId as string);
      const paths = refs.map((r) => r.path);
      const rows = await q(
        `SELECT * FROM file_artifacts
           WHERE enabled = TRUE
             AND (owner_scope_id, path) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [owners, paths],
      );
      return rows.map(rowToArtifact);
    },

    async setEnabled(id, enabled) {
      await query("UPDATE file_artifacts SET enabled = $2, updated_at = $3 WHERE id = $1", [id, enabled, Date.now()]);
    },

    async delete(id) {
      await query("DELETE FROM file_artifacts WHERE id = $1", [id]);
    },
  };
}
