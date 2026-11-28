import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";
import { APP_ROLE, boundUrl, seedTestTenant } from "./support/test-tenant.ts";

test(
  "migration command readies the vector index for an app login, closes runtime listeners and exits naturally",
  { skip: !process.env.DATABASE_URL, timeout: 45_000 },
  async () => {
    const databaseUrl = testBareDatabaseUrl();
    await seedTestTenant(databaseUrl);
    const dataDir = await mkdtemp(join(tmpdir(), "qm-migrate-test-"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl,
          SANDBOX_BACKEND: "local",
          CONNECTOR_SECRET_KEY: "migration-test-connector-secret",
          CAPABILITY_SECRET: "migration-test-capability-secret",
          DATA_DIR: dataDir,
        },
        timeout: 35_000,
        killSignal: "SIGKILL",
      });
      assert.match(stdout, /\[qm:migrate\] database migrations applied/);
      const owner = createPgPool(databaseUrl);
      const offered = await owner
        .q("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
        .finally(() => owner.close());
      if (!offered.length) return;
      const vectors = createPostgresVectorStore(boundUrl(databaseUrl, APP_ROLE));
      assert.deepEqual(await vectors.claimTenants().finally(() => vectors.close()), []);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
