import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import {
  installFakeSmolmachines,
  FAKE_SMOLMACHINES_TOKEN,
  type FakeSmolmachines,
} from "./support/fake-smolmachines.ts";
import { instrumentedSnapshotStore } from "./support/snapshot-stores.ts";
import { createMemorySnapshotStore } from "../src/sandbox/home-snapshot.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeSmolmachines;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);
const proxyToken = (): Promise<string> =>
  mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
const preCreate = (name: string): Promise<Response> =>
  fake.fetchImpl("https://api.smolmachines.com/v1/machines", {
    method: "POST",
    body: JSON.stringify({ name, ephemeral: false }),
  });

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSmolmachinesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "smol-ws-"))), {
    token: FAKE_SMOLMACHINES_TOKEN,
    namePrefix: "qmt",
    fetchImpl: fake.fetchImpl,
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeSmolmachines();
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

test("empty file roundtrip", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFileBytes(h, "empty.bin", Buffer.alloc(0));
  const back = await sandbox.readFileBytes(h, "empty.bin");
  assert.ok(back);
  assert.equal(back.length, 0);
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

test("a configured egress proxy allow-lists only the proxy host at create and injects the proxy env", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  assert.equal(s.profile.egressEnforcement, "domain");
  const h = await s.provision(layers, { egressToken: await proxyToken() });
  assert.deepEqual(fake.machine(h.id)?.network, { mode: "allowCidrs", hosts: ["proxy.example.com"] });
  const r = await s.run(h, "echo PROXY=$HTTPS_PROXY");
  assert.match(r.stdout, /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
});

test("without a proxy url machines are created open, with no proxy env and no enforcement claim", async () => {
  assert.equal(sandbox.profile.egressEnforcement, "none");
  const h = await sandbox.provision(layers, { egressToken: "ignored" });
  assert.equal(h.env?.HTTPS_PROXY, undefined);
  assert.deepEqual(fake.machine(h.id)?.network, { mode: "open" });
});

test("force-through fails closed on a machine that was created with open networking", async () => {
  const open = await sandbox.provision(layers);
  assert.deepEqual(fake.machine(open.id)?.network, { mode: "open" });
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  await assert.rejects(
    s.provision(layers, { egressToken: await proxyToken() }),
    /machine network is .*"open".*allowCidrs/,
  );
  assert.ok(fake.machine(open.id), "the open machine is left for the operator to destroy, never silently replaced");
});

test("machine is reused across provisions and warm start is reported", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.names().filter((n) => n === a.id).length, 1);
});

test("exec on a stopped machine restarts it and retries", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.stop(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.machine(h.id)?.state.toLowerCase(), "running");
});

test("a fresh core adopts a machine the API reports as Running without restarting it", async () => {
  const h = await sandbox.provision(layers);
  assert.equal(fake.machine(h.id)?.state, "Running");
  const s2 = make();
  const startsBefore = fake.calls.filter((c) => c.path.endsWith("/start")).length;
  const h2 = await s2.provision(layers);
  assert.equal(h2.id, h.id);
  assert.equal(h2.coldStart, false);
  const startsAfter = fake.calls.filter((c) => c.path.endsWith("/start")).length;
  assert.equal(startsAfter, startsBefore, "a running machine is adopted as-is, never restarted");
});

test("an egress proxy url without a hostname is rejected at creation, never fail-open", () => {
  assert.throws(() => make({ egressProxyUrl: "unix:///tmp/proxy.sock" }), /hostname/);
});

test("scratch machines are ephemeral and deleted at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.machine(h.id)?.ephemeral, true);
  await sandbox.teardown(h);
  assert.equal(fake.machine(h.id), null);
});

test("overlapping scratch leases on one key share a machine until the last release", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(a.id, b.id);
  assert.equal(a.coldStart, true);
  assert.equal(b.coldStart, false);
  assert.equal(fake.names().filter((n) => n === a.id).length, 1);
  await sandbox.teardown(a);
  assert.ok(fake.machine(a.id));
  await sandbox.teardown(b);
  assert.equal(fake.machine(b.id), null);
});

test("teardown without destroy keeps the machine; destroy deletes it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.ok(fake.machine(h.id));
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.machine(h.id), null);
});

test("command output is read byte-exact from the base64 stream past the 1 MiB text cap", async () => {
  const h = await sandbox.provision(layers);
  const size = 1500 * 1024;
  const r = await sandbox.run(
    h,
    `python3 -c "import sys; sys.stdout.write('x' * ${size}); sys.stderr.write('e' * ${size})"`,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "x".repeat(size));
  assert.equal(r.stderr, "e".repeat(size));
  const execs = fake.calls.filter((c) => c.path.endsWith("/exec"));
  assert.ok(execs.length > 0);
  assert.ok(
    execs.every((c) => c.query === "output=b64"),
    "every exec asks for the byte-exact family only",
  );
});

test("a control plane without base64 output still fails closed on truncated text", async () => {
  const textOnly: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/exec")) return fake.fetchImpl(input, init);
    url.search = "";
    const res = await fake.fetchImpl(url, init);
    const body = (await res.json()) as Record<string, unknown>;
    delete body.stdoutB64;
    delete body.stderrB64;
    return Response.json(body);
  };
  const s = make({ fetchImpl: textOnly });
  const h = await s.provision(layers);
  const small = await s.run(h, "echo legacy");
  assert.equal(small.stdout, "legacy\n");
  await assert.rejects(s.run(h, "python3 -c \"print('x' * (1100 * 1024), end='')\""), /stdout truncated/);
});

test("a name conflict on create adopts the existing machine instead of failing", async () => {
  await fake.fetchImpl("https://api.smolmachines.com/v1/machines", {
    method: "POST",
    body: JSON.stringify({ name: sandboxScopeName("qmt", scope), ephemeral: false }),
  });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
});

test("timeouts beyond the API's sync exec ceiling run detached and poll to completion", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo long-path-ok; echo warn >&2; exit 9", { timeoutMs: 400_000 });
  assert.equal(r.code, 9);
  assert.equal(r.stdout.trim(), "long-path-ok");
  assert.equal(r.stderr.trim(), "warn");
  const leftovers = await sandbox.run(h, "ls /root/.qm-exec-*.rc 2>/dev/null | wc -l");
  assert.equal(leftovers.stdout.trim(), "0");
});

test("configured resources are requested at create and advertised in the profile", async () => {
  const s = make({ cpus: 4, memoryMb: 8192, diskGb: 200 });
  const h = await s.provision(layers);
  assert.deepEqual(fake.machine(h.id)?.resources, { cpus: 4, memoryMb: 8192, diskGb: 200 });
  assert.equal(s.profile.spec?.diskGb, 200);
  assert.equal(s.profile.spec?.memoryMb, 8192);
  assert.equal(s.profile.spec?.cpus, 4);
});

test("profile advertises resident disk, process sessions, and the documented default shape", () => {
  assert.equal(sandbox.profile.backend, "smolmachines");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.spec?.cpus, 4);
  assert.equal(sandbox.profile.spec?.memoryMb, 8192);
  assert.equal(sandbox.profile.spec?.diskGb, undefined);
  assert.match(sandbox.profile.spec?.os ?? "", /codex image/);
  assert.doesNotMatch(sandbox.profile.spec?.os ?? "", /Debian|idle/);
  const idle = make({ image: "ubuntu:24.04", autoStopSec: 900 });
  assert.match(idle.profile.spec?.os ?? "", /ubuntu:24\.04 image/);
  assert.match(idle.profile.spec?.os ?? "", /900s idle/);
});

test("a machine the provider reports in error state fails fast with the provider's reason", async () => {
  await preCreate(scopeName());
  fake.fail(scopeName(), "start failed: no capacity in region");
  await assert.rejects(sandbox.provision(layers), /error state: start failed: no capacity in region/);
});

test("started is not ready: provisioning polls until the machine reports ready", async () => {
  await preCreate(scopeName());
  fake.notReadyFor(scopeName(), 2);
  const h = await sandbox.provision(layers);
  const isMachineGet = (c: { method: string; path: string }): boolean =>
    c.method === "GET" && /\/v1\/machines\/[^/]+$/.test(c.path);
  const machineGets = fake.calls.filter(isMachineGet);
  assert.ok(machineGets.length >= 3, `polled the machine ${machineGets.length} times before acting`);
  const readyGet = fake.calls.indexOf(machineGets[2]!);
  const firstExec = fake.calls.findIndex((c) => c.path.endsWith("/exec"));
  assert.ok(firstExec > readyGet, "no work is dispatched before the ready poll succeeds");
  assert.equal((await sandbox.run(h, "echo up")).stdout.trim(), "up");
});

test("scratch machines carry a hard TTL and configured idle stop is sent on every create", async () => {
  const s = make({ autoStopSec: 900 });
  const scratch = await s.provision(layers, { scratch: { key: "job-ttl" } });
  assert.equal(fake.machine(scratch.id)?.ttlSeconds, 24 * 3600);
  assert.equal(fake.machine(scratch.id)?.autoStopSeconds, 900);
  const resident = await s.provision(layers);
  assert.equal(fake.machine(resident.id)?.ttlSeconds, undefined);
  assert.equal(fake.machine(resident.id)?.autoStopSeconds, 900);
  const plain = await sandbox.provision([
    { scopeId: scopeId("personal", "other"), mountPath: "/", mode: "rw" as const },
  ]);
  assert.equal(fake.machine(plain.id)?.autoStopSeconds, undefined);
});

test("exec requests carry no stdin field", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "echo x");
  const execCall = fake.calls.filter((c) => c.path.endsWith("/exec")).at(-1)!;
  assert.equal(execCall.body, undefined);
  assert.ok(fake.execScripts().every((script) => !/stdin/.test(script)));
});

test("teardown snapshots the home to the configured store and a lost machine is rehydrated from it", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const a = await s.provision(layers);
  await s.writeFile(a, "notes.txt", "keep me\n");
  await s.teardown(a);
  assert.ok(await snapshots.open(scope), "teardown stored a home snapshot");
  const status = await s.computerStatus!(scope);
  assert.equal(status.recovery?.strategy, "workspace_snapshot");
  assert.ok(status.recovery?.checkpointAtMs);
  fake.deleteBehindCore(a.id);
  const s2 = make({ snapshots });
  const b = await s2.provision(layers);
  assert.equal(b.coldStart, false, "a hydrated replacement is not a cold start");
  assert.equal(await s2.readFile(b, "notes.txt"), "keep me\n");
});

test("teardown snapshots are throttled by snapshotIntervalMs and skipped for scratch machines", async () => {
  const counting = instrumentedSnapshotStore();
  const s = make({ snapshots: counting.store, snapshotIntervalMs: 60 * 60_000 });
  const a = await s.provision(layers);
  await s.teardown(a);
  const b = await s.provision(layers);
  await s.teardown(b);
  assert.equal(counting.puts(), 1, "second teardown inside the interval skips the snapshot");
  const scratch = await s.provision(layers, { scratch: { key: "job-snap" } });
  await s.teardown(scratch);
  assert.equal(counting.puts(), 1, "scratch machines are never snapshotted");
});

test("a failing snapshot store is recorded in status and a failed hydration never cold-starts empty", async () => {
  const flaky = instrumentedSnapshotStore();
  const errors: string[] = [];
  const s = make({
    snapshots: flaky.store,
    onError: (e: { code: string }) => {
      errors.push(e.code);
    },
  });
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  flaky.failWrites(true);
  await s.teardown(await s.provision(layers));
  assert.ok(errors.includes("teardown_snapshot_failed"));
  assert.match((await s.computerStatus!(scope)).recovery?.error ?? "", /simulated S3 outage/);
  flaky.failWrites(false);
  fake.deleteBehindCore(a.id);
  const restarted = make({ snapshots: flaky.store });
  flaky.failReads(true);
  await assert.rejects(restarted.provision(layers), /hydration failed/);
  assert.equal(fake.machine(a.id), null, "the empty replacement is deleted rather than adopted");
  flaky.failReads(false);
  const b = await restarted.provision(layers);
  assert.equal(await restarted.readFile(b, "precious.txt"), "irreplaceable\n");
});

test("persistHomeSnapshot exists only with a snapshot store and stores the home on demand", async () => {
  assert.equal(sandbox.persistHomeSnapshot, undefined);
  assert.equal((await sandbox.computerStatus!(scope)).recovery, undefined);
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const h = await s.provision(layers);
  await s.writeFile(h, "explicit.txt", "saved\n");
  await s.persistHomeSnapshot!(scope);
  assert.ok(await snapshots.open(scope));
});

test("computerStatus reports a stopped machine as paused without waking it", async () => {
  assert.deepEqual(await sandbox.computerStatus!(scope), {
    machine: "no machine provisioned yet",
    provisioned: false,
    guestResponsive: false,
  });
  const h = await sandbox.provision(layers);
  const running = await sandbox.computerStatus!(scope);
  assert.equal(running.lifecycleState, "running");
  assert.equal(running.guestResponsive, true);
  fake.stop(h.id);
  const execsBefore = fake.calls.filter((c) => c.path.endsWith("/exec")).length;
  const stopped = await sandbox.computerStatus!(scope);
  assert.equal(stopped.lifecycleState, "paused");
  assert.equal(stopped.guestResponsive, false);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/exec")).length, execsBefore);
  assert.equal(fake.machine(h.id)?.state, "stopped");
  fake.fail(h.id, "auto-start failed: node lost");
  assert.match((await sandbox.computerStatus!(scope)).machine, /error: auto-start failed: node lost/);
});

test("read and write refuse parent path segments before any provider request", async () => {
  const h = await sandbox.provision(layers);
  fake.calls.length = 0;
  for (const rel of ["../../../../../machines", "../../../../m-2/files/root/x", "a/../../b"]) {
    await assert.rejects(sandbox.readFile(h, rel), /must stay inside the workspace/);
    await assert.rejects(sandbox.writeFile(h, rel, "x"), /must stay inside the workspace/);
  }
  assert.deepEqual(
    fake.calls.filter((c) => c.path.includes("/files")),
    [],
  );
});
