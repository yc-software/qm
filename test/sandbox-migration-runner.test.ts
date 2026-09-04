import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSandboxMigrationRunner } from "../src/sandbox/sandbox-migration-runner.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle, ExecResult } from "../src/sandbox/sandbox.ts";

function hostBackend(name: string, homeDir: string): Sandbox & { tornDown: number } {
  mkdirSync(homeDir, { recursive: true });
  const rootDir = join(homeDir, "workspace");
  mkdirSync(rootDir, { recursive: true });
  const resolve = (rel: string) => join(rootDir, rel);
  const s = {
    tornDown: 0,
    profile: { backend: name, writablePersistence: "resident_disk" as const, processSessions: false },
    async provision(): Promise<SandboxHandle> {
      return { id: `${name}-box`, rootDir, homeDir };
    },
    async run(_h: SandboxHandle, command: string): Promise<ExecResult> {
      const r = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "" },
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        code: r.status ?? (r.signal ? 137 : -1),
        timedOut: false,
      };
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
    async teardown(): Promise<void> {
      s.tornDown++;
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
  };
  return s as unknown as Sandbox & { tornDown: number };
}

function build(root: string) {
  const aws = hostBackend("aws", join(root, "aws-home"));
  const sprites = hostBackend("sprites", join(root, "sprites-home"));
  const routes = createMemoryMap<SandboxRoute>();
  return { aws, sprites, routes };
}

test("migrateScope copies $HOME, flips the route only after a verified copy, and parks both boxes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-runner-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const runner = createSandboxMigrationRunner({ backends: { aws, sprites }, routes, defaultBackend: "aws" });
    const res = await runner.migrateScope("personal:alice", "sprites", "canary");
    assert.equal(res.from, "aws");
    assert.equal(res.to, "sprites");
    assert.match(res.sha, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(root, "sprites-home", "notes.txt"), "utf8"), "hello\n");
    const route = await routes.get("personal:alice");
    assert.equal(route?.backend, "sprites");
    assert.equal(route?.migrationSha, res.sha);
    assert.equal(route?.reason, "canary");
    assert.equal(aws.tornDown, 1);
    assert.equal(sprites.tornDown, 1);
    const back = await runner.migrateScope("personal:alice", "aws");
    assert.equal(back.from, "sprites");
    assert.equal((await routes.get("personal:alice"))?.backend, "aws");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses: same backend, pinned scope, live work, unconstructed target", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-refuse-"));
  try {
    const { aws, sprites, routes } = build(root);
    const busy = new Set<string>();
    const runner = createSandboxMigrationRunner({
      backends: { aws, sprites },
      routes,
      defaultBackend: "aws",
      hasLiveWork: async (scopeId) => busy.has(scopeId),
    });
    await assert.rejects(runner.migrateScope("personal:a", "aws"), /already on aws/);
    await assert.rejects(runner.migrateScope("personal:a", "local"), /not constructed/);
    await routes.put("personal:pinned", { backend: "aws", pinned: true, reason: "big box" });
    await assert.rejects(runner.migrateScope("personal:pinned", "sprites"), /pinned/);
    busy.add("personal:busy");
    await assert.rejects(runner.migrateScope("personal:busy", "sprites"), /live background work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses a target that carries fewer capabilities, unless forced", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-caps-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const awsWithBackup: Sandbox = {
      ...aws,
      async backupComputer() {
        return [];
      },
    };
    const runner = createSandboxMigrationRunner({
      backends: { aws: awsWithBackup, sprites },
      routes,
      defaultBackend: "aws",
    });

    await assert.rejects(runner.migrateScope("personal:alice", "sprites"), /home backup/);
    assert.equal(await routes.get("personal:alice"), null, "a refused migration must not flip the route");

    const forced = await runner.migrateScope("personal:alice", "sprites", "canary", { force: true });
    assert.deepEqual(forced.capabilitiesLost, ["home backup (publish, resident-auth capture)"]);
    const route = await routes.get("personal:alice");
    assert.equal(route?.backend, "sprites");
    assert.deepEqual(route?.capabilitiesLost, ["home backup (publish, resident-auth capture)"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resync after the settle window keeps the durable record of what was lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-resync-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const awsWithBackup: Sandbox = {
      ...aws,
      async backupComputer() {
        return [];
      },
      async run(h, command, o) {
        if (command.includes("-newermt")) return { stdout: "notes.txt\n", stderr: "", code: 0, timedOut: false };
        return aws.run(h, command, o);
      },
    };
    const runner = createSandboxMigrationRunner({
      backends: { aws: awsWithBackup, sprites },
      routes,
      defaultBackend: "aws",
    });
    const res = await runner.migrateScope("personal:alice", "sprites", "canary", { force: true });
    assert.equal(res.resynced, true, "the test must actually exercise the resync write");
    assert.deepEqual((await routes.get("personal:alice"))?.capabilitiesLost, [
      "home backup (publish, resident-auth capture)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses a target that enforces less egress", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-egress-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const confined: Sandbox = { ...aws, profile: { ...aws.profile, egressEnforcement: "domain" } };
    const open: Sandbox = { ...sprites, profile: { ...sprites.profile, egressEnforcement: "none" } };
    const runner = createSandboxMigrationRunner({
      backends: { aws: confined, sprites: open },
      routes,
      defaultBackend: "aws",
    });
    await assert.rejects(runner.migrateScope("personal:alice", "sprites"), /egress enforcement/);
    await routes.put("personal:bob", { backend: "sprites" });
    writeFileSync(join(root, "sprites-home", "notes.txt"), "hello\n");
    const res = await runner.migrateScope("personal:bob", "aws");
    assert.deepEqual(res.capabilitiesLost, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope reports no loss when the substrates carry the same capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-caps-equal-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const runner = createSandboxMigrationRunner({ backends: { aws, sprites }, routes, defaultBackend: "aws" });
    const res = await runner.migrateScope("personal:alice", "sprites");
    assert.deepEqual(res.capabilitiesLost, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed copy leaves the route untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-fail-"));
  try {
    const { aws, sprites, routes } = build(root);
    writeFileSync(join(root, "aws-home", "notes.txt"), "hello\n");
    const corrupt: Sandbox = {
      ...sprites,
      async writeFileBytes(h, rel, data) {
        const bad = Buffer.from(data);
        bad[0] = bad[0]! ^ 0xff;
        return sprites.writeFileBytes(h, rel, bad);
      },
    };
    const runner = createSandboxMigrationRunner({ backends: { aws, sprites: corrupt }, routes, defaultBackend: "aws" });
    await assert.rejects(runner.migrateScope("personal:alice", "sprites"), /sha-mismatch|verify\/extract failed/);
    assert.equal(await routes.get("personal:alice"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
