import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { withoutTenant } from "../src/tenants/context.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to boot core and the worker";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function start(entry: string, env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  let output = "";
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

async function until(
  check: () => Promise<boolean> | boolean,
  what: string,
  { child, output }: { child: ChildProcess; output: () => string },
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`${what} timed out:\n${output().slice(-4000)}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function migratedEmptyDatabase(url: string): Promise<void> {
  const built = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  await built.runtime.stop();
  const admin = new pg.Pool({ connectionString: url });
  try {
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    await admin.query("INSERT INTO tenants(id, slug, name) VALUES ($1, 'first', 'First'), ($2, 'second', 'Second')", [
      TEST_TENANT,
      OTHER_TENANT,
    ]);
  } finally {
    await admin.end();
  }
}

async function bootCoreAndWorker(url: string): Promise<void> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: url,
    DATABASE_OWNER_URL: url,
    PORT: String(port),
    DATA_DIR: mkdtempSync(join(tmpdir(), "two-tenant-boot-")),
    SHUTDOWN_DRAIN_MS: "250",
    CONNECTOR_SECRET_KEY: "two-tenant-boot-connector-key-0123456789",
    CAPABILITY_SECRET: "two-tenant-boot-capability-key-0123456789",
    CORE_SIGNING_SECRET: "two-tenant-boot-signing-secret-0123456789",
  };
  const core = start("src/index.ts", env);
  const worker = start("src/runs/worker-main.ts", env);
  try {
    await until(
      async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.status === 200,
      "core /healthz",
      core,
    );
    await until(() => worker.output().includes("[qm:worker] draining runs"), "worker drain loop", worker);
    assert.equal(core.child.exitCode, null, core.output());
    assert.equal(worker.child.exitCode, null, worker.output());
  } finally {
    await Promise.all([stop(core.child), stop(worker.child)]);
  }
}

test("core and the worker boot on a freshly migrated database holding two tenants", { skip, timeout: 240_000 }, () =>
  withoutTenant(async () => {
    const server = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const name = `boot_${randomUUID().replaceAll("-", "")}`;
    await server.query(`CREATE DATABASE ${name}`);
    const target = new URL(process.env.DATABASE_URL!);
    target.pathname = `/${name}`;
    try {
      const url = target.toString();
      await migratedEmptyDatabase(url);
      await bootCoreAndWorker(url);
    } finally {
      await server.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await server.end();
    }
  }),
);
