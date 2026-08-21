import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ScopeId } from "../types.ts";
import type { ByteSource, DurableByteStore } from "./durable-byte-store.ts";

function idOrderDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

export type FileDirection = "in" | "out";
export type FileSource = "live" | "backfill";

export interface FileArtifact {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  name: string;
  path: string;
  mimetype: string;
  sizeBytes: number;
  blobKey: string | null;
  sha256: string | null;
  direction: FileDirection;
  source: FileSource;
  createdInScope?: ScopeId;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface PutFileInput {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  name: string;
  path: string;
  mimetype: string;
  data: ByteSource;
  direction: FileDirection;
  createdInScope?: ScopeId;
  createdAt?: number;
  maxBytes?: number;
}

export interface FilePage {
  files: FileArtifact[];
  nextCursor?: string;
}

export interface ListOwnedOptions {
  limit?: number;
  cursor?: string;
  includeDisabled?: boolean;
  createdInScope?: ScopeId;
  /**
   * Collapse per-turn duplicate rows: one row per document (the earliest
   * registration of each sha256; null-sha rows stay distinct). The artifact
   * table is a per-turn ledger — a document re-attached each turn is a new row
   * by construction — so USER-FACING file views pass this to stop the file
   * list growing with use. Ledger/admin listings leave it off (#601).
   */
  distinctByContent?: boolean;
}

export interface FileArtifactStore {
  put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;

  get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null>;

  open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: Readable } | null>;

  listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage>;

  resolveByOwnerPaths(refs: ReadonlyArray<{ ownerScopeId: ScopeId; path: string }>): Promise<FileArtifact[]>;

  setEnabled(id: string, enabled: boolean): Promise<void>;

  delete(id: string): Promise<void>;
}

export function fileArtifactId(seed: string, direction: FileDirection, batchIndex: number): string {
  return createHash("sha256").update(`${seed}:${direction}:${batchIndex}`).digest("hex").slice(0, 32);
}

/**
 * The artifact store's own path namespace. Files that exist only as artifacts
 * (viewer uploads, inbound attachments) live at artifacts/<id>/<name>;
 * workspace-backed files never do. The namespace is what lets a shared-handle
 * read pick the right backing store without a precedence rule.
 */
export function artifactPath(id: string, name: string): string {
  return `artifacts/${id}/${name}`;
}

export function isArtifactPath(path: string): boolean {
  return /^artifacts\/[0-9a-f]{32}\//.test(path);
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function encodeCursor(a: FileArtifact): string {
  return Buffer.from(`${a.createdAt}|${a.id}`, "utf8").toString("base64url");
}
export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (at == null || id == null) return null;
    const createdAt = Number(at);
    return Number.isFinite(createdAt) ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

function afterCursor(a: FileArtifact, c: { createdAt: number; id: string }): boolean {
  return a.createdAt < c.createdAt || (a.createdAt === c.createdAt && a.id < c.id);
}

export function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export function createMemoryFileArtifactStore(byteStore: DurableByteStore): FileArtifactStore {
  const rows = new Map<string, FileArtifact>();

  return {
    async put(input) {
      const existing = rows.get(input.id);
      if (existing) return { artifact: existing, created: false };
      const { blobKey, sizeBytes, sha256 } = await byteStore.put(
        input.data,
        input.maxBytes != null ? { maxBytes: input.maxBytes } : {},
      );
      const at = input.createdAt ?? Date.now();
      const artifact: FileArtifact = {
        id: input.id,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        name: input.name,
        path: input.path,
        mimetype: input.mimetype,
        sizeBytes,
        blobKey,
        sha256,
        direction: input.direction,
        source: "live",
        ...(input.createdInScope ? { createdInScope: input.createdInScope } : {}),
        createdAt: at,
        updatedAt: at,
        enabled: true,
      };
      rows.set(artifact.id, artifact);
      return { artifact, created: true };
    },

    async get(id, opts) {
      const r = rows.get(id);
      if (!r) return null;
      if (!r.enabled && !opts?.includeDisabled) return null;
      return r;
    },

    async open(id) {
      const r = rows.get(id);
      if (!r || !r.enabled || !r.blobKey) return null;
      const bytes = await byteStore.open(r.blobKey);
      if (!bytes) return null;
      return { artifact: r, sizeBytes: bytes.sizeBytes, stream: bytes.stream };
    },

    async listOwnedByScopes(scopes, opts) {
      const set = new Set(scopes);
      const limit = clampLimit(opts?.limit);
      const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;
      let all = [...rows.values()]
        .filter((r) => set.has(r.ownerScopeId) && (opts?.includeDisabled || r.enabled))
        .filter((r) => opts?.createdInScope == null || r.createdInScope === opts.createdInScope);
      if (opts?.distinctByContent) {
        // Group FIRST (over every matching row, cursor ignored), then apply
        // the cursor to the representatives: a group whose earliest row was
        // already emitted on a prior page must not reappear via a later
        // duplicate that happens to follow the cursor (#601).
        const earliest = new Map<string, FileArtifact>();
        for (const r of all) {
          const key = r.sha256 ?? `id:${r.id}`;
          const cur = earliest.get(key);
          if (!cur || r.createdAt < cur.createdAt || (r.createdAt === cur.createdAt && r.id < cur.id)) {
            earliest.set(key, r);
          }
        }
        all = [...earliest.values()];
      }
      all = all
        .filter((r) => (cursor ? afterCursor(r, cursor) : true))
        .sort((a, b) => b.createdAt - a.createdAt || idOrderDesc(a.id, b.id));
      const page = all.slice(0, limit);
      const nextCursor = all.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : undefined;
      return { files: page, ...(nextCursor ? { nextCursor } : {}) };
    },

    async resolveByOwnerPaths(refs) {
      if (refs.length === 0) return [];
      const want = new Set(refs.map((r) => `${r.ownerScopeId}\0${r.path}`));
      return [...rows.values()].filter((r) => r.enabled && want.has(`${r.ownerScopeId}\0${r.path}`));
    },

    async setEnabled(id, enabled) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, enabled, updatedAt: Date.now() });
    },

    async delete(id) {
      rows.delete(id);
    },
  };
}
