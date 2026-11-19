import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { hashId } from "../util/crypto.ts";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ScopeId } from "../types.ts";
import type { SourceProvenance } from "../memory/facts.ts";
import type { ByteSource } from "./durable-byte-store.ts";
import type { Tenant } from "../tenants/context.ts";

export type FileDirection = "in" | "out";
export type FileSource = "live" | "backfill";

export interface FileArtifact {
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
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

export function fileSharingRevision(file: FileArtifact): string {
  return hashId([canonicalJson(file)], 64);
}

export interface PutFileInput {
  contextSessionIds?: readonly string[];
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
  reuseExistingPath?: boolean;
}

type PublishFileInput = Omit<PutFileInput, "data" | "maxBytes"> & {
  blobKey: string;
  sizeBytes: number;
  sha256: string | null;
};

export interface FilePage {
  files: FileArtifact[];
  nextCursor?: string;
}

export interface ListOwnedOptions {
  excludePersonalOnly?: boolean;
  limit?: number;
  cursor?: string;
  includeDisabled?: boolean;
  createdInScope?: ScopeId;
  nameQuery?: string;
  name?: string;
}

export type FileArtifactRef = Pick<FileArtifact, "ownerScopeId" | "id">;
export class FileArtifactDeletedError extends Error {
  constructor() {
    super("file was deleted");
    this.name = "FileArtifactDeletedError";
  }
}

export interface FileArtifactStore {
  releasePrivate(
    tenant: Tenant,
    id: string,
    revision: string,
    sourceProvenance: SourceProvenance,
    writeGrant: (transaction: PoolClient) => Promise<void>,
  ): Promise<FileArtifact>;
  put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;
  publish(input: PublishFileInput, transaction?: PoolClient): Promise<{ artifact: FileArtifact; created: boolean }>;

  get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null>;
  getMany(tenant: Tenant, ids: readonly string[], opts?: { includeDisabled?: boolean }): Promise<FileArtifact[]>;

  open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: Readable } | null>;

  listContext(
    scopes: readonly ScopeId[],
    opts?: Pick<ListOwnedOptions, "limit" | "excludePersonalOnly">,
  ): Promise<FileArtifact[]>;
  listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage>;

  listDocuments(
    scopes: readonly ScopeId[],
    sharedRefs: readonly FileArtifactRef[],
    opts?: ListOwnedOptions,
  ): Promise<FilePage>;

  resolveByIds(refs: readonly FileArtifactRef[]): Promise<FileArtifact[]>;

  setEnabled(id: string, enabled: boolean): Promise<void>;

  delete(id: string): Promise<void>;
}

export function fileArtifactId(seed: string, direction: FileDirection, batchIndex: number): string {
  return createHash("sha256").update(`${seed}:${direction}:${batchIndex}`).digest("hex").slice(0, 32);
}

export function artifactPath(id: string, name: string): string {
  return `artifacts/${id}/${name}`;
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

export function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
