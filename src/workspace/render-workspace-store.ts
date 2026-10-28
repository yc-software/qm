import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { createLocalWorkspaceStore, safeJoin, type WorkspaceStore } from "./workspace-store.ts";

const NESTED_PATH = "(starts_with(path, $2 || '/') OR starts_with($2, path || '/'))";
const SHAPE_ERRORS = new Set(["EEXIST", "EISDIR", "ENOTDIR"]);

const absent = (error: unknown): null => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw error;
};

export function createRenderWorkspaceStore(rootDir: string, connectionString: string): WorkspaceStore {
  const local = createLocalWorkspaceStore(rootDir);
  const queue = createKeyedQueue<string>();
  const synced = new Map<string, number>();
  const db = createPgPool(connectionString, [
    {
      id: "render/workspace/v1",
      statements: [
        `CREATE TABLE IF NOT EXISTS render_workspace_files (
          scope_id TEXT NOT NULL,
          path TEXT NOT NULL,
          data BYTEA NOT NULL,
          PRIMARY KEY (scope_id, path)
        )`,
        `CREATE TABLE IF NOT EXISTS render_workspace_scopes (
          scope_id TEXT PRIMARY KEY,
          revision BIGINT NOT NULL
        )`,
        `CREATE OR REPLACE FUNCTION render_workspace_bump() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF TG_OP <> 'INSERT' THEN
            INSERT INTO render_workspace_scopes(scope_id, revision) VALUES (OLD.scope_id, 1)
            ON CONFLICT (scope_id) DO UPDATE SET revision = render_workspace_scopes.revision + 1;
          END IF;
          IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
            INSERT INTO render_workspace_scopes(scope_id, revision) VALUES (NEW.scope_id, 1)
            ON CONFLICT (scope_id) DO UPDATE SET revision = render_workspace_scopes.revision + 1;
          END IF;
          RETURN NULL;
        END
        $fn$`,
        `DROP TRIGGER IF EXISTS render_workspace_bump ON render_workspace_files`,
        `CREATE TRIGGER render_workspace_bump
          AFTER INSERT OR UPDATE OR DELETE ON render_workspace_files
          FOR EACH ROW EXECUTE FUNCTION render_workspace_bump()`,
      ],
    },
  ]);
  const pathFor = (scope: ScopeId, input: string): string => {
    const base = local.scopeDir(scope);
    const path = relative(base, safeJoin(base, input));
    if (!path || input.includes("\0")) throw new Error(`path escapes workspace: ${input}`);
    return path;
  };
  async function transaction<T>(scope: ScopeId, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withPgTransaction(await db.pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`render-workspace:${scope}`]);
      return fn(client);
    });
  }
  async function clearShape(scope: ScopeId, path: string): Promise<void> {
    let dir = local.scopeDir(scope);
    for (const part of path.split("/").slice(0, -1)) {
      dir = join(dir, part);
      const info = await lstat(dir).catch(absent);
      if (!info) break;
      if (!info.isDirectory()) {
        await rm(dir, { force: true });
        break;
      }
    }
    await rm(join(local.scopeDir(scope), path), { recursive: true, force: true });
  }
  async function cache(scope: ScopeId, path: string, data: string | Uint8Array): Promise<void> {
    const abs = join(local.scopeDir(scope), path);
    const put = async (): Promise<void> => {
      await mkdir(dirname(abs), { recursive: true });
      const temp = join(dirname(abs), `.qm-cache-${randomBytes(6).toString("hex")}`);
      try {
        await writeFile(temp, data);
        await rename(temp, abs);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    };
    await put().catch(async (error: unknown) => {
      if (!SHAPE_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await clearShape(scope, path);
      await put();
    });
  }
  async function uncache(scope: ScopeId, path: string): Promise<void> {
    const abs = join(local.scopeDir(scope), path);
    const info = await lstat(abs).catch(absent);
    if (info && !info.isDirectory()) await rm(abs, { force: true });
  }
  async function revisionOf(client: Pick<PoolClient, "query">, scope: ScopeId): Promise<number> {
    const rows = await client.query("SELECT revision FROM render_workspace_scopes WHERE scope_id=$1", [scope]);
    return Number(rows.rows[0]?.revision ?? 0);
  }
  async function mutate(
    scope: ScopeId,
    fn: (client: PoolClient) => Promise<number>,
  ): Promise<{ before: number; after: number; changed: number }> {
    return transaction(scope, async (client) => {
      const before = await revisionOf(client, scope);
      const changed = await fn(client);
      return { before, after: await revisionOf(client, scope), changed };
    });
  }
  async function mirror(
    scope: ScopeId,
    revision: { before: number; after: number; changed: number },
    update: () => Promise<void>,
  ): Promise<void> {
    const current = synced.get(scope) === revision.before && revision.after === revision.before + revision.changed;
    synced.delete(scope);
    await update();
    if (current) synced.set(scope, revision.after);
  }
  async function readBytes(scope: ScopeId, relPath: string): Promise<Uint8Array | null> {
    const path = pathFor(scope, relPath);
    return queue(scope, async () => {
      const rows = await db.q("SELECT data FROM render_workspace_files WHERE scope_id=$1 AND path=$2", [scope, path]);
      if (!rows[0]) {
        await uncache(scope, path);
        return null;
      }
      const data = rows[0].data as Buffer;
      await cache(scope, path, data);
      return data;
    });
  }
  async function list(scope: ScopeId, opts?: { limit: number }): Promise<string[]> {
    return queue(scope, async () => {
      const limit = opts ? Math.max(0, Math.floor(opts.limit)) : null;
      if (limit !== null && !Number.isFinite(limit)) throw new Error("workspace list limit must be finite");
      const revision = await revisionOf(await db.pool(), scope);
      await local.ensureScope(scope);
      if (synced.get(scope) === revision) {
        const rows = await db.q("SELECT path FROM render_workspace_files WHERE scope_id=$1 ORDER BY path LIMIT $2", [
          scope,
          limit,
        ]);
        const present = new Set(await local.list(scope));
        const paths = rows.map((row) => join(local.scopeDir(scope), pathFor(scope, row.path as string)));
        if (paths.every((path) => present.has(path))) return paths;
        synced.delete(scope);
      }
      const rows = await db.q(
        "SELECT path, data FROM render_workspace_files WHERE scope_id=$1 ORDER BY path LIMIT $2",
        [scope, limit],
      );
      const paths: string[] = [];
      for (const row of rows) {
        const path = pathFor(scope, row.path as string);
        await cache(scope, path, row.data as Buffer);
        paths.push(join(local.scopeDir(scope), path));
      }
      if (!opts) {
        const retained = new Set(paths);
        for (const abs of await local.list(scope)) {
          if (!retained.has(abs)) await uncache(scope, relative(local.scopeDir(scope), abs));
        }
        synced.set(scope, revision);
      }
      return paths;
    });
  }
  return {
    scopeDir: local.scopeDir,
    async ensureScope(scope) {
      await list(scope);
    },
    async read(scope, path) {
      const bytes = await readBytes(scope, path);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },
    readBytes,
    async write(scope, input, data) {
      const path = pathFor(scope, input);
      await queue(scope, async () => {
        const revision = await mutate(scope, async (client) => {
          const conflict = await client.query(
            `SELECT 1 FROM render_workspace_files WHERE scope_id=$1 AND ${NESTED_PATH} LIMIT 1`,
            [scope, path],
          );
          if (conflict.rowCount) throw new Error(`workspace file conflicts with a directory: ${path}`);
          const written = await client.query(
            `INSERT INTO render_workspace_files(scope_id, path, data) VALUES($1, $2, $3)
             ON CONFLICT (scope_id, path) DO UPDATE SET data=EXCLUDED.data
             WHERE render_workspace_files.data IS DISTINCT FROM EXCLUDED.data`,
            [scope, path, Buffer.from(data)],
          );
          return written.rowCount ?? 0;
        });
        await mirror(scope, revision, () => cache(scope, path, data));
      });
    },
    async remove(scope, input) {
      const path = pathFor(scope, input);
      await queue(scope, async () => {
        const revision = await mutate(scope, async (client) => {
          const removed = await client.query("DELETE FROM render_workspace_files WHERE scope_id=$1 AND path=$2", [
            scope,
            path,
          ]);
          return removed.rowCount ?? 0;
        });
        await mirror(scope, revision, () => uncache(scope, path));
      });
    },
    list,
  };
}
