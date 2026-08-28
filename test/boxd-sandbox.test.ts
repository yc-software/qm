import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoxdSandbox } from "../src/sandbox/boxd-sandbox.ts";
import { spriteScopeName } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeBoxd, FAKE_BOXD_API_KEY, type FakeBoxd } from "./support/fake-boxd.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeBoxd;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createBoxdSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "boxd-ws-"))), {
    apiKey: FAKE_BOXD_API_KEY,
    namePrefix: "qmt",
    client: fake.client,
    ...extra,
  });
}

async function drain(s: Sandbox, h: Awaited<ReturnType<Sandbox["provision"]>>, processId: string): Promise<string> {
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return "";
  let cursor = 0,
    chunks = "",
    state = "running";
  for (let i = 0; i < 10 && state === "running"; i++) {
    const r = await s.readProcess(h, processId, { sinceCursor: cursor });
    chunks += r.chunks;
    cursor = r.cursor;
    state = r.status.state;
  }
  return chunks;
}

beforeEach(() => {
  fake = installFakeBoxd();
  sandbox = make();
});
after(() => fake?.cleanup());

test("SANDBOX_BACKEND=boxd requires an API key unless a client is injected", () => {
  assert.throws(
    () => createBoxdSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "boxd-ws-")))),
    /BOXD_API_KEY/,
  );
});

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  assert.equal(h.homeDir, "/home/boxd");
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

test("file roundtrip incl. large binary, oversized-for-download, and missing file", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  const huge = Buffer.alloc(5 * 1024 * 1024 + 17);
  for (let i = 0; i < huge.length; i++) huge[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "huge.bin", huge);
  const hugeBack = await sandbox.readFileBytes(h, "huge.bin");
  assert.ok(hugeBack && Buffer.from(hugeBack).equals(huge), "reads past the gRPC message cap are chunked over exec");
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
  const chunks = await drain(sandbox, h, processId);
  assert.match(chunks, /one/);
  assert.match(chunks, /two/);
});

test("background processes inherit the force-through proxy env", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token });
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  const { processId } = await s.startProcess(h, "echo PROXY=$HTTPS_PROXY");
  assert.match(await drain(s, h, processId), /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
});

test("force-through strips agent-supplied proxy vars; no proxy env without a proxy url", async () => {
  assert.equal(sandbox.profile.egressEnforcement, "none");
  const plain = await sandbox.provision(layers, { egressToken: "ignored" });
  assert.equal(plain.env?.HTTPS_PROXY, undefined);
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token, env: { HTTPS_PROXY: "http://evil:1", FOO: "keep" } });
  assert.ok(h.env?.HTTPS_PROXY?.includes("proxy.example.com"));
  assert.ok(!h.env?.HTTPS_PROXY?.includes("evil"));
  assert.equal(h.env?.FOO, "keep");
});

test("machine is reused across provisions and warm start is reported", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(a.id, spriteScopeName("qmt", scope));
  assert.equal(b.coldStart, false);
  assert.equal(fake.names().filter((n) => n === a.id).length, 1);
});

test("a machine that already exists is adopted, not recreated", async () => {
  await fake.client.machines.create({ name: spriteScopeName("qmt", scope) });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal((await sandbox.run(h, "echo alive")).stdout.trim(), "alive");
  assert.equal(fake.names().length, 1);
});

test("a name conflict on create adopts the existing machine instead of failing", async () => {
  const name = spriteScopeName("qmt", scope);
  const listed = fake.client.machines.list.bind(fake.client.machines);
  let raceOnce = true;
  fake.client.machines.list = async (params) => {
    const machines = await listed(params);
    if (!raceOnce) return machines;
    raceOnce = false;
    return machines.filter((m) => m.name !== name);
  };
  await fake.client.machines.create({ name });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal((await sandbox.run(h, "echo alive")).stdout.trim(), "alive");
});

test("machines are looked up in the configured org only", async () => {
  const s = make({ org: "acme" });
  const h = await s.provision(layers);
  assert.equal(fake.machine(h.id)?.org, "acme");
  assert.ok(fake.listCalls().length > 0);
  assert.ok(fake.listCalls().every((c) => c.org === "acme"));
});

test("exec on a stopped machine starts it and retries", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.stop(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.machine(h.id)?.status, "running");
});

test("a stopped machine is started at provision", async () => {
  const a = await sandbox.provision(layers);
  fake.stop(a.id);
  const s = make();
  const b = await s.provision(layers);
  assert.equal(b.id, a.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.machine(b.id)?.status, "running");
});

test("a machine destroyed out from under a handle is recreated on the next provision", async () => {
  const a = await sandbox.provision(layers);
  await sandbox.writeFile(h(a), "x.txt", "x");
  fake.destroy(a.id);
  await assert.rejects(sandbox.run(a, "echo gone"), /boxd exec/);
  const b = await sandbox.provision(layers);
  assert.equal(b.id, a.id);
  assert.equal(b.coldStart, true);
  assert.equal(await sandbox.readFile(b, "x.txt"), null);
  function h(x: typeof a) {
    return x;
  }
});

test("a command that ran before the response was lost is never re-executed", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, ": > /home/boxd/workspace/ledger");
  fake.stallAfterRun(h.id);
  await assert.rejects(sandbox.run(h, "echo entry >> /home/boxd/workspace/ledger"), /timed out/);
  assert.equal(await sandbox.readFile(h, "ledger"), "entry\n", "the side effect must have happened exactly once");
});

test("scratch machines are separate and deleted at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.id, spriteScopeName("qmt-scratch", "job-1"));
  assert.equal((await sandbox.run(h, "echo scratch-ok")).stdout.trim(), "scratch-ok");
  await sandbox.teardown(h);
  assert.equal(fake.machine(h.id), null);
});

test("teardown without destroy keeps the machine; destroy deletes it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.ok(fake.machine(h.id));
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.machine(h.id), null);
});

test("large command output comes back intact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "python3 -c \"print('x' * (900 * 1024), end='')\"");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 900 * 1024);
});

test("configured size is requested at create and advertised in the profile", async () => {
  const s = make({ vcpu: 2, diskGb: 200 });
  const h = await s.provision(layers);
  assert.deepEqual(fake.machine(h.id)?.config, { vcpu: 2, disk: "200G" });
  assert.equal(s.profile.spec?.cpus, 2);
  assert.equal(s.profile.spec?.memoryMb, 8192);
  assert.equal(s.profile.spec?.diskGb, 200);
  const unsized = await sandbox.provision([
    { scopeId: scopeId("personal", "unsized"), mountPath: "/", mode: "rw" as const },
  ]);
  assert.equal(fake.machine(unsized.id)?.config, null);
});

test("profile advertises resident disk and process sessions", () => {
  assert.equal(sandbox.profile.backend, "boxd");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.spec?.homeDir, "/home/boxd");
  assert.equal(sandbox.profile.spec?.workdir, "/home/boxd/workspace");
});

test("backupComputer tars workspace + home over the exec channel", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(
    h,
    [
      "mkdir -p app/.cache",
      "printf hi > app/index.html",
      "printf junk > app/.cache/x",
      'printf note > "$HOME/.profile-note"',
    ].join(" && "),
  );
  const got = await sandbox.backupComputer!(h);
  const paths = got.map((e) => `${e.area}:${e.path}`).sort();
  assert.ok(paths.includes("workspace:app/index.html"), `workspace file packed (got ${paths.join(", ")})`);
  assert.ok(paths.includes("home:.profile-note"), "home file packed");
  assert.ok(!paths.some((p) => p.includes(".cache")), "content caches pruned by default");
  assert.ok(!paths.some((p) => p.startsWith("home:workspace/")), "workspace pruned from the home area");
  assert.equal(Buffer.from(got.find((e) => e.path === "app/index.html")!.data).toString("utf8"), "hi");
});

test("blob staging is advertised only when the channel is actually wired", async () => {
  assert.equal(supportsBlobStaging(make()), false);
  const wired = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  assert.equal(supportsBlobStaging(wired), true);
  const h = await wired.provision(layers);
  await assert.rejects(() => wired.stageOut!(h, "outbox/big.bin"), /boxd stageOut/);
  const script = fake.execScripts().find((s) => s.includes("/v1/blobs"))!;
  assert.match(script, /--upload-file/, "streams from disk rather than buffering in the guest");
  assert.match(script, /-X POST/);
});

test("restartComputer reboots the scope's machine and heals a wedged exec channel", async () => {
  const h = await sandbox.provision(layers);
  fake.fail(h.id);
  await assert.rejects(sandbox.run(h, "echo back"), /cannot connect/);
  await sandbox.restartComputer!(scope);
  assert.deepEqual(fake.reboots(), [h.id]);
  const after = await sandbox.run(h, "echo back");
  assert.equal(after.code, 0);
  assert.equal(after.stdout.trim(), "back");
});

test("restartComputer surfaces a refused reboot instead of swallowing it", async () => {
  const h = await sandbox.provision(layers);
  fake.refuseReboot(h.id);
  await assert.rejects(sandbox.restartComputer!(scope), /boxd reboot .*upstream reboot failed/);
  assert.deepEqual(fake.reboots(), []);
});

test("computerStatus reports the machine state and whether the shell answers", async () => {
  const h = await sandbox.provision(layers);
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "running", guestResponsive: true });
  fake.fail(h.id);
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "running", guestResponsive: false });
  fake.stop(h.id);
  assert.equal((await sandbox.computerStatus!(scope)).machine, "stopped");
  assert.match((await make().computerStatus!(scopeId("personal", "nobody"))).machine, /check failed/);
});

test("every machine call addresses the machine by id, never by name", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "f.txt", "1");
  await sandbox.readFile(h, "f.txt");
  await sandbox.run(h, "true");
  assert.equal(fake.machine(h.id)?.id, "vm-1");
  assert.notEqual(h.id, "vm-1");
});
