import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfigEpochResolver,
  createSuperserveSandbox,
  SUPERSERVE_METADATA,
  type StoredConfigEpoch,
  type StoredSuperserveSandbox,
} from "../src/sandbox/superserve-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions, computerVerdict } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { setTimeout as delay } from "node:timers/promises";
import { scopeId } from "../src/types.ts";
import { shq } from "../src/util/shell.ts";
import { installFakeSuperserve, type FakeSuperserve } from "./support/fake-superserve.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeSuperserve;
let sandbox: Sandbox;
const workspaceRoots: string[] = [];

function newWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "superserve-ws-"));
  workspaceRoots.push(root);
  return createLocalWorkspaceStore(root);
}
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSuperserveSandbox(newWorkspace(), {
    client: fake.client,
    namePrefix: "qmt",
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeSuperserve();
  sandbox = make();
});
afterEach(() => {
  fake?.cleanup();
  for (const root of workspaceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("profile advertises resident disk, process sessions, and the template's toolchain", () => {
  assert.equal(sandbox.profile.backend, "superserve");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(supportsProcessSessions(sandbox), true);
  for (const tool of ["node", "gh", "aws", "claude", "codex"])
    assert.ok(sandbox.profile.spec?.tools?.includes(tool), tool);
  assert.ok(!sandbox.profile.spec?.notInstalled?.includes("gh"));
});

test("output is capped while the command runs, and the exit code survives", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "head -c 3000000 /dev/zero | tr '\\0' a; echo err-side >&2; exit 7");
  assert.equal(r.code, 7);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
  assert.match(r.stderr, /err-side/);
  assert.match(r.stderr, /truncated/);
  const small = await sandbox.run(h, "printf ok; printf bad >&2; exit 0");
  assert.equal(small.stdout, "ok");
  assert.equal(small.stderr, "bad");
  assert.doesNotMatch(small.stderr, /truncated/);
});

test("commands are run under a timeout that force-kills a process ignoring SIGTERM", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  assert.ok(fake.execScripts().some((s) => /\btimeout -k \d+ \d+ sh -c /.test(s)));
});

test("an immediate SIGKILL unrelated to the timeout deadline is not reported as timed out", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "kill -9 $$");
  assert.equal(r.code, 137);
  assert.equal(r.timedOut, false, "a self-kill that completes instantly cannot be timeout -k's own escalation");
});

test("a command force-killed by timeout -k's own SIGKILL escalation is reported as timed out", async () => {
  const h = await sandbox.provision(layers);
  fake.beforeNextRun(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  const r = await sandbox.run(h, "kill -9 $$", { timeoutMs: 1 });
  assert.equal(r.code, 137);
  assert.equal(r.timedOut, true, "an exit that takes at least the full deadline is timeout -k's own escalation");
});

test("provision creates one sandbox per scope with scope metadata and lifecycle knobs", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.ok(
    fake.execScripts().some((script) => script.includes("cd " + shq("/root/workspace").replace(/'/g, "'\\''"))),
    "workspace path quoted",
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);

  const record = fake.current(scopeName());
  assert.ok(record);
  assert.equal(record.metadata[SUPERSERVE_METADATA.scope], scopeName());
  assert.equal(record.metadata[SUPERSERVE_METADATA.prefix], "qmt");
  assert.equal(record.metadata[SUPERSERVE_METADATA.kind], "scope");
  assert.equal(record.timeoutSeconds, 15 * 60);
  assert.equal(record.autoDeleteSeconds, 30 * 24 * 3600);
});

test("the default HOME and workspace paths match the template", async () => {
  const h = await sandbox.provision(layers);
  assert.equal(h.homeDir, "/root");
  assert.equal(h.rootDir, "/root/workspace");
});

test("egress allow/deny lists are applied at create time", async () => {
  sandbox = make({ egressAllow: ["api.example.com", "*.github.com"], egressDeny: ["0.0.0.0/0"] });
  await sandbox.provision(layers);
  assert.deepEqual(fake.current(scopeName())?.network, {
    allowOut: ["api.example.com", "*.github.com"],
    denyOut: ["0.0.0.0/0"],
  });
});

test("a paused sandbox is resumed as-is when the egress policy is unchanged", async () => {
  sandbox = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  const again = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  await again.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("a paused sandbox under a different egress policy is destroyed and replaced, never resumed", async () => {
  const errors: string[] = [];
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "old.txt", "stale\n");
  await sandbox.teardown(h);
  fake.pause(scopeName());
  const oldId = fake.current(scopeName())!.id;

  const tightened = make({
    egressDeny: ["0.0.0.0/0"],
    egressAllow: ["api.example.com"],
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await tightened.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] });
  assert.equal(fake.calls().indexOf(`connect:${oldId}`, fake.calls().indexOf(`pause:${oldId}`)), -1, "never resumed");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_egress:policy_changed"]);
  assert.equal(await tightened.readFile(replaced, "old.txt"), null);
});

test("a paused sandbox that predates egress stamping keeps its disk when the policy still matches", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "resident.txt", "months of work\n");
  const record = fake.current(scopeName())!;
  const originalId = record.id;
  delete record.metadata[SUPERSERVE_METADATA.egress];
  await sandbox.teardown(h);
  fake.pause(scopeName());

  const upgraded = make({ store });
  const adopted = await upgraded.provision(layers);
  assert.equal(adopted.coldStart, false, "an unstamped sandbox is adopted, never destroyed");
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())!.id, originalId);
  assert.equal(await upgraded.readFile(adopted, "resident.txt"), "months of work\n");
  assert.ok(fake.current(scopeName())!.metadata[SUPERSERVE_METADATA.egress], "and it is stamped on adoption");
});

test("network reconciliation reads the actual policy independently of metadata", async () => {
  sandbox = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  const record = fake.current(scopeName())!;
  const stampedId = record.id;
  const stamp = record.metadata[SUPERSERVE_METADATA.egress];
  record.network = { allowOut: ["evil.example.com"], denyOut: [] };
  fake.pause(scopeName());

  const again = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  await again.provision(layers);
  assert.equal(
    fake.current(scopeName())!.metadata[SUPERSERVE_METADATA.egress],
    stamp,
    "the stamp still claimed a match",
  );
  assert.notEqual(fake.current(scopeName())!.id, stampedId, "but drifted network state is caught anyway");
  assert.ok(fake.calls().includes(`kill:${stampedId}`));
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] });
});

test("a paused sandbox keeps its disk when its policy can be updated without resuming", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  fake.acceptNetworkUpdateWhilePaused();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "resident.txt", "months of work\n");
  await sandbox.teardown(h);
  fake.pause(scopeName());
  const keptId = fake.current(scopeName())!.id;

  const tightened = make({ store, egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  const adopted = await tightened.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1, "a routine policy change never destroys the disk");
  assert.equal(fake.current(scopeName())!.id, keptId);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] });
  assert.equal(await tightened.readFile(adopted, "resident.txt"), "months of work\n");
  const calls = fake.calls();
  assert.ok(
    calls.lastIndexOf(`update:${keptId}`) < calls.lastIndexOf(`connect:${keptId}`),
    "the policy lands before the sandbox is resumed",
  );
});

test("an unapplied policy update prevents resuming the sandbox under the old policy", async () => {
  fake.ignoreNetworkUpdateWhilePaused();
  const errors: string[] = [];
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.pause(scopeName());
  const oldId = fake.current(scopeName())!.id;

  const tightened = make({
    egressDeny: ["0.0.0.0/0"],
    egressAllow: ["api.example.com"],
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  await tightened.provision(layers);
  assert.notEqual(fake.current(scopeName())!.id, oldId, "an unverified policy is never trusted");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.equal(fake.calls().indexOf(`connect:${oldId}`, fake.calls().indexOf(`pause:${oldId}`)), -1, "never resumed");
  assert.deepEqual(errors, ["sandbox_egress:policy_changed"]);
});

test("a cached sandbox whose network drifted is reconciled before the next command", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store, egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  const h = await sandbox.provision(layers);
  const id = fake.current(scopeName())!.id;
  fake.current(scopeName())!.network = { allowOut: ["evil.example.com"], denyOut: [] };

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, false, "the cached sandbox is reused");
  assert.equal(fake.current(scopeName())!.id, id);
  assert.deepEqual(
    fake.current(scopeName())?.network,
    { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] },
    "drift on a cached session is repaired rather than trusted",
  );
  assert.equal((await sandbox.run(h, "echo ok")).stdout.trim(), "ok");
});

test("a cached scratch sandbox whose network drifted is replaced", async () => {
  sandbox = make({ egressDeny: ["0.0.0.0/0"] });
  const first = await sandbox.provision(layers, { scratch: { key: "job" } });
  const firstId = fake.current(first.id)!.id;
  fake.current(first.id)!.network = { allowOut: ["evil.example.com"], denyOut: [] };

  const second = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(second.coldStart, true);
  assert.notEqual(fake.current(first.id)!.id, firstId);
  assert.deepEqual(fake.current(first.id)?.network, { denyOut: ["0.0.0.0/0"] });
  assert.ok(fake.calls().includes(`kill:${firstId}`));
});

test("an active sandbox gets a changed egress policy applied before its first command", async () => {
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  const id = fake.current(scopeName())!.id;

  const tightened = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.example.com"] });
  await tightened.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] });
  const calls = fake.calls();
  const connectAt = calls.lastIndexOf(`connect:${id}`);
  const policyAt = calls.lastIndexOf(`update:${id}`, connectAt);
  const firstRunAt = calls.indexOf(`run:${id}`, connectAt);
  assert.ok(
    policyAt >= 0 && policyAt < connectAt && connectAt < firstRunAt,
    "policy applied before activation and the first command",
  );
  const meta = fake.current(scopeName())!.metadata;
  assert.equal(meta[SUPERSERVE_METADATA.scope], scopeName());
  assert.equal(meta[SUPERSERVE_METADATA.kind], "scope");
  assert.ok(meta[SUPERSERVE_METADATA.egress]);

  const relaxed = make({ idlePauseSec: 120, retentionSec: 3600 });
  const relaxedHandle = await relaxed.provision(layers);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: [], denyOut: [] });
  assert.equal(fake.current(scopeName())?.autoDeleteSeconds, 3600);
  await relaxed.teardown(relaxedHandle);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 120, "a shorter idle pause lands at the next plain teardown");
});

test("computerStatus observing a deleted sandbox clears cached state so the next provision replaces it", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  await sandbox.provision(layers);
  fake.expire(scopeName());
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, false);
  assert.equal(await store.get(scope), null);
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("template and prefix flow through to creation", async () => {
  sandbox = make({ template: "qm-agent-1.2.3" });
  await sandbox.provision(layers);
  assert.equal(fake.current(scopeName())?.template, "qm-agent-1.2.3");
});

test("an already-aborted signal never executes a command", async () => {
  const handle = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  await assert.rejects(sandbox.run(handle, "echo must-not-run", { signal: AbortSignal.abort() }), /aborted/i);
  assert.equal(fake.execScripts().length, before);
});

test("streams and exit codes are exact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
});

test("file roundtrip incl. large binary and missing file", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  const seen = await sandbox.run(h, "wc -c < big.bin");
  assert.equal(seen.stdout.trim(), String(big.length));
});

test("importFiles, listDir and removeDir work through exec", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.importFiles!(h, [
    { path: "dir/one.txt", data: Buffer.from("1") },
    { path: "dir/two.txt", data: Buffer.from("2") },
  ]);
  const listed = await sandbox.listDir(h, "dir");
  assert.deepEqual(listed.sort(), ["dir/one.txt", "dir/two.txt"]);
  await sandbox.removeDir(h, "dir");
  assert.equal(await sandbox.readFile(h, "dir/one.txt"), null);
});

test("provisioning the same scope twice reuses the sandbox", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("concurrent cores serialize read-only layer preparation", async () => {
  const workspace = newWorkspace();
  const shared = scopeId("org", "shared");
  await workspace.write(shared, "policy.txt", "current");
  const layered = [...layers, { scopeId: shared, mountPath: "global", mode: "ro" as const }];
  const advisoryLock = createMemoryAdvisoryLock();
  let writes = 0;
  let overlappingWrites = false;
  const wrap = (session: Awaited<ReturnType<typeof fake.client.create>>) => ({
    ...session,
    async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
      if (!path.endsWith(".ro-layers.tar")) return session.writeFileBytes(path, data);
      overlappingWrites ||= writes > 0;
      writes += 1;
      try {
        await session.writeFileBytes(path, data);
        await delay(100);
      } finally {
        writes -= 1;
      }
    },
  });
  const client = {
    ...fake.client,
    create: async (...args: Parameters<typeof fake.client.create>) => wrap(await fake.client.create(...args)),
    connect: async (...args: Parameters<typeof fake.client.connect>) => wrap(await fake.client.connect(...args)),
  };
  const first = createSuperserveSandbox(workspace, { client, advisoryLock, configEpoch: 1 });
  const second = createSuperserveSandbox(workspace, { client, advisoryLock, configEpoch: 1 });
  const results = await Promise.allSettled([first.provision(layered), second.provision(layered)]);
  assert.equal(overlappingWrites, false, "each core owns the shared archive until extraction finishes");
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
});

test("an older core leaves newer read-only layers intact", async () => {
  const olderWorkspace = newWorkspace();
  const newerWorkspace = newWorkspace();
  const shared = scopeId("org", "shared");
  await olderWorkspace.write(shared, "policy.txt", "old");
  await newerWorkspace.write(shared, "policy.txt", "new");
  const layered = [...layers, { scopeId: shared, mountPath: "global", mode: "ro" as const }];
  const advisoryLock = createMemoryAdvisoryLock();
  const older = createSuperserveSandbox(olderWorkspace, { client: fake.client, advisoryLock, configEpoch: 1 });
  const newer = createSuperserveSandbox(newerWorkspace, { client: fake.client, advisoryLock, configEpoch: 2 });
  await older.provision(layered);
  const upgraded = await newer.provision(layered);
  const held = await older.provision(layered);
  assert.equal(await newer.readFile(upgraded, "global/policy.txt"), "new");
  assert.equal((await older.run(held, "cat global/policy.txt")).stdout, "new");
});

test("teardown preserves the sandbox until automatic pause; resume preserves its disk", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  await sandbox.teardown(h);
  assert.equal(fake.current(scopeName())?.status, "active");
  assert.ok(!fake.calls().some((c) => c.startsWith("pause:")));

  fake.pause(scopeName());
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await sandbox.readFile(again, "keep.txt"), "still here\n");
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("a sandbox built from an older template is replaced on adoption", async () => {
  const errors: string[] = [];
  sandbox = make({ template: "qm-agent-1.0.0" });
  const h = await sandbox.provision(layers);
  const oldId = fake.current(scopeName())!.id;
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.0.0");
  await sandbox.teardown(h);

  const upgraded = make({
    template: "qm-agent-1.1.0",
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await upgraded.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_template:template_changed"]);

  const same = make({ template: "qm-agent-1.1.0" });
  const again = await same.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("an older core never reverts a sandbox a newer core already reconfigured", async () => {
  const older = make({ template: "qm-agent-1.0.0", configEpoch: 1_000, idlePauseSec: 600, retentionSec: 3_600 });
  const first = await older.provision(layers);
  await older.teardown(first);

  const newer = make({
    template: "qm-agent-1.1.0",
    configEpoch: 2_000,
    egressDeny: ["0.0.0.0/0"],
    idlePauseSec: 1_200,
    retentionSec: 7_200,
  });
  await newer.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2);
  const upgradedId = fake.current(scopeName())!.id;

  const olderAgain = make({ template: "qm-agent-1.0.0", configEpoch: 1_000, idlePauseSec: 600, retentionSec: 3_600 });
  const h = await olderAgain.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2, "no third sandbox");
  const record = fake.current(scopeName())!;
  assert.equal(record.id, upgradedId);
  assert.equal(record.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.equal(record.metadata[SUPERSERVE_METADATA.epoch], "2000");
  assert.deepEqual(record.network, { denyOut: ["0.0.0.0/0"] });
  assert.equal(record.timeoutSeconds, 1_200, "older core leaves the newer idle pause alone");
  assert.equal(record.autoDeleteSeconds, 7_200, "older core leaves the newer retention alone");
  assert.equal((await olderAgain.run(h, "echo ok")).stdout.trim(), "ok");
  await olderAgain.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_200, "older core's teardown does not touch the timeout");
});

test("an older core with a cached session stops configuring once a newer core takes over", async () => {
  const older = make({ configEpoch: 1_000, idlePauseSec: 600 });
  const h = await older.provision(layers);
  await older.teardown(h);

  const newer = make({ configEpoch: 2_000, idlePauseSec: 1_800 });
  await newer.teardown(await newer.provision(layers));
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800);

  const again = await older.provision(layers);
  assert.equal(again.coldStart, false);
  await older.teardown(again);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800, "cached older core no longer rewrites the timeout");
});

test("a core without a durable generation never outranks one that has one", async () => {
  const durable = make({ configEpoch: 3, idlePauseSec: 1_800, template: "qm-agent-1.1.0" });
  await durable.teardown(await durable.provision(layers));
  const stamped = fake.current(scopeName())!.id;

  const ephemeral = make({ configEpoch: 0, idlePauseSec: 600, template: "qm-agent-1.0.0" });
  const h = await ephemeral.provision(layers);
  await ephemeral.teardown(h, { keepWarm: true });

  assert.equal(fake.current(scopeName())?.id, stamped, "it never destroys the durable core's sandbox");
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800, "and never rewrites its lifecycle");
});

test("an older core never reinstalls deployment tools over a newer generation's", async () => {
  let reconciles = 0;
  const toolFiles = (): { to: string; mode: string; content: string }[] => {
    reconciles += 1;
    return [];
  };
  const older = make({ configEpoch: 1_000, layerToolFiles: toolFiles });
  await older.teardown(await older.provision(layers));
  const reconciledByOwner = reconciles;
  assert.ok(reconciledByOwner > 0, "the owning generation reconciles its guest tools");

  const newer = make({ configEpoch: 2_000 });
  await newer.teardown(await newer.provision(layers));

  await older.provision(layers);
  assert.equal(reconciles, reconciledByOwner, "the older generation leaves the newer one's guest tools alone");
});

test("a teardown rechecks the sandbox's stamp before it rewrites the lifecycle timeout", async () => {
  const older = make({ configEpoch: 1_000, idlePauseSec: 600 });
  const held = await older.provision(layers);

  const newer = make({ configEpoch: 2_000, idlePauseSec: 1_800 });
  await newer.teardown(await newer.provision(layers));
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800);

  await older.teardown(held, { keepWarm: true });
  assert.equal(
    fake.current(scopeName())?.timeoutSeconds,
    1_800,
    "a handle provisioned before the newer core took over no longer rewrites the timeout",
  );
});

test("a newer core stamps its epoch even when only lifecycle settings changed", async () => {
  const older = make({ configEpoch: 1_000, idlePauseSec: 600 });
  await older.teardown(await older.provision(layers));
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], "1000");

  const newer = make({ configEpoch: 2_000, idlePauseSec: 900, retentionSec: 7_200 });
  await newer.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], "2000");
  assert.equal(fake.current(scopeName())?.autoDeleteSeconds, 7_200);

  const olderAgain = make({ configEpoch: 1_000, idlePauseSec: 600, retentionSec: 3_600 });
  await olderAgain.teardown(await olderAgain.provision(layers));
  assert.equal(fake.current(scopeName())?.autoDeleteSeconds, 7_200);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 900);
});

test("the config epoch is claimed once per deployment generation, so a restarted core cannot outrank a newer one", async () => {
  const epochs: DurableMap<StoredConfigEpoch> = createMemoryMap();
  const claimed = await createConfigEpochResolver(epochs, "release-1")();
  assert.equal(claimed, 1);
  assert.equal(await createConfigEpochResolver(epochs, "release-1")(), claimed, "a restart reuses its own generation");
  const newRelease = await createConfigEpochResolver(epochs, "release-2")();
  assert.equal(newRelease, claimed + 1, "each new generation is strictly higher than every generation before it");
  assert.equal(await createConfigEpochResolver(epochs, "release-1")(), claimed, "a restart still ranks below it");

  const older = make({ configEpoch: createConfigEpochResolver(epochs, "release-1"), idlePauseSec: 600 });
  await older.teardown(await older.provision(layers));
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], String(claimed));

  const newer = make({ configEpoch: createConfigEpochResolver(epochs, "release-2"), idlePauseSec: 1_800 });
  await newer.teardown(await newer.provision(layers));
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800);

  const restarted = make({ configEpoch: createConfigEpochResolver(epochs, "release-1"), idlePauseSec: 600 });
  await restarted.teardown(await restarted.provision(layers));
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 1_800, "the restarted older release stays passive");
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], String(newRelease));
});

test("a command that finds its sandbox gone leaves a replacement provisioned meanwhile in place", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  const lostId = fake.current(scopeName())!.id;
  fake.beforeNextRun(async () => {
    fake.expire(scopeName());
    await sandbox.provision(layers);
  });
  await assert.rejects(sandbox.run(h, "echo back"), /is gone/);
  const replacement = fake.current(scopeName())!;
  assert.notEqual(replacement.id, lostId);
  assert.equal((await store.get(scope))?.sandboxId, replacement.id);
  await assert.rejects(
    sandbox.run(h, "echo again"),
    /provision it again/,
    "the old handle never adopts the replacement",
  );
  const fresh = await sandbox.provision(layers);
  assert.equal(fresh.coldStart, false, "the replacement is still cached for the next provision");
  assert.equal(fake.current(scopeName())!.id, replacement.id);
  assert.equal((await sandbox.run(fresh, "echo again")).stdout.trim(), "again");
});

test("a handle never runs against a replacement another turn is still provisioning", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const held = await sandbox.provision(layers);
  const lostId = fake.current(scopeName())!.id;
  fake.expire(scopeName());

  let duringPrep: unknown;
  fake.beforeNextRun(async () => {
    duringPrep = await sandbox.run(held, "pwd").catch((e: unknown) => e);
  });
  const replaced = await sandbox.provision(layers);

  assert.notEqual(fake.current(scopeName())!.id, lostId);
  assert.ok(duringPrep instanceof Error, "the stale handle is rejected instead of running in an unprepared sandbox");
  assert.match((duringPrep as Error).message, /provision it again/);
  assert.match((await sandbox.run(replaced, "pwd")).stdout.trim(), /\/workspace$/, "the fresh handle is prepared");
  const idleBefore = fake.current(scopeName())?.timeoutSeconds;
  await sandbox.teardown(held, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, idleBefore, "a stale teardown leaves the replacement alone");
});

test("a sandbox that disappears while checking ownership fails provisioning instead of returning a handle to it", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store, layerToolFiles: () => [] });
  const first = await sandbox.provision(layers);
  const lostId = fake.current(scopeName())!.id;
  assert.equal((await sandbox.run(first, "echo ok")).stdout.trim(), "ok");

  fake.beforeNextInfo(async () => {
    fake.beforeNextInfo(async () => {
      fake.expire(scopeName());
    });
  });
  await assert.rejects(sandbox.provision(layers), /is gone/);

  assert.equal(await store.get(scope), null, "the durable record for the gone sandbox is cleared");
  const fresh = await sandbox.provision(layers);
  assert.equal(
    fresh.coldStart,
    true,
    "the next provision creates a genuine replacement rather than reusing the gone id",
  );
  assert.notEqual(fake.current(scopeName())!.id, lostId);
});

test("a gone sandbox never forgets a replacement another instance already recorded", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  const oldId = fake.current(scopeName())!.id;
  fake.expire(scopeName());
  const other = make({ store });
  const replacement = await other.provision(layers);
  assert.equal(replacement.coldStart, true);
  const newId = (await store.get(scope))!.sandboxId;
  assert.notEqual(newId, oldId);

  await assert.rejects(sandbox.run(h, "echo x"), /is gone/);
  assert.equal((await store.get(scope))?.sandboxId, newId, "the replacement's record survives");
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, true);
});

test("reconnecting keeps a longer keep-warm timeout until a plain teardown restores it", async () => {
  sandbox = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400);

  const other = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  await other.computerStatus!(scope);
  const probed = await other.provision(layers);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400, "another instance's probe keeps the warm window");
  await other.teardown(probed);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
});

test("keepWarm teardown extends the active-time limit; a plain teardown restores it", async () => {
  sandbox = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  const h = await sandbox.provision(layers);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400);
  assert.equal(fake.current(scopeName())?.status, "active");
  await sandbox.teardown(h);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
});

test("a concurrent handle keeps working after another handle's teardown", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  await sandbox.teardown(a);
  const r = await sandbox.run(b, "echo still-running");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /still-running/);
});

test("a fresh core with an empty store rediscovers the sandbox by scope metadata", async () => {
  const first = await sandbox.provision(layers);
  await sandbox.writeFile(first, "state.txt", "from before\n");
  await sandbox.teardown(first);

  const restarted = make();
  const h = await restarted.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await restarted.readFile(h, "state.txt"), "from before\n");
});

test("a durable store lets a restarted core reconnect without listing", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const first = await sandbox.provision(layers);
  await sandbox.teardown(first);
  const stored = await store.get(scope);
  assert.ok(stored);

  const restarted = make({ store });
  const before = fake.calls().filter((c) => c.startsWith("create:")).length;
  const h = await restarted.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.calls().filter((c) => c.startsWith("create:")).length, before);
  assert.ok(fake.calls().includes(`connect:${stored.sandboxId}`));
});

test("a sandbox that disappeared is replaced on the next provision", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.expire(scopeName());

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.notEqual((await store.get(scope))?.sandboxId, undefined);
});

test("a sandbox lost mid-session fails the command and is replaced by the next provision", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  fake.expire(scopeName());
  await assert.rejects(sandbox.run(h, "echo back"), /is gone/);
  await assert.rejects(sandbox.run(h, "echo again"), /provision it again/);
  await assert.rejects(sandbox.readFile(h, "x.txt"), /provision it again/);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await store.get(scope), null);

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal((await sandbox.run(again, "echo back")).stdout.trim(), "back");
});

test("destroyScope surfaces a failed listing instead of forgetting the scope", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  await sandbox.provision(layers);
  fake.failNextList(new Error("superserve unavailable"));
  await assert.rejects(sandbox.destroyScope!(scope), /unavailable/);
  assert.ok(await store.get(scope), "record survives so retirement can be retried");
  assert.ok(fake.current(scopeName()), "sandbox untouched");
  await sandbox.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
});

test("destroy teardown and destroyScope kill the sandbox and forget the scope", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);

  const h2 = await sandbox.provision(layers);
  assert.equal(h2.coldStart, true);
  await sandbox.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);
});

test("destroyScope also removes sandboxes only findable by metadata", async () => {
  await sandbox.provision(layers);
  const orphanOwner = make();
  await orphanOwner.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
});

test("computerStatus reports paused, running, and gone", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  assert.equal(computerVerdict(await sandbox.computerStatus!(scope)), "down");

  const h = await sandbox.provision(layers);
  const running = await sandbox.computerStatus!(scope);
  assert.equal(running.guestResponsive, true);
  assert.equal(running.lifecycleState, "running");
  assert.equal(computerVerdict(running), "ok");

  await sandbox.teardown(h);
  fake.pause(scopeName());
  const paused = await sandbox.computerStatus!(scope);
  assert.equal(paused.lifecycleState, "paused");
  assert.equal(paused.recovery?.strategy, "provider_pause");
  assert.equal(computerVerdict(paused), "ok");

  fake.expire(scopeName());
  const gone = await sandbox.computerStatus!(scope);
  assert.equal(gone.provisioned, false);
  assert.equal(computerVerdict(gone), "down");
});

test("computerStatus reports the sandbox it actually probed after a replacement", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store, template: "qm-agent-1.0.0" });
  await sandbox.provision(layers);
  const firstId = fake.current(scopeName())!.id;

  const upgraded = make({ store, template: "qm-agent-1.1.0" });
  const status = await upgraded.computerStatus!(scope);
  const replacementId = fake.current(scopeName())!.id;

  assert.notEqual(replacementId, firstId);
  assert.match(status.machine, new RegExp(replacementId));
  assert.doesNotMatch(status.machine, new RegExp(firstId), "never reports the sandbox it replaced as responsive");
});

test("scratch sandboxes are separate, shared while active, and killed on last teardown", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(a.id, b.id);
  assert.equal(a.scratch, true);
  assert.equal(b.coldStart, false);
  const scratchName = a.id;
  assert.equal(fake.current(scratchName)?.metadata[SUPERSERVE_METADATA.kind], "scratch");
  assert.equal(fake.current(scratchName)?.autoDeleteSeconds, 24 * 3600);

  await sandbox.teardown(a);
  assert.ok(fake.current(scratchName), "still alive while another user holds it");
  await sandbox.teardown(b);
  assert.equal(fake.current(scratchName), null);
  assert.equal(fake.current(scopeName()), null, "scratch never touches the scope sandbox");
});

test("destroying a scratch sandbox surfaces a failed kill instead of reporting success", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "creds" } });
  fake.failNextKill(new Error("superserve unavailable"));
  await assert.rejects(sandbox.teardown(h, { destroy: true }), /unavailable/);
  assert.notEqual(fake.current(h.id), null, "the credential-bearing sandbox is still there to retry");
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.current(h.id), null);
});

test("a best-effort scratch teardown still tolerates a failed kill", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job" } });
  fake.failNextKill(new Error("superserve unavailable"));
  await sandbox.teardown(h);
});

test("the last scratch handle to close kills the replacement even when it was provisioned earlier", async () => {
  const first = await sandbox.provision(layers, { scratch: { key: "k1" } });
  fake.expire(first.id);
  const replacement = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(replacement.coldStart, true, "a deleted scratch sandbox is recreated on the next provision");
  assert.notEqual(fake.current(first.id), null);

  await sandbox.teardown(replacement);
  assert.notEqual(fake.current(first.id), null, "still referenced by the older handle");
  await sandbox.teardown(first);
  assert.equal(fake.current(first.id), null, "the replacement is killed once nothing references it");
});

test("a scratch sandbox lost while handles are active is recreated for the next scratch provision", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "job" } });
  const scratchName = a.id;
  fake.expire(scratchName);
  await assert.rejects(sandbox.run(a, "echo x"), /is gone/);
  const b = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(b.coldStart, true);
  assert.equal(fake.createdCount(scratchName), 2);
  assert.equal((await sandbox.run(b, "echo back")).stdout.trim(), "back");
});

test("process sessions run in the background and can be read back", async () => {
  const h = await sandbox.provision(layers);
  assert.ok(supportsProcessSessions(sandbox));
  const { processId } = await sandbox.startProcess(h, "echo started; sleep 0.2; echo finished");
  let out = "";
  for (let i = 0; i < 40; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: 0 });
    out = r.chunks;
    if (r.status.state === "exited") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(out, /started/);
  assert.match(out, /finished/);
  const listed = await sandbox.listProcesses(h);
  assert.ok(listed.some((p) => p.processId === processId));
});

test("no access token or key ever appears in exec scripts", async () => {
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  for (const script of fake.execScripts()) {
    assert.doesNotMatch(script, /ss_live_|X-Access-Token|access_token/);
  }
});

test("a sandbox is not cached when its durable record cannot be written", async () => {
  const inner: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  let failPuts = 1;
  const store: DurableMap<StoredSuperserveSandbox> = {
    ...inner,
    put: async (key, value) => {
      if (failPuts-- > 0) throw new Error("persistence unavailable");
      return inner.put(key, value);
    },
  };
  sandbox = make({ store });
  await assert.rejects(sandbox.provision(layers), /persistence unavailable/);
  const h = await sandbox.provision(layers);
  assert.ok(await inner.get(scope), "record written on the retry");
  assert.equal((await inner.get(scope))?.sandboxId, fake.current(scopeName())?.id);
  assert.equal((await sandbox.run(h, "echo ok")).stdout.trim(), "ok");
});

test("run refuses to execute when its workspace directory is missing", async () => {
  const handle = await sandbox.provision(layers);
  rmSync(join(fake.homeDir(scopeName()), "workspace"), { recursive: true });
  const result = await sandbox.run(handle, "echo should-not-run");
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
});
