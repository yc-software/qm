import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ScopeId } from "../types.ts";
import type { ByteSource } from "./durable-byte-store.ts";

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
  limit?: number;
  cursor?: string;
  includeDisabled?: boolean;
  createdInScope?: ScopeId;
  nameQuery?: string;
}

export type FileArtifactRef = Pick<FileArtifact, "ownerScopeId" | "id">;
export class FileArtifactDeletedError extends Error {
  constructor() {
    super("file was deleted");
    this.name = "FileArtifactDeletedError";
  }
}

export interface FileArtifactStore {
  put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;
  publish(input: PublishFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;

  get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null>;

  open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: Readable } | null>;

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
