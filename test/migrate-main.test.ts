import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { OTHER_TENANT } from "./support/tenant.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "migration command closes runtime listeners, is a no-op without legacy data, refuses an ambiguous owner, moves pre-tenant storage once and exits naturally",
  { skip: !databaseUrl, timeout: 150_000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qm-migrate-test-"));
    const migrate = () =>
      promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl,
          DATABASE_OWNER_URL: databaseUrl,
          SANDBOX_BACKEND: "local",
          CONNECTOR_SECRET_KEY: "migration-test-connector-secret",
          CAPABILITY_SECRET: "migration-test-capability-secret",
          DATA_DIR: dataDir,
        },
        timeout: 35_000,
        killSignal: "SIGKILL",
      });
    try {
      const { stdout } = await migrate();
      assert.match(stdout, /\[qm:migrate\] database migrations applied/);
      assert.match(stdout, /tenant storage layout applied \(0 moved\)/);
      const db = createPgPool(databaseUrl!);
      await db.q("DELETE FROM qm_schema_migrations WHERE id = 'tenants/storage-layout'");
      await mkdir(join(dataDir, "workspaces", "personal__legacy"), { recursive: true });
      await writeFile(join(dataDir, "workspaces", "personal__legacy", "notes.md"), "kept");
      await assert.rejects(migrate(), /predates tenant storage and this database has 2 tenants/);
      await db.q("DELETE FROM tenants WHERE id = $1", [OTHER_TENANT]);
      await db.close();
      assert.match((await migrate()).stdout, /tenant storage layout applied \(1 moved\)/);
      const [tenant] = await readdir(join(dataDir, "workspaces"));
      assert.equal(
        await readFile(join(dataDir, "workspaces", tenant!, "personal__legacy", "notes.md"), "utf8"),
        "kept",
      );
      assert.doesNotMatch((await migrate()).stdout, /tenant storage layout applied/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
