import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createSandboxMigrationRunner } from "../src/sandbox/sandbox-migration-runner.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle, ExecResult } from "../src/sandbox/sandbox.ts";
import { testConfig } from "./support/test-config.ts";

function hostBackend(name: string, homeDir: string): Sandbox {
  mkdirSync(homeDir, { recursive: true });
  const rootDir = join(homeDir, "workspace");
  mkdirSync(rootDir, { recursive: true });
  const resolve = (rel: string) => join(rootDir, rel);
  return {
    profile: { backend: name, writablePersistence: "resident_disk", processSessions: false },
    async provision(): Promise<SandboxHandle> {
      return { id: `${name}-box`, rootDir, homeDir };
    },
    async run(_h: SandboxHandle, command: string): Promise<ExecResult> {
      const r = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "" },
      });
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, timedOut: false };
    },
    async readFileBytes(_h: SandboxHandle, rel: string): Promise<Uint8Array | null> {
      const p = resolve(rel);
      return existsSync(p) ? readFileSync(p) : null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array): Promise<void> {
      const p = resolve(rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
    async teardown(): Promise<void> {},
    async readFile() {
      return null;
    },
    async writeFile() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
  } as unknown as Sandbox;
}

function start(root: string) {
  const fat = hostBackend("aws", join(root, "aws-home"));
  const thin = hostBackend("sprites", join(root, "sprites-home"));
  (fat as { backupComputer?: unknown }).backupComputer = async () => [];
  const routes = createMemoryMap<SandboxRoute>();
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-migrate-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    workspace: built.workspace,
    sandboxMigration: createSandboxMigrationRunner({
      backends: { aws: fat, sprites: thin },
      routes,
      defaultBackend: "aws",
    }),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, routes, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
const migrate = (base: string, scopeId: string, body: unknown, headers: Record<string, string> = ALICE) =>
  fetch(`${base}/v1/admin/sandbox-routes/${encodeURIComponent(scopeId)}/migrate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test("the migrate endpoint refuses a capability-losing move, then records what force gave up", async () => {
  const root = mkdtempSync(join(tmpdir(), "admin-migrate-e2e-"));
  const s = start(root);
  try {
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");

    const refused = await migrate(s.base, "personal:yna", { to: "sprites" });
    assert.equal(refused.status, 409);
    const refusedBody = (await refused.json()) as { error: string; message: string };
    assert.equal(refusedBody.error, "migration_failed");
    assert.match(refusedBody.message, /home backup \(publish, resident-auth capture\)/);
    assert.match(refusedBody.message, /force/);
    assert.equal(await s.routes.get("personal:yna"), null, "a refused migration leaves the scope where it was");
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "sandbox_routes.migrate_failed"),
      "the refusal is audited",
    );

    const forced = await migrate(s.base, "personal:yna", { to: "sprites", reason: "canary", force: true });
    assert.equal(forced.status, 200);
    const body = (await forced.json()) as { to: string; capabilitiesLost: string[]; sha: string };
    assert.equal(body.to, "sprites");
    assert.deepEqual(body.capabilitiesLost, ["home backup (publish, resident-auth capture)"]);

    assert.equal(readFileSync(join(root, "sprites-home", "notes.txt"), "utf8"), "hello\n");
    const route = await s.routes.get("personal:yna");
    assert.equal(route?.backend, "sprites");
    assert.equal(route?.reason, "canary");
    assert.deepEqual(route?.capabilitiesLost, ["home backup (publish, resident-auth capture)"]);

    const migrated = (await s.built.auditLog.events()).find((e) => e.action === "sandbox_routes.migrate");
    assert.ok(migrated, "the migration is audited");
    assert.match(migrated.resource ?? "", /lost=home backup/);
    assert.equal(migrated.scopeLabel, "personal:yna");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrating a scope is org-admin only", async () => {
  const root = mkdtempSync(join(tmpdir(), "admin-migrate-authz-"));
  const s = start(root);
  try {
    const r = await migrate(
      s.base,
      "personal:yna",
      { to: "sprites", force: true },
      {
        "x-admin-actor": "stranger@default-org",
        "content-type": "application/json",
      },
    );
    assert.ok(r.status === 401 || r.status === 403, `expected a refusal, got ${r.status}`);
    assert.equal(await s.routes.get("personal:yna"), null, "a rejected caller cannot move a scope");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});
