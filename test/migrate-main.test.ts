import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "migration command closes runtime listeners and exits naturally",
  { skip: !databaseUrl, timeout: 45_000 },
  async (t) => {
    const database = await isolatedPostgres("migrate_main");
    t.after(() => database.cleanup());
    const dataDir = await mkdtemp(join(tmpdir(), "qm-migrate-test-"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: database.url,
          SESSION_STORE: "postgres",
          HARNESS: "mock",
          SANDBOX_BACKEND: "local",
          CONNECTOR_SECRET_KEY: "migration-test-connector-secret",
          CAPABILITY_SECRET: "migration-test-capability-secret",
          DATA_DIR: dataDir,
        },
        timeout: 35_000,
        killSignal: "SIGKILL",
      });
      assert.match(stdout, /\[qm:migrate\] database migrations applied/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
