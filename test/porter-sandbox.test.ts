import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPorterSandbox, porterScopeSlug } from "../src/sandbox/porter-sandbox.ts";
import { withPorterErrorDetails } from "../src/sandbox/porter-client.ts";
import { SandboxError } from "porter-sandbox";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { installFakePorter, type FakePorter } from "./support/fake-porter.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakePorter;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const slug = porterScopeSlug("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createPorterSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "porter-ws-"))), {
    namePrefix: "qmt",
    client: fake.client,
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakePorter();
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

test("egress proxy mode pins allowlist and injects proxy env; mode change rotates the body", async () => {
  const proxied = make({ egressProxyUrl: "https://egress.qm.internal:48080" });
  const h = await proxied.provision(layers, { egressToken: "tok-1" });
  assert.match(h.env?.HTTPS_PROXY ?? "", /x:tok-1@egress\.qm\.internal/);
  const withEgress = fake.bodies().filter((b) => b.phase === "running" && b.tags["qm-scope"] === slug);
  assert.equal(withEgress.length, 1);
  assert.deepEqual(withEgress[0]!.egress, ["egress.qm.internal"]);
  assert.equal(withEgress[0]!.tags["qm-egress"], "proxy");
  const h2 = await proxied.provision(layers);
  assert.notEqual(h2.id, h.id);
  assert.equal(h2.env, undefined);
  const open = fake.bodies().filter((b) => b.phase === "running" && b.tags["qm-scope"] === slug);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.tags["qm-egress"], "open");
  assert.equal(open[0]!.egress, undefined);
});

test("process sessions capability works end to end", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  let cursor = 0,
    chunks = "",
    state = "running";
  for (let i = 0; i < 20 && state === "running"; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: cursor });
    chunks += r.chunks;
    cursor = r.cursor;
    state = r.status.state;
  }
  assert.match(chunks, /one/);
  assert.match(chunks, /two/);
  assert.notEqual(state, "running");
});

test("scratch bodies are isolated, refcounted, and removed on release", async () => {
  const h1 = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const h2 = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(h1.id, h2.id);
  await sandbox.writeFile(h1, "s.txt", "scratch\n");
  await sandbox.teardown(h1);
  assert.equal(await sandbox.readFile(h2, "s.txt"), "scratch\n");
  await sandbox.teardown(h2);
  const remaining = fake.bodies().filter((b) => b.phase === "running");
  assert.equal(remaining.length, 0);
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

test("destroy terminates the body and deletes the volume", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  const running = fake.bodies().filter((b) => b.phase === "running");
  assert.equal(running.length, 0);
  assert.equal(fake.volumeNames().length, 0);
});

test("computerStatus reports the live body and probes the guest", async () => {
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "no computer", guestResponsive: false });
  await sandbox.provision(layers);
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "running", guestResponsive: true });
});

test("restartComputer replaces the body but keeps the home volume", async () => {
  const h1 = await sandbox.provision(layers);
  await sandbox.writeFile(h1, "keep.txt", "survives restart");
  const before = fake.bodies().find((b) => b.phase === "running")!.name;
  await sandbox.restartComputer!(scope);
  const bodies = fake.bodies();
  assert.equal(bodies.filter((b) => b.phase === "running").length, 1);
  const after = bodies.find((b) => b.phase === "running")!.name;
  assert.notEqual(after, before);
  assert.equal(bodies.find((b) => b.name === before)?.phase, "terminated");
  const h2 = await sandbox.provision(layers);
  assert.equal(h2.coldStart, false);
  assert.equal(await sandbox.readFile(h2, "keep.txt"), "survives restart");
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "running", guestResponsive: true });
});

test("porter API errors surface the response body detail, not just the status", async () => {
  const failing = withPorterErrorDetails({
    sandboxes: {
      async create() {
        throw new SandboxError("HTTP 400", {
          statusCode: 400,
          body: { code: "INVALID_INPUT", message: "the cluster could not pull the sandbox image" },
        });
      },
    },
  });
  await assert.rejects(
    () => failing.sandboxes.create(),
    (e: Error) => {
      assert.equal(e.message, "HTTP 400: the cluster could not pull the sandbox image");
      assert.ok(e instanceof SandboxError);
      return true;
    },
  );
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
  const running = fake.bodies().filter((b) => b.phase === "running");
  assert.equal(running.length, 1);
  assert.equal(running[0]!.tags["qm-egress"], "proxy");
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
  const fresh = make();
  const h2 = await fresh.provision(layers);
  assert.notEqual(h2.id, h1.id);
  assert.equal(fake.bodies().filter((b) => b.phase === "running").length, 1);
  assert.deepEqual(await fresh.computerStatus!(scope), { machine: "running", guestResponsive: true });
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
  assert.equal(fake.bodies().filter((b) => b.phase === "running").length, 0);
});
