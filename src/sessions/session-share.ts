import type { SessionEntry } from "../types.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { pgJsonText } from "../util/text.ts";

export interface SharedAttachment {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
}

export interface SharedMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: SharedAttachment[];
}

export interface SessionShare {
  token: string;
  sessionId: string;
  audience: "internal" | "external";
  createdBy: string;
  createdAt: number;
  visibility: { minSeq: number; maxSeq: number; minCreatedAt: number; maxCreatedAt: number };
  messages: SharedMessage[];
  files: Array<SharedAttachment & { blobKey: string }>;
}

export interface SessionShareStore {
  create(share: SessionShare): Promise<void>;
  get(token: string): Promise<SessionShare | null>;
  close?(): Promise<void>;
}

const SESSION_SHARES_MIGRATION = typedTableMigration({
  table: "session_shares",
  columns: [
    "token TEXT NOT NULL",
    "session_id TEXT NOT NULL",
    "audience TEXT NOT NULL",
    "created_by TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
    "min_seq BIGINT NOT NULL",
    "max_seq BIGINT NOT NULL",
    "min_created_at BIGINT NOT NULL",
    "max_created_at BIGINT NOT NULL",
    "messages JSONB NOT NULL",
    "files JSONB NOT NULL",
  ],
  constraints: ["CHECK (audience IN ('internal', 'external'))"],
  primaryKey: ["token"],
  backfill: {
    token: "id",
    session_id: "json->>'sessionId'",
    audience: "json->>'audience'",
    created_by: "json->>'createdBy'",
    created_at: "round((json->>'createdAt')::numeric)::bigint",
    min_seq: "round((json->'visibility'->>'minSeq')::numeric)::bigint",
    max_seq: "round((json->'visibility'->>'maxSeq')::numeric)::bigint",
    min_created_at: "round((json->'visibility'->>'minCreatedAt')::numeric)::bigint",
    max_created_at: "round((json->'visibility'->>'maxCreatedAt')::numeric)::bigint",
    messages: "json->'messages'",
    files: "json->'files'",
  },
  where: `json->>'audience' IN ('internal', 'external') AND json->>'sessionId' IS NOT NULL
    AND json->>'createdBy' IS NOT NULL AND json->>'createdAt' IS NOT NULL
    AND json->'visibility'->>'minSeq' IS NOT NULL AND json->'visibility'->>'maxSeq' IS NOT NULL
    AND json->'visibility'->>'minCreatedAt' IS NOT NULL AND json->'visibility'->>'maxCreatedAt' IS NOT NULL
    AND jsonb_typeof(json->'messages') = 'array' AND jsonb_typeof(json->'files') = 'array'`,
});

export function createSessionShareStore(): SessionShareStore {
  const tenants = new Map<string, Map<string, SessionShare>>();
  const rows = () => {
    const tenant = currentTenant();
    return tenants.get(tenant) ?? tenants.set(tenant, new Map()).get(tenant)!;
  };
  return {
    async create(share) {
      if (rows().has(share.token)) throw new Error(`session share ${share.token} already exists`);
      rows().set(share.token, share);
    },
    get: async (token) => rows().get(token) ?? null,
  };
}

export function createPostgresSessionShareStore(connectionString: string): SessionShareStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, SESSION_SHARES_MIGRATION]);
  return {
    async create(share) {
      const { visibility } = share;
      await q(
        `INSERT INTO session_shares(token, session_id, audience, created_by, created_at,
           min_seq, max_seq, min_created_at, max_created_at, messages, files)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
        [
          share.token,
          share.sessionId,
          share.audience,
          share.createdBy,
          share.createdAt,
          visibility.minSeq,
          visibility.maxSeq,
          visibility.minCreatedAt,
          visibility.maxCreatedAt,
          pgJsonText(share.messages),
          pgJsonText(share.files),
        ],
      );
    },
    async get(token) {
      const [row] = await q(
        `SELECT token, session_id, audience, created_by, created_at, min_seq, max_seq,
                min_created_at, max_created_at, messages, files
           FROM session_shares WHERE tenant_id = ${TENANT} AND token = $1`,
        [token],
      );
      if (!row) return null;
      return {
        token: String(row.token),
        sessionId: String(row.session_id),
        audience: row.audience as SessionShare["audience"],
        createdBy: String(row.created_by),
        createdAt: Number(row.created_at),
        visibility: {
          minSeq: Number(row.min_seq),
          maxSeq: Number(row.max_seq),
          minCreatedAt: Number(row.min_created_at),
          maxCreatedAt: Number(row.max_created_at),
        },
        messages: row.messages as SharedMessage[],
        files: row.files as SessionShare["files"],
      };
    },
    close,
  };
}

interface ProjectedMessage {
  role: "user" | "assistant";
  text: string;
  attachmentIds?: string[];
}

function attachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) =>
    file && typeof file === "object" && typeof file.artifactId === "string" ? [file.artifactId] : [],
  );
}

export function sharedMessages(
  entries: SessionEntry[],
  deliveredAttachments: ReadonlyMap<number, string[]> = new Map(),
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  const posts = new Map<string, string>();
  let posted = false;
  const emit = (role: "user" | "assistant", text: string, files: string[]) => {
    if (!text.trim() && !files.length) return;
    messages.push({ role, text, ...(files.length ? { attachmentIds: [...new Set(files)] } : {}) });
  };
  for (const entry of entries) {
    const p = entry.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const payload = p as Record<string, unknown>;
    if (entry.type === "user") {
      posted = false;
      posts.clear();
      if (payload.hidden || payload.overheard) continue;
      const text = typeof payload.display === "string" && payload.display.trim() ? payload.display : payload.text;
      emit("user", typeof text === "string" ? text : "", attachmentIds(payload.attachments));
    } else if (entry.type === "tool_call" && payload.action === "post") {
      if (typeof payload.callId === "string")
        posts.set(payload.callId, typeof payload.text === "string" ? payload.text : "");
    } else if (entry.type === "tool_result") {
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const text = posts.get(callId);
      posts.delete(callId);
      if (payload.isError === true || payload.ok === false) continue;
      if (text !== undefined) {
        emit("assistant", text, attachmentIds(payload.files));
        posted = true;
      }
    } else if (entry.type === "assistant") {
      emit(
        "assistant",
        !posted && typeof payload.text === "string" ? payload.text : "",
        deliveredAttachments.get(entry.seq) ?? [],
      );
      posted = false;
      posts.clear();
    } else if (entry.type === "delivery") {
      const ids = attachmentIds(payload.files);
      const last = messages.at(-1);
      if (ids.length && last?.role === "assistant")
        last.attachmentIds = [...new Set([...(last.attachmentIds ?? []), ...ids])];
      else emit("assistant", "", ids);
    }
  }
  return messages;
}
