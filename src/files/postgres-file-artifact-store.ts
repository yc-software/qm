import type { PoolClient } from "pg";
import type { SessionStore } from "../sessions/session-store.ts";
import { mergeProvenance, UNTRACKED_PROVENANCE, type SourceProvenance } from "../memory/facts.ts";
import { personalScope } from "../types.ts";
import { MIMEType } from "node:util";
import { likeContains } from "../persistence/like.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { DurableByteStore } from "./durable-byte-store.ts";
import {
  FileArtifactDeletedError,
  fileSharingRevision,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type FileArtifact,
  type FileArtifactRef,
  type FileArtifactStore,
  type FileDirection,
  type FilePage,
  type FileSource,
  type ListOwnedOptions,
} from "./file-artifact-store.ts";
import { tenantTables } from "../tenants/migrations.ts";

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

export const FILE_ARTIFACT_MIGRATIONS = [
  { id: "files/artifacts/0001", statements: SCHEMA },
  {
    id: "files/artifacts/0002",
    statements: ["CREATE TABLE IF NOT EXISTS file_artifact_deletions(id TEXT PRIMARY KEY, deleted_at BIGINT NOT NULL)"],
  },
  ...tenantTables("files/artifacts/0003-tenants", [
    { table: "file_artifacts", primaryKey: "id" },
    { table: "file_artifact_deletions", primaryKey: "id" },
  ]),
  {
    id: "files/artifacts/0004-context",
    statements: [
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE file_artifacts ADD COLUMN personal_only BOOLEAN NOT NULL DEFAULT false",
      "ALTER TABLE file_artifacts ADD COLUMN source_provenance JSONB",
    ],
  },
  {
    id: "files/artifacts/0005-recorded-origin",
    statements: [
      "SET LOCAL lock_timeout = '5s'",
      `UPDATE file_artifacts SET source_provenance=jsonb_build_object('sensitivity','unknown',
          'sources',jsonb_build_array(COALESCE(created_in_scope,owner_scope_id)),'sourceUnknown',true)
          WHERE source_provenance IS NULL`,
      `DO $$ BEGIN
          IF to_regclass('sessions') IS NULL OR to_regclass('items') IS NULL OR to_regclass('document_conversations') IS NULL THEN RETURN; END IF;
          WITH RECURSIVE private_sessions(tenant_id,id,scope_id) AS (
            SELECT s.tenant_id,s.id,s.scope_id FROM sessions s
            WHERE to_jsonb(s)->>'personal_only'='true' OR EXISTS (
              SELECT 1 FROM document_conversations d WHERE d.tenant_id=s.tenant_id
              AND d.id=encode(sha256(convert_to('["session",' || to_json(s.id)::text || ']', 'UTF8')),'hex')
              AND d.json->>'kind'='session' AND d.json->>'mode'='private'
              AND s.scope_id='personal:' || (d.json->>'principalId'))
            UNION SELECT s.tenant_id,s.id,s.scope_id FROM sessions s JOIN private_sessions p
              ON s.tenant_id=p.tenant_id AND s.scope_id=p.scope_id
              AND (s.parent_session_id=p.id OR s.forked_from_session_id=p.id)
          ), calls AS (
            SELECT i.*,row_number() OVER (PARTITION BY i.tenant_id,i.session_id,i.turn_id ORDER BY i.seq)-1 AS ordinal
            FROM items i WHERE i.kind='ToolCall' AND i.tool='attach' AND i.turn_id IS NOT NULL
          ), created AS (
            SELECT p.tenant_id,p.scope_id,a.file->>'artifactId' AS id,to_jsonb(s)->'context_provenance' AS provenance
            FROM calls c JOIN private_sessions p ON p.tenant_id=c.tenant_id AND p.id=c.session_id
            JOIN sessions s ON s.tenant_id=c.tenant_id AND s.id=c.session_id
            JOIN items r ON r.tenant_id=c.tenant_id AND r.session_id=c.session_id AND r.call_id=c.call_id AND r.kind='ToolResult'
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.body->'files')='array' THEN r.body->'files' ELSE '[]'::jsonb END) WITH ORDINALITY a(file,position)
            WHERE a.file->>'artifactId'=left(encode(sha256(convert_to(c.turn_id::text || ':attach:' || c.ordinal::text || ':out:' || (a.position-1)::text,'UTF8')),'hex'),32)
          ) UPDATE file_artifacts f SET personal_only=true,
            source_provenance=CASE WHEN c.provenance IS NOT NULL AND c.provenance<>'null'::jsonb THEN jsonb_build_object(
              'sensitivity',c.provenance->'sensitivity','sources',COALESCE(c.provenance->'sources','[]'::jsonb) || jsonb_build_array(c.scope_id),'sourceUnknown',true)
              ELSE f.source_provenance END
            FROM created c WHERE f.tenant_id=c.tenant_id AND f.id=c.id AND f.owner_scope_id=c.scope_id AND f.direction='out' AND f.personal_only=false;
        END $$`,
    ],
  },
];

function storedMimetype(mimetype: string): string {
  try {
    return new MIMEType(mimetype).toString();
  } catch {
    return "application/octet-stream";
  }
}

function rowToArtifact(r: Record<string, unknown>): FileArtifact {
  return {
    id: r.id as string,
    ...(r.personal_only ? { personalOnly: true as const } : {}),
    ...(r.source_provenance ? { sourceProvenance: r.source_provenance as SourceProvenance } : {}),
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
  sessionContexts?: Pick<SessionStore, "getMany">,
): FileArtifactStore {
  const { q, query, pool } = createPgPool(connectionString, FILE_ARTIFACT_MIGRATIONS);

  async function getRow(id: string): Promise<FileArtifact | null> {
    const rows = await q("SELECT * FROM file_artifacts WHERE id = $1", [id]);
    return rows.length ? rowToArtifact(rows[0]!) : null;
  }

  async function listFiles(
    scopes: readonly ScopeId[],
    opts?: ListOwnedOptions,
    sharedRefs?: readonly FileArtifactRef[],
    scopePriority = false,
  ): Promise<FilePage> {
    if (scopes.length === 0 && !sharedRefs?.length) return { files: [] };
    const limit = clampLimit(opts?.limit);
    const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;
    const params: unknown[] = [scopes as string[]];
    let access = "owner_scope_id = ANY($1::text[])";
    if (sharedRefs !== undefined) {
      params.push(
        sharedRefs.map((r) => r.ownerScopeId),
        sharedRefs.map((r) => r.id),
      );
      access = `(${access} OR (enabled = TRUE AND (owner_scope_id, id) IN (SELECT * FROM unnest($2::text[], $3::text[]))))`;
    }
    const filters = [access];
    if (!opts?.includeDisabled) filters.push("enabled = TRUE");
    if (opts?.excludePersonalOnly) filters.push("personal_only = FALSE");
    if (opts?.createdInScope != null) {
      params.push(opts.createdInScope);
      filters.push(`created_in_scope = $${params.length}::text`);
    }
    if (opts?.nameQuery != null) {
      params.push(likeContains(opts.nameQuery));
      filters.push(`name ILIKE $${params.length}::text ESCAPE '\\'`);
    }
    if (opts?.name != null) {
      params.push(opts.name);
      filters.push(`name = $${params.length}::text`);
    }
    const visible = `SELECT * FROM file_artifacts WHERE ${filters.join(" AND ")}`;
    const documents =
      sharedRefs === undefined
        ? visible
        : `
      SELECT DISTINCT ON (COALESCE(created_in_scope, owner_scope_id), COALESCE(sha256, 'id:' || id)) *
      FROM (${visible}) visible
      ORDER BY COALESCE(created_in_scope, owner_scope_id), COALESCE(sha256, 'id:' || id),
               (owner_scope_id = ANY($1::text[])) DESC, created_at ASC, id ASC`;
    let pageFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      pageFilter = `WHERE (created_at, id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
    }
    params.push(limit + 1);
    const rows = await q(
      `SELECT * FROM (${documents}) documents ${pageFilter}
      ORDER BY ${scopePriority ? "array_position($1::text[], owner_scope_id), " : ""}created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const all = rows.map(rowToArtifact);
    const files = all.slice(0, limit);
    const nextCursor = all.length > limit && files.length > 0 ? encodeCursor(files[files.length - 1]!) : undefined;
    return { files, ...(nextCursor ? { nextCursor } : {}) };
  }

  return {
    async releasePrivate(id, revision, provenance, writeGrant) {
      return withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-artifact:${id}`]);
        const selected = await client.query("SELECT * FROM file_artifacts WHERE id=$1 AND enabled=TRUE FOR UPDATE", [
          id,
        ]);
        const file = selected.rows[0] && rowToArtifact(selected.rows[0]);
        if (!file?.personalOnly || fileSharingRevision(file) !== revision)
          throw new Error("The selected private file changed after approval. Read it again before sharing.");
        if (!file.blobKey || !file.sha256)
          throw new Error("The private file needs saved, verified bytes before it can be shared.");
        await writeGrant(client);
        const saved = await client.query(
          "UPDATE file_artifacts SET personal_only=FALSE,source_provenance=$2::jsonb,updated_at=$3 WHERE id=$1 RETURNING *",
          [id, JSON.stringify(provenance), Date.now()],
        );
        return rowToArtifact(saved.rows[0]);
      });
    },
    async put(input) {
      const existing = await getRow(input.id);
      if (existing) return { artifact: existing, created: false };

      const { blobKey, sizeBytes, sha256 } = await byteStore.put(
        input.data,
        input.maxBytes != null ? { maxBytes: input.maxBytes } : {},
      );
      return this.publish({ ...input, blobKey, sizeBytes, sha256 });
    },

    async publish(input, transaction) {
      const publish = async (client: PoolClient) => {
        const ids = [...new Set(input.contextSessionIds ?? [])];
        const contexts = ids.length ? await sessionContexts?.getMany({ ids, threadRefs: [] }, client) : [];
        if (!contexts || contexts.length !== ids.length)
          throw new Error("The file's conversation context no longer exists");
        const provenance = contexts.length
          ? mergeProvenance(
              contexts.map((session) => ({
                ...(session.sourceProvenance ?? UNTRACKED_PROVENANCE),
                sources: [...new Set([session.scopeId, ...(session.sourceProvenance?.sources ?? [])])],
                ...(session.personalOnly ? { personalOnly: true as const } : {}),
              })),
              "ordinary",
            )
          : { ...UNTRACKED_PROVENANCE, sources: [input.createdInScope ?? input.ownerScopeId] };
        if (
          provenance?.personalOnly &&
          (input.ownerScopeId !== personalScope(input.createdBy) ||
            contexts.some((session) => session.personalOnly && session.scopeId !== input.ownerScopeId))
        )
          throw new Error("Private files must remain in their owner's personal scope");
        const { blobKey, sizeBytes, sha256 } = input;
        const at = input.createdAt ?? Date.now();
        if (input.reuseExistingPath) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `file-path:${input.ownerScopeId}:${input.path}`,
          ]);
          const existing = await client.query(
            "SELECT * FROM file_artifacts WHERE owner_scope_id=$1 AND path=$2 AND enabled=TRUE ORDER BY created_at DESC,id DESC LIMIT 1",
            [input.ownerScopeId, input.path],
          );
          if (existing.rows[0]) return { artifact: rowToArtifact(existing.rows[0]), created: false };
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-artifact:${input.id}`]);
        const deleted = await client.query("SELECT id FROM file_artifact_deletions WHERE id=$1", [input.id]);
        if (deleted.rows.length) throw new FileArtifactDeletedError();
        const ins = await client.query(
          `INSERT INTO file_artifacts
           (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
            direction, created_by, created_in_scope, created_at, updated_at, enabled, source, personal_only, source_provenance)
         VALUES ($1,'file',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,TRUE,'live',$13,$14::jsonb)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
          [
            input.id,
            input.ownerScopeId,
            input.path,
            input.name,
            storedMimetype(input.mimetype),
            sizeBytes,
            blobKey,
            sha256,
            input.direction,
            input.createdBy,
            input.createdInScope ?? null,
            at,
            provenance?.personalOnly === true,
            provenance
              ? JSON.stringify({
                  sensitivity: provenance.sensitivity,
                  sources: provenance.sources,
                  sourceUnknown: provenance.sourceUnknown,
                })
              : null,
          ],
        );
        const result = await client.query("SELECT * FROM file_artifacts WHERE id=$1", [input.id]);
        return { artifact: rowToArtifact(result.rows[0]), created: (ins.rowCount ?? 0) > 0 };
      };
      const instance = await pool();
      return transaction ? publish(transaction) : withPgTransaction(instance, publish);
    },

    async getMany(ids, opts) {
      if (!ids.length) return [];
      return (
        await q("SELECT * FROM file_artifacts WHERE id=ANY($1::text[]) AND ($2::boolean OR enabled=TRUE)", [
          ids,
          opts?.includeDisabled === true,
        ])
      ).map(rowToArtifact);
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

    listContext: async (scopes, opts) => (await listFiles(scopes, opts, undefined, true)).files,
    listOwnedByScopes: (scopes, opts) => listFiles(scopes, opts),

    listDocuments: (scopes, sharedRefs, opts) => listFiles(scopes, opts, sharedRefs),

    async resolveByIds(refs) {
      if (refs.length === 0) return [];
      const owners = refs.map((r) => r.ownerScopeId as string);
      const ids = refs.map((r) => r.id);
      const rows = await q(
        `SELECT * FROM file_artifacts
           WHERE enabled = TRUE
             AND (owner_scope_id, id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [owners, ids],
      );
      return rows.map(rowToArtifact);
    },

    async setEnabled(id, enabled) {
      await query("UPDATE file_artifacts SET enabled = $2, updated_at = $3 WHERE id = $1", [id, enabled, Date.now()]);
    },

    async delete(id) {
      await withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-artifact:${id}`]);
        await client.query(
          "INSERT INTO file_artifact_deletions(id,deleted_at) VALUES($1,$2) ON CONFLICT (tenant_id, id) DO NOTHING",
          [id, Date.now()],
        );
        await client.query("DELETE FROM file_artifacts WHERE id=$1", [id]);
      });
    },
  };
}
