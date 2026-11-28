import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import { claimRows, type ClaimedRow } from "../tenants/claim.ts";

type FileUploadState = "pending" | "completing" | "complete" | "aborting" | "aborted" | "failed";

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
  lastActivityAt: number;
}

export interface FileUploadStore {
  insert(upload: FileUpload): Promise<void>;
  get(id: string): Promise<FileUpload | null>;
  transition(id: string, from: FileUploadState[], to: FileUploadState): Promise<boolean>;
  touch(id: string, at: number): Promise<boolean>;
  active(actorId: string, now: number): Promise<FileUpload[]>;
  claimExpired(now: number): Promise<ClaimedRow[]>;
  claimById(id: string): Promise<ClaimedRow[]>;
}

export class FileUploadError extends Error {
  readonly status: number;
  readonly code: "upload_error" | "upload_quota";
  constructor(message: string, status = 400, code: "upload_error" | "upload_quota" = "upload_error") {
    super(message);
    this.name = "FileUploadError";
    this.status = status;
    this.code = code;
  }
}

export const MAX_ACTIVE_UPLOADS = 4;
const MAX_ACTIVE_UPLOAD_BYTES = 500 * 1024 ** 3;
const HOLDS_QUOTA =
  "actor_id=$1 AND state NOT IN ('complete','aborted','failed') AND NOT (state='pending' AND expires_at <= $2)";

export function createPostgresFileUploadStore(connectionString: string): FileUploadStore {
  const db = createPgPool(connectionString);
  const decode = (row: Record<string, unknown>): FileUpload => ({
    ...(row.data as FileUpload),
    state: row.state as FileUploadState,
  });
  return {
    async insert(upload) {
      await withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-uploads:${upload.actorId}`]);
        const result = await client.query(
          `SELECT count(*) AS count, coalesce(sum(size_bytes),0) AS bytes FROM file_uploads WHERE ${HOLDS_QUOTA}`,
          [upload.actorId, upload.createdAt],
        );
        if (
          Number(result.rows[0].count) >= MAX_ACTIVE_UPLOADS ||
          Number(result.rows[0].bytes) + upload.sizeBytes > MAX_ACTIVE_UPLOAD_BYTES
        )
          throw new FileUploadError(
            `active upload quota exceeded: at most ${MAX_ACTIVE_UPLOADS} unfinished uploads or ${MAX_ACTIVE_UPLOAD_BYTES / 1024 ** 3} GiB at once. Finish or abort (DELETE /v1/files/uploads/:id) one of the uploads listed here; unfinished uploads are aborted 24 hours after they start`,
            429,
            "upload_quota",
          );
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
    async touch(id, at) {
      return (
        (
          await db.query(
            "UPDATE file_uploads SET data=jsonb_set(data,'{lastActivityAt}',to_jsonb($2::bigint)) WHERE id=$1 AND state='pending'",
            [id, at],
          )
        ).rowCount === 1
      );
    },
    async active(actorId, now) {
      return (
        await db.q(`SELECT data,state FROM file_uploads WHERE ${HOLDS_QUOTA} ORDER BY expires_at`, [actorId, now])
      ).map(decode);
    },
    claimExpired(now) {
      return claimRows(db, "claim_expired_file_uploads", [now]);
    },
    claimById(id) {
      return claimRows(db, "claim_file_upload", [id]);
    },
  };
}
