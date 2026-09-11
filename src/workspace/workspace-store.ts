import { mkdir, readFile, writeFile, readdir, opendir, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import type { ScopeId } from "../types.ts";
import { scopeStorageKey } from "../util/scope-storage-key.ts";

export interface WorkspaceStore {
  scopeDir(scopeId: ScopeId): string;
  ensureScope(scopeId: ScopeId): Promise<void>;
  read(scopeId: ScopeId, relPath: string): Promise<string | null>;
  readBytes(scopeId: ScopeId, relPath: string): Promise<Uint8Array | null>;
  write(scopeId: ScopeId, relPath: string, data: string | Uint8Array): Promise<void>;
  remove(scopeId: ScopeId, relPath: string): Promise<void>;
  list(scopeId: ScopeId, opts?: { limit: number }): Promise<string[]>;
}

function safeJoin(baseDir: string, relPath: string): string {
  const target = resolve(baseDir, relPath);
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return target;
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
    async remove(scopeId, relPath) {
      await rm(safeJoin(scopeDir(scopeId), relPath), { force: true });
    },
    async list(scopeId, opts) {
      try {
        if (opts) {
          const limit = Math.max(0, Math.floor(opts.limit));
          const paths: string[] = [];
          const dirs = [scopeDir(scopeId)];
          let inspected = 0;
          while (dirs.length && paths.length < limit && inspected < limit * 8) {
            const dir = dirs.shift()!;
            for await (const entry of await opendir(dir)) {
              if (++inspected > limit * 8 || paths.length >= limit) break;
              const path = join(dir, entry.name);
              if (entry.isFile()) paths.push(path);
              else if (entry.isDirectory()) dirs.push(path);
            }
          }
          return paths;
        }
        const entries = await readdir(scopeDir(scopeId), { recursive: true, withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
      } catch {
        return [];
      }
    },
  };
  return store;
}
