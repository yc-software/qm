import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { lock } from "proper-lockfile";
import type { ScopeId } from "../types.ts";
import { scopeStorageKey } from "../util/scope-storage-key.ts";

export interface WorkspaceStore {
  scopeDir(scopeId: ScopeId): string;
  ensureScope(scopeId: ScopeId): Promise<void>;
  read(scopeId: ScopeId, relPath: string): Promise<string | null>;
  readBytes(scopeId: ScopeId, relPath: string): Promise<Uint8Array | null>;
  write(scopeId: ScopeId, relPath: string, data: string | Uint8Array): Promise<void>;
  update?(
    scopeId: ScopeId,
    relPath: string,
    derive: (current: string | null) => string | Uint8Array | null,
  ): Promise<void>;
  remove(scopeId: ScopeId, relPath: string): Promise<void>;
  list(scopeId: ScopeId): Promise<string[]>;
}

function safeJoin(baseDir: string, relPath: string): string {
  const target = resolve(baseDir, relPath);
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return target;
}

async function updateFile(path: string, derive: (current: string | null) => string | Uint8Array | null) {
  await mkdir(dirname(path), { recursive: true });
  const release = await lock(path, { realpath: false, retries: { retries: 100, minTimeout: 10, maxTimeout: 100 } });
  try {
    let current: string | null;
    try {
      current = await readFile(path, "utf8");
    } catch {
      current = null;
    }
    const next = derive(current);
    if (next === null) await rm(path, { force: true });
    else await writeFile(path, next);
  } finally {
    await release();
  }
}

export function createLocalWorkspaceStore(rootDir: string): WorkspaceStore {
  const base = resolve(rootDir, "workspaces");

  function scopeDir(scopeId: ScopeId): string {
    return join(base, scopeStorageKey(scopeId));
  }

  const store: WorkspaceStore = {
    scopeDir,
    async ensureScope(scopeId) {
      await mkdir(scopeDir(scopeId), { recursive: true });
    },
    async read(scopeId, relPath) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async readBytes(scopeId, relPath) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    },
    async write(scopeId, relPath, data) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    async update(scopeId, relPath, derive) {
      await updateFile(safeJoin(scopeDir(scopeId), relPath), derive);
    },
    async remove(scopeId, relPath) {
      await rm(safeJoin(scopeDir(scopeId), relPath), { force: true });
    },
    async list(scopeId) {
      try {
        const entries = await readdir(scopeDir(scopeId), { recursive: true, withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
      } catch {
        return [];
      }
    },
  };
  return store;
}
