import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";

export type FileUploadState = "pending" | "completing" | "complete" | "aborting" | "aborted";

export interface FileUpload {
  id: string;
  actorId: string;
  scopeId: ScopeId;
  name: string;
  mimetype: string;
  sizeBytes: number;
  partSize: number;
  checksums: string[];
  uploadId: string;
  state: FileUploadState;
  expiresAt: number;
  createdAt: number;
}

export interface FileUploadStore {
  insert(upload: FileUpload): Promise<void>;
  get(id: string): Promise<FileUpload | null>;
  transition(id: string, from: FileUploadState[], to: FileUploadState): Promise<boolean>;
  expired(now: number): Promise<FileUpload[]>;
}

export const MAX_ACTIVE_UPLOADS = 4;
export const MAX_ACTIVE_UPLOAD_BYTES = 500 * 1024 ** 3;

export function createPostgresFileUploadStore(connectionString: string): FileUploadStore {
  const db = createPgPool(connectionString, "files/uploads/0001", [
    `CREATE TABLE IF NOT EXISTS file_uploads (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      state TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      data JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS file_uploads_actor_state ON file_uploads(actor_id, state)`,
    `CREATE INDEX IF NOT EXISTS file_uploads_expiry ON file_uploads(expires_at) WHERE state NOT IN ('complete', 'aborted')`,
  ]);
  const decode = (row: Record<string, unknown>): FileUpload => ({
    ...(row.data as FileUpload),
    state: row.state as FileUploadState,
  });
  return {
    async insert(upload) {
      await withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-uploads:${upload.actorId}`]);
        const result = await client.query(
          "SELECT count(*) AS count, coalesce(sum(size_bytes),0) AS bytes FROM file_uploads WHERE actor_id=$1 AND state NOT IN ('complete','aborted')",
          [upload.actorId],
        );
        if (
          Number(result.rows[0].count) >= MAX_ACTIVE_UPLOADS ||
          Number(result.rows[0].bytes) + upload.sizeBytes > MAX_ACTIVE_UPLOAD_BYTES
        )
          throw new Error("active upload quota exceeded");
        await client.query(
          "INSERT INTO file_uploads(id,actor_id,state,size_bytes,expires_at,data) VALUES($1,$2,$3,$4,$5,$6)",
          [upload.id, upload.actorId, upload.state, upload.sizeBytes, upload.expiresAt, JSON.stringify(upload)],
        );
      });
    },
    async get(id) {
      const rows = await db.q("SELECT data,state FROM file_uploads WHERE id=$1", [id]);
      return rows[0] ? decode(rows[0]) : null;
    },
    async transition(id, from, to) {
      return (
        (await db.query("UPDATE file_uploads SET state=$3 WHERE id=$1 AND state=ANY($2::text[])", [id, from, to]))
          .rowCount === 1
      );
    },
    async expired(now) {
      return (
        await db.q(
          "SELECT data,state FROM file_uploads WHERE expires_at <= $1 AND state NOT IN ('complete','aborted') ORDER BY expires_at LIMIT 100",
          [now],
        )
      ).map(decode);
    },
  };
}
