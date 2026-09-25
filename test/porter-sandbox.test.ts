import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPorterSandbox, porterScopeSlug, type StoredPorterScope } from "../src/sandbox/porter-sandbox.ts";
import { withPorterErrorDetail } from "../src/sandbox/porter-client.ts";
import { SandboxError } from "porter-sandbox";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { installFakePorter, type FakePorter } from "./support/fake-porter.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakePorter;
let sandbox: Sandbox;
let store: DurableMap<StoredPorterScope>;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const slug = porterScopeSlug("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createPorterSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "porter-ws-"))), {
    namePrefix: "qmt",
    client: fake.client,
    store,
    ...extra,
  });
}

const running = () => fake.bodies().filter((b) => b.phase === "running");

beforeEach(() => {
  fake = installFakePorter();
  store = createMemoryMap<StoredPorterScope>();
  sandbox = make();
});
after(() => fake?.cleanup());

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);
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
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  const huge = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < huge.length; i++) huge[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "huge.bin", huge);
  const hugeBack = await sandbox.readFileBytes(h, "huge.bin");
  assert.ok(hugeBack && Buffer.from(hugeBack).equals(huge));
});

test("files under the home volume move through the volume file API, not base64 exec chunks", async () => {
  const h = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  await sandbox.writeFile(h, "notes.txt", "via volume\n");
  assert.equal(await sandbox.readFile(h, "notes.txt"), "via volume\n");
  assert.equal(await sandbox.readFile(h, "missing.txt"), null);
  assert.ok(fake.volumeFileCalls() >= 3);
  assert.equal(
    fake
      .execScripts()
      .slice(before)
      .filter((s) => s.includes("base64")).length,
    0,
  );
  assert.equal((await sandbox.run(h, "cat notes.txt")).stdout, "via volume\n");
});

test("reads larger than one ranged request are paged back whole", async () => {
  const h = await sandbox.provision(layers);
  const size = 9 * 1024 * 1024 + 17;
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) data[i] = (i / 4096) % 256;
  data[size - 1] = 0x5a;
  await sandbox.writeFileBytes(h, "paged.bin", data);
  const back = await sandbox.readFileBytes(h, "paged.bin");
  assert.ok(back && Buffer.from(back).equals(data));
  await sandbox.writeFileBytes(h, "empty.bin", Buffer.alloc(0));
  assert.equal((await sandbox.readFileBytes(h, "empty.bin"))?.length, 0);
});

test("a cluster without the volume files mount falls back to exec once and stops asking", async () => {
  fake = installFakePorter({ filesApi: "unavailable" });
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "fallback.txt", "exec path\n");
  assert.equal(await sandbox.readFile(h, "fallback.txt"), "exec path\n");
  assert.equal(await sandbox.readFile(h, "missing.txt"), null);
  assert.equal(fake.volumeFileCalls(), 1);
  assert.ok(fake.execScripts().some((s) => s.includes("base64")));
});

test("a volume request that times out falls back to exec but is tried again next time", async () => {
  fake = installFakePorter({ filesApi: "timeout" });
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "slow.txt", "still lands\n");
  assert.equal(await sandbox.readFile(h, "slow.txt"), "still lands\n");
  assert.equal(fake.volumeFileCalls(), 2);
});

test("import and export archives travel over the volume and the export scratch dir stays out of the export", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.importFiles!(h, [{ path: "src/x.txt", data: Buffer.from("imported") }]);
  assert.equal(await sandbox.readFile(h, "src/x.txt"), "imported");
  await sandbox.run(h, "echo home-file > ~/.profile-note");
  const before = fake.execScripts().length;
  const entries = await sandbox.exportFiles!(h);
  const paths = entries.map((e) => `${e.area}:${e.path}`);
  assert.ok(paths.includes("workspace:src/x.txt"));
  assert.ok(paths.includes("home:.profile-note"));
  assert.ok(paths.every((p) => !p.includes(".qm-export")));
  assert.equal(
    fake
      .execScripts()
      .slice(before)
      .filter((s) => s.includes("base64")).length,
    0,
  );
});

test("volume survives body replacement and coldStart stays false", async () => {
  const h1 = await sandbox.provision(layers);
  assert.equal(h1.coldStart, true);
  await sandbox.writeFile(h1, "kept.txt", "still here\n");
  fake.terminateAll();
  const fresh = make();
  const h2 = await fresh.provision(layers);
  assert.equal(h2.coldStart, false);
  assert.notEqual(h2.id, h1.id);
  assert.equal(await fresh.readFile(h2, "kept.txt"), "still here\n");
});

test("a fresh core finds the live body through the volume's attachments without a tag scan", async () => {
  const h1 = await sandbox.provision(layers);
  const fresh = make();
  const lists = fake.listCalls();
  const h2 = await fresh.provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.listCalls(), lists);
});

test("body names resolve to ids once and are cached for later execs", async () => {
  const h = await sandbox.provision(layers);
  const other = make();
  const lookups = fake.nameLookups();
  await other.run(h, "true");
  await other.run(h, "true");
  await other.writeFile(h, "cached.txt", "x");
  assert.equal(fake.nameLookups(), lookups + 1);
});

test("egress proxy mode pins allowlist and injects proxy env; the pin is sticky", async () => {
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const h = await proxied.provision(layers, { egressToken: "tok-1" });
  assert.match(h.env?.HTTPS_PROXY ?? "", /x:tok-1@egress\.qm\.internal/);
  const withEgress = running().filter((b) => b.tags["qm-scope"] === slug);
  assert.equal(withEgress.length, 1);
  assert.deepEqual(withEgress[0]!.egress, ["egress.qm.internal"]);
  assert.equal(withEgress[0]!.tags["qm-egress"], "proxy");
  const h2 = await proxied.provision(layers);
  assert.equal(h2.id, h.id);
  assert.equal(h2.env, undefined);
  const still = running().filter((b) => b.tags["qm-scope"] === slug);
  assert.equal(still.length, 1);
  assert.equal(still[0]!.tags["qm-egress"], "proxy");
});

test("a tokened turn on an open body rotates it into the proxy pin and carries files outside $HOME along", async () => {
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const h = await proxied.provision(layers);
  assert.equal(h.env, undefined);
  await proxied.run(h, "mkdir -p /app && echo tool > /app/installed");
  await proxied.teardown(h);
  const open = running().filter((b) => b.tags["qm-scope"] === slug);
  assert.equal(open[0]!.tags["qm-egress"], "open");
  const h2 = await proxied.provision(layers, { egressToken: "tok-2" });
  assert.notEqual(h2.id, h.id);
  assert.match(h2.env?.HTTPS_PROXY ?? "", /x:tok-2@egress\.qm\.internal/);
  const pinned = running().filter((b) => b.tags["qm-scope"] === slug);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.tags["qm-egress"], "proxy");
  assert.equal((await proxied.run(h2, "cat /app/installed")).stdout.trim(), "tool");
});

test("process sessions capability works end to end", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one/);
  assert.match(output, /two/);
});

test("scratch bodies are isolated, refcounted, and removed on release", async () => {
  const h1 = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const h2 = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(h1.id, h2.id);
  await sandbox.writeFile(h1, "s.txt", "scratch\n");
  await sandbox.teardown(h1);
  assert.equal(await sandbox.readFile(h2, "s.txt"), "scratch\n");
  await sandbox.teardown(h2);
  assert.equal(running().length, 0);
  assert.equal(fake.volumeFileCalls(), 0);
});

test("abort signal kills an in-flight exec", async () => {
  const h = await sandbox.provision(layers);
  const ac = new AbortController();
  const started = Date.now();
  const p = sandbox.run(h, "sleep 30; echo done", { timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const r = await p;
  assert.ok(Date.now() - started < 15_000);
  assert.notEqual(r.code, 0);
});

test("destroy terminates the body and deletes the volume, the snapshot and the scope record", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.snapshots().length, 1);
  await sandbox.teardown(h, { destroy: true });
  assert.equal(running().length, 0);
  assert.equal(fake.volumeNames().length, 0);
  assert.equal(fake.snapshots().length, 0);
  assert.equal(await store.get(scope), null);
});

test("computerStatus reports the live body, its lifetime cap, and probes the guest", async () => {
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "no computer", guestResponsive: false });
  await sandbox.provision(layers);
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.machine, "running");
  assert.equal(s.guestResponsive, true);
  assert.ok(s.expiresAtMs! > Date.now() + 7 * 3600_000 && s.expiresAtMs! <= Date.now() + 8 * 3600_000 + 1000);
  assert.equal(s.recovery, undefined);
});

test("computerStatus surfaces the failed body's last log lines", async () => {
  const h = await sandbox.provision(layers);
  fake.fail(h.id, 137, ["apt-get: killed", "OOMKilled"]);
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.machine, "failed");
  assert.equal(s.guestResponsive, false);
  assert.match(s.probeError ?? "", /OOMKilled/);
});

test("restartComputer snapshots the body first so files outside $HOME survive, and keeps the home volume", async () => {
  const h1 = await sandbox.provision(layers);
  await sandbox.writeFile(h1, "keep.txt", "survives restart");
  await sandbox.run(h1, "mkdir -p /app && echo built > /app/artifact");
  await sandbox.teardown(h1);
  const before = running()[0]!.name;
  await sandbox.restartComputer!(scope);
  const bodies = fake.bodies();
  assert.equal(bodies.filter((b) => b.phase === "running").length, 1);
  const replacement = bodies.find((b) => b.phase === "running")!;
  assert.notEqual(replacement.name, before);
  assert.equal(bodies.find((b) => b.name === before)?.phase, "terminated");
  assert.equal(replacement.image, "");
  assert.equal(replacement.snapshotId, fake.snapshots()[0]!.id);
  const h2 = await sandbox.provision(layers);
  assert.equal(h2.coldStart, false);
  assert.equal(await sandbox.readFile(h2, "keep.txt"), "survives restart");
  assert.equal((await sandbox.run(h2, "cat /app/artifact")).stdout.trim(), "built");
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.machine, "running");
  assert.equal(s.guestResponsive, true);
  assert.equal(s.recovery?.strategy, "provider_snapshot");
  assert.equal(s.recovery?.checkpointId, replacement.snapshotId);
  assert.equal(s.recovery?.checkpointExpiresAtMs, null);
});

test("a body that is unchanged since its last snapshot is not snapshotted again", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  await sandbox.restartComputer!(scope);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.snapshots().length, 1);
  const h2 = await sandbox.provision(layers);
  await sandbox.teardown(h2);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.snapshots().length, 1);
  assert.equal((await store.get(scope))?.snapshotId, fake.snapshots()[0]!.id);
});

test("a snapshot that no longer exists is forgotten and the body comes from the image", async () => {
  const errors: string[] = [];
  const observed = make({ onError: (e: { code: string }) => errors.push(e.code) });
  const h = await observed.provision(layers);
  await observed.teardown(h);
  await observed.restartComputer!(scope);
  const snapshotId = (await store.get(scope))!.snapshotId!;
  await fake.client.snapshots.delete(snapshotId);
  fake.terminateAll();
  const h2 = await observed.provision(layers);
  assert.equal(h2.coldStart, false);
  const body = fake.bodies().find((b) => b.name === h2.id)!;
  assert.equal(body.image, "ghcr.io/porter-dev/qm-sandbox:latest");
  assert.equal(body.snapshotId, undefined);
  assert.deepEqual(errors, ["porter_snapshot_unusable"]);
  assert.equal((await store.get(scope))?.snapshotId, undefined);
});

test("a snapshot taken from a different image is ignored", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  await sandbox.restartComputer!(scope);
  fake.terminateAll();
  const upgraded = make({ image: "ghcr.io/porter-dev/qm-sandbox:next" });
  const h2 = await upgraded.provision(layers);
  const body = fake.bodies().find((b) => b.name === h2.id)!;
  assert.equal(body.image, "ghcr.io/porter-dev/qm-sandbox:next");
  assert.equal(body.snapshotId, undefined);
});

test("a failed snapshot capture is reported and does not block the restart", async () => {
  fake = installFakePorter({ snapshotFails: true });
  const errors: string[] = [];
  sandbox = make({ onError: (e: { code: string }) => errors.push(e.code) });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  await sandbox.restartComputer!(scope);
  assert.equal(running().length, 1);
  assert.deepEqual(errors, ["porter_snapshot_failed"]);
  assert.equal((await sandbox.computerStatus!(scope)).recovery, undefined);
});

test("resources knobs shape the body and the advertised profile", async () => {
  const sized = make({ cpus: 2, memoryMb: 4096 });
  assert.equal(sized.profile.spec?.cpus, 2);
  assert.equal(sized.profile.spec?.memoryMb, 4096);
  const h = await sized.provision(layers);
  assert.deepEqual(fake.bodies().find((b) => b.name === h.id)!.resources, { cpu: "2", memory: "4096Mi" });
  assert.equal(sandbox.profile.spec?.cpus, undefined);
  assert.equal(fake.bodies().find((b) => b.name === h.id)!.tags["qm-kind"], "scope");
});

test("reapDeepIdle snapshots and retires idle bodies, keeps busy ones, and the next provision restores them", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "mkdir -p /app && echo kept > /app/state");
  await sandbox.writeFile(h, "home.txt", "on volume");
  await sandbox.teardown(h);
  assert.deepEqual(await sandbox.reapDeepIdle!(60_000), { reaped: 0 });
  assert.equal(running().length, 1);
  await store.merge(scope, { lastActivityMs: Date.now() - 120_000 });
  const { processId } = await sandbox.startProcess!(h, "sleep 20");
  assert.deepEqual(await sandbox.reapDeepIdle!(60_000), { reaped: 0 });
  assert.equal(running().length, 1);
  await sandbox.signalProcess!(h, processId, "TERM");
  if (supportsProcessSessions(sandbox)) await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.deepEqual(await sandbox.reapDeepIdle!(60_000), { reaped: 1 });
  assert.equal(running().length, 0);
  assert.equal(fake.volumeNames().length, 1);
  assert.equal(fake.snapshots().length, 1);
  const h2 = await sandbox.provision(layers);
  assert.equal(h2.coldStart, false);
  assert.equal(await sandbox.readFile(h2, "home.txt"), "on volume");
  assert.equal((await sandbox.run(h2, "cat /app/state")).stdout.trim(), "kept");
});

test("the idle sweep also refreshes stale snapshots of active bodies without retiring them", async () => {
  const prompt = make({ snapshotIntervalMs: 0 });
  const h = await prompt.provision(layers);
  await prompt.teardown(h);
  assert.deepEqual(await prompt.reapDeepIdle!(3 * 24 * 3600_000), { reaped: 0 });
  assert.equal(fake.snapshots().length, 1);
  assert.equal(running().length, 1);
  assert.deepEqual(await prompt.reapDeepIdle!(3 * 24 * 3600_000), { reaped: 0 });
  assert.equal(fake.snapshots().length, 1);
  await prompt.provision(layers);
  await prompt.teardown(h);
  assert.deepEqual(await prompt.reapDeepIdle!(3 * 24 * 3600_000), { reaped: 0 });
  const snaps = fake.snapshots();
  assert.equal(snaps.length, 1);
  assert.equal((await store.get(scope))?.snapshotId, snaps[0]!.id);
});

test("porter API errors surface the response body detail, not just the status", async () => {
  const e = withPorterErrorDetail(
    new SandboxError("HTTP 400", {
      statusCode: 400,
      body: { code: "INVALID_INPUT", message: "the cluster could not pull the sandbox image" },
    }),
  ) as Error;
  assert.equal(e.message, "HTTP 400: the cluster could not pull the sandbox image");
  assert.ok(e instanceof SandboxError);
  assert.equal((withPorterErrorDetail(e) as Error).message, "HTTP 400: the cluster could not pull the sandbox image");
});

test("destroy waits for a slowly terminating body before deleting its volume", async () => {
  fake = installFakePorter({ terminateLag: 1 });
  sandbox = make();
  const h = await sandbox.provision(layers);
  const errors: string[] = [];
  const observed = make({ onError: (e: { message: string }) => errors.push(e.message) });
  await observed.teardown(h, { destroy: true });
  assert.deepEqual(errors, []);
  assert.equal(fake.volumeNames().length, 0);
  assert.equal(fake.bodies().filter((b) => b.phase !== "terminated").length, 0);
});

test("restart and egress rotation drain the old body before mounting the volume again", async () => {
  fake = installFakePorter({ terminateLag: 1 });
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const h1 = await proxied.provision(layers);
  await proxied.writeFile(h1, "keep.txt", "kept");
  await proxied.restartComputer!(scope);
  const h2 = await proxied.provision(layers, { egressToken: "tok" });
  assert.notEqual(h2.id, h1.id);
  assert.equal(h2.coldStart, false);
  assert.equal(await proxied.readFile(h2, "keep.txt"), "kept");
  assert.equal(running().length, 1);
  assert.equal(running()[0]!.tags["qm-egress"], "proxy");
});

test("scratch bodies without an egress token stay open even when a proxy is configured", async () => {
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const h = await proxied.provision(layers, { scratch: { key: "k-open" } });
  assert.equal(h.env, undefined);
  const body = fake.bodies().find((b) => b.name === h.id)!;
  assert.equal(body.tags["qm-egress"], "open");
  assert.equal(body.egress, undefined);
  await proxied.teardown(h);
  const hp = await proxied.provision(layers, { scratch: { key: "k-proxy" }, egressToken: "tok" });
  assert.match(hp.env?.HTTPS_PROXY ?? "", /tok@/);
  assert.deepEqual(fake.bodies().find((b) => b.name === hp.id)!.egress, ["egress.qm.internal"]);
});

test("a running body past the first list page is still found", async () => {
  fake = installFakePorter({ pageSize: 1 });
  sandbox = make();
  const h1 = await sandbox.provision(layers);
  await sandbox.restartComputer!(scope);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.bodies().length, 3);
  const fresh = make({ store: createMemoryMap<StoredPorterScope>() });
  const h2 = await fresh.provision(layers);
  assert.notEqual(h2.id, h1.id);
  assert.equal(running().length, 1);
  const s = await fresh.computerStatus!(scope);
  assert.equal(s.machine, "running");
  assert.equal(s.guestResponsive, true);
});

test("computerStatus reports no computer once every body is retired", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "no computer", guestResponsive: false });
});

test("coldStart tracks whether the home volume was just created", async () => {
  await fake.client.volumes.create({ name: `${slug}-home` });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
});

test("scratch bodies never share across egress modes", async () => {
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const open = await proxied.provision(layers, { scratch: { key: "shared" } });
  const locked = await proxied.provision(layers, { scratch: { key: "shared" }, egressToken: "tok" });
  assert.notEqual(open.id, locked.id);
  assert.deepEqual(fake.bodies().find((b) => b.name === locked.id)!.egress, ["egress.qm.internal"]);
  await proxied.teardown(open);
  await proxied.teardown(locked);
  assert.equal(running().length, 0);
});
