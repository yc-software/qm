import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { spriteScopeName } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import {
  installFakeSmolmachines,
  FAKE_SMOLMACHINES_TOKEN,
  type FakeSmolmachines,
} from "./support/fake-smolmachines.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeSmolmachines;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

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
  let cursor = 0,
    chunks = "",
    state = "running";
  for (let i = 0; i < 10 && state === "running"; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: cursor });
    chunks += r.chunks;
    cursor = r.cursor;
    state = r.status.state;
  }
  assert.match(chunks, /one/);
  assert.match(chunks, /two/);
});

test("force-through proxy env is set when a proxy url and token are present", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token });
  const r = await s.run(h, "echo PROXY=$HTTPS_PROXY");
  assert.match(r.stdout, /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
});

test("no proxy env without a proxy url", async () => {
  const h = await sandbox.provision(layers, { egressToken: "ignored" });
  assert.equal(h.env?.HTTPS_PROXY, undefined);
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

test("scratch machines are ephemeral and deleted at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.machine(h.id)?.ephemeral, true);
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

test("large command output survives the API's truncation cap exactly", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "python3 -c \"print('x' * (900 * 1024), end='')\"");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 900 * 1024);
  assert.equal(r.stdout, "x".repeat(900 * 1024));
});

test("a name conflict on create adopts the existing machine instead of failing", async () => {
  await fake.fetchImpl("https://api.smolmachines.com/v1/machines", {
    method: "POST",
    body: JSON.stringify({ name: spriteScopeName("qmt", scope), ephemeral: false }),
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

test("profile advertises resident disk and process sessions", () => {
  assert.equal(sandbox.profile.backend, "smolmachines");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(sandbox.profile.processSessions, true);
});
