import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpritesSandbox,
  processKeepaliveScript,
  retrySpritesControl,
  spritesErrorDetail,
} from "../src/sandbox/sprites-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { execFailureDetail, supportsProcessSessions, supportsBlobStaging } from "../src/sandbox/sandbox.ts";
import { createMemorySnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { sleep } from "../src/util/async.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeSprites, FAKE_SPRITES_TOKEN, type FakeSprites } from "./support/fake-sprites.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { APIError } from "@fly/sprites";

let fake: FakeSprites;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSpritesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "sprites-ws-"))), {
    token: FAKE_SPRITES_TOKEN,
    namePrefix: "qmt",
    baseUrl: fake.baseUrl,
    ...extra,
  });
}

const proxyToken = () =>
  mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );

beforeEach(() => {
  fake?.cleanup();
  fake = installFakeSprites();
  sandbox = make();
});
after(() => fake?.cleanup());

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\/home\/sprite\/workspace|workspace/);
  assert.match(r.stdout, /VAR=v1/);
});

test("streams and exit codes are exact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
});

test("commands run over the WebSocket exec endpoint with the script in the stream, never the URL", async () => {
  const h = await sandbox.provision(layers);
  const huge = `echo start; : ${"x".repeat(1024 * 1024)}; echo end`;
  const r = await sandbox.run(h, huge);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /start\s+end/);
  const execs = fake.calls.filter((c) => c.method === "WS");
  assert.ok(execs.length > 0, "commands ride the WebSocket exec channel");
  assert.ok(
    !fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/exec")),
    "the frame-ambiguous HTTP exec fallback is never used",
  );
  assert.ok(Math.max(...execs.map((c) => c.path.length)) < 2048, "exec URLs stay small");
  assert.ok(
    execs.some((c) => (c.script?.length ?? 0) > 1024 * 1024),
    "the megabyte script travels as stdin frames",
  );
});

test("file roundtrip incl. large binary and missing file goes through the filesystem API", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const huge = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < huge.length; i++) huge[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "huge.bin", huge);
  const hugeBack = await sandbox.readFileBytes(h, "huge.bin");
  assert.ok(hugeBack && Buffer.from(hugeBack).equals(huge));
  assert.ok(fake.calls.some((c) => c.method === "PUT" && c.path.includes("/fs/write?")));
  assert.ok(fake.calls.some((c) => c.method === "GET" && c.path.includes("/fs/read?")));
  assert.ok(!fake.execScripts().some((s) => /base64|dd if=/.test(s)), "bytes never round-trip through shell encoding");
});

test("a file write lands on a temp path and is renamed into place, never streamed into the target", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "cfg.txt", "value\n");
  assert.equal(await sandbox.readFile(h, "cfg.txt"), "value\n");
  const write = fake.calls.find((c) => c.method === "PUT" && c.path.includes("cfg.txt"));
  assert.ok(write, "expected a filesystem write");
  assert.match(write!.path, /cfg\.txt\.part\./, "the payload lands on a temp path");
  const writeIdx = fake.calls.indexOf(write!);
  assert.ok(
    fake.calls.slice(writeIdx).some((c) => c.method === "POST" && c.path.endsWith("/fs/rename")),
    "and is renamed over the target afterwards",
  );
});

test("process sessions capability works end to end and holds the sprite awake with a Tasks heartbeat", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one/);
  assert.match(output, /two/);
  const keepalive = fake.execScripts().find((s) => s.includes("/.sprite/api.sock"));
  assert.ok(keepalive, "a keepalive sidecar was launched next to the process");
  assert.match(keepalive!, new RegExp(`/v1/tasks/qm-proc-${processId}`));
  assert.match(keepalive!, /-X PUT/, "renews by upsert so the first call creates the task");
  assert.match(keepalive!, /-X DELETE/, "and releases the hold when the process is gone");
  const listed = await sandbox.listProcesses(h);
  assert.deepEqual(
    listed.map((p) => p.command),
    ["echo one; echo two"],
    "the sidecar is not a visible process session and the command stays readable",
  );
});

test("the keepalive script stops renewing once the process has recorded an exit code", () => {
  const script = processKeepaliveScript("00000000-0000-0000-0000-000000000000");
  assert.match(script, /while \[ ! -f "\$P\/code" \]/);
  assert.match(script, /"expire":"5m"/);
  assert.match(script, /setsid/);
});

test("background processes inherit the force-through proxy env", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const h = await s.provision(layers, { egressToken: await proxyToken() });
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  const { processId } = await s.startProcess(h, "echo PROXY=$HTTPS_PROXY");
  let cursor = 0,
    chunks = "",
    state = "running";
  for (let i = 0; i < 10 && state === "running"; i++) {
    const r = await s.readProcess(h, processId, { sinceCursor: cursor });
    chunks += r.chunks;
    cursor = r.cursor;
    state = r.status.state;
  }
  assert.match(chunks, /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
});

test("scope name is stable and slugged", () => {
  const a = sandboxScopeName("qmt", "person:tester");
  assert.equal(a, sandboxScopeName("qmt", "person:tester"));
  assert.match(a, /^qmt-person-tester-[0-9a-f]{6}$/);
});

test("no egress force-through without a proxy url: no policy, no proxy env", async () => {
  assert.equal(sandbox.profile.egressEnforcement, "none");
  const h = await sandbox.provision(layers, { egressToken: "ignored" });
  assert.equal(fake.policy(h.id), null);
  assert.equal(h.env?.HTTPS_PROXY, undefined);
});

test("force-through pins the platform policy and injects proxy env", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  assert.equal(s.profile.egressEnforcement, "domain");
  const token = await mintCapabilityToken(
    {
      actorId: "tester",
      scopeId: scope,
      aud: EGRESS_PROXY_AUD,
      egress: { allowedHosts: ["api.anthropic.com"], deniedHosts: [] },
      exp: Date.now() + 600_000,
    },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token });
  const pol = fake.policy(h.id);
  assert.deepEqual(pol, [{ domain: "proxy.example.com", action: "allow" }]);
  assert.equal(new URL(h.env!.HTTPS_PROXY!).hostname, "proxy.example.com");
  assert.ok(h.env?.HTTPS_PROXY?.includes(token));
  assert.equal(h.env?.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("proxy migration keeps both hosts reachable across cutover and rollback", async () => {
  const token = await proxyToken();
  const oldUrl = "https://old.example.com";
  const newUrl = "https://new.example.com";
  for (const [primary, additional] of [
    [oldUrl, newUrl],
    [newUrl, oldUrl],
    [oldUrl, newUrl],
  ]) {
    const s = make({ egressProxyUrl: primary, egressProxyAdditionalUrls: [additional, primary] });
    const h = await s.provision(layers, { egressToken: token });
    assert.deepEqual(fake.policy(h.id), [
      { domain: "new.example.com", action: "allow" },
      { domain: "old.example.com", action: "allow" },
    ]);
    assert.equal(new URL(h.env!.HTTPS_PROXY!).hostname, new URL(primary!).hostname);
  }
});

test("proxy migration rejects mismatched provider policy and invalid configuration", async () => {
  const s = make({
    egressProxyUrl: "https://new.example.com",
    egressProxyAdditionalUrls: ["https://old.example.com"],
  });
  fake.breakPolicyReadback(sandboxScopeName("qmt", scope));
  await assert.rejects(s.provision(layers, { egressToken: await proxyToken() }), /readback mismatch/);
  assert.throws(() => make({ egressProxyAdditionalUrls: ["https://old.example.com"] }), /require a primary/);
  assert.throws(
    () => make({ egressProxyUrl: "https://new.example.com", egressProxyAdditionalUrls: ["file:///tmp/x"] }),
    /HTTP\(S\)/,
  );
});

test("force-through strips agent-supplied proxy vars", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const h = await s.provision(layers, {
    egressToken: await proxyToken(),
    env: { HTTPS_PROXY: "http://evil:1", FOO: "keep" },
  });
  assert.ok(!h.env?.HTTPS_PROXY?.includes("evil"));
  assert.equal(h.env?.FOO, "keep");
});

test("force-through fails closed if the policy readback doesn't bind", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  fake.breakPolicyReadback(sandboxScopeName("qmt", scope));
  await assert.rejects(s.provision(layers, { egressToken: await proxyToken() }), /readback mismatch/);
});

test("a recreated sprite gets the egress policy re-pinned, never served from a stale cache", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await proxyToken();
  const a = await s.provision(layers, { scratch: { key: "job-pol" }, egressToken: token });
  assert.deepEqual(fake.policy(a.id), [{ domain: "proxy.example.com", action: "allow" }]);
  await s.teardown(a);
  assert.equal(fake.policy(a.id), null, "the sprite and its platform policy are gone after release");
  const b = await s.provision(layers, { scratch: { key: "job-pol" }, egressToken: token });
  assert.equal(b.id, a.id);
  assert.deepEqual(fake.policy(b.id), [{ domain: "proxy.example.com", action: "allow" }]);
});

test("a failed egress setup releases the scratch lease instead of wedging the key", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  fake.breakPolicyReadback(sandboxScopeName("qmt-scratch", "job-egress"));
  await assert.rejects(
    s.provision(layers, { scratch: { key: "job-egress" }, egressToken: await proxyToken() }),
    /readback mismatch/,
  );
  const retry = await s.provision(layers, { scratch: { key: "job-egress" } });
  assert.equal(retry.scratch, true);
  assert.equal(retry.coldStart, true, "the failed provision released its lease and the box was recreated");
});

test("scratch sprites are ephemeral and shared leases survive until the last release", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(a.scratch, true);
  assert.equal(a.id, b.id);
  assert.equal(a.coldStart, true);
  assert.equal(b.coldStart, false);
  await sandbox.teardown(a);
  assert.ok(fake.names().includes(a.id));
  await sandbox.teardown(b);
  assert.ok(!fake.names().includes(b.id));
  assert.equal(fake.checkpoints(a.id).length, 0, "scratch boxes are never checkpointed");
});

test("teardown checkpoints a changed home, throttles repeats, and destroy deletes the sprite", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.deepEqual(fake.checkpoints(h.id), ["v1"], "a turn that may have changed the home ends in a checkpoint");
  await sandbox.teardown(h);
  assert.deepEqual(fake.checkpoints(h.id), ["v1"], "a second teardown inside the interval is throttled");
  assert.ok(fake.names().includes(h.id), "parking keeps the sprite");
  await sandbox.teardown(h, { destroy: true });
  assert.ok(!fake.names().includes(h.id));
});

test("an unchanged home is not checkpointed once its state is known", async () => {
  const s = make({ checkpointIntervalMs: 1 });
  const h = await s.provision(layers);
  await s.teardown(h, { homeUnchanged: true });
  assert.deepEqual(fake.checkpoints(h.id), ["v1"], "a sprite this core has not checkpointed yet is saved once");
  await sleep(5);
  await s.teardown(h, { homeUnchanged: true });
  assert.deepEqual(fake.checkpoints(h.id), ["v1"], "a quiet turn after that adds nothing");
  await s.teardown(h);
  assert.deepEqual(fake.checkpoints(h.id), ["v1", "v2"], "a turn that may have changed the home is saved");
  await sleep(5);
  await s.teardown(h, { homeUnchanged: true });
  assert.deepEqual(fake.checkpoints(h.id), ["v1", "v2"]);
});

test("a checkpoint failure is reported and never fails the teardown", async () => {
  const events: Array<{ code: string }> = [];
  const s = make({ onError: (e: { code: string }) => events.push(e) });
  const h = await s.provision(layers);
  fake.fail502(h.id);
  fake.unhealthy(h.id, "checkpoint store offline");
  await s.teardown(h);
  assert.ok(fake.checkpoints(h.id).length <= 1);
});

test("computerStatus reports checkpoint recovery and a healthy machine whose shell has stopped answering", async () => {
  const h = await sandbox.provision(layers);
  const fresh = await sandbox.computerStatus!(scope);
  assert.equal(fresh.machine, "healthy");
  assert.equal(fresh.provisioned, true);
  assert.equal(fresh.guestResponsive, true);
  assert.equal(fresh.listed, undefined, "the list-view status is stale by design and is not surfaced");
  assert.deepEqual(fresh.recovery, { strategy: "provider_snapshot", checkpointExpiresAtMs: null });

  await sandbox.teardown(h);
  fake.fail502(h.id);
  const wedged = await sandbox.computerStatus!(scope);
  assert.equal(wedged.machine, "healthy");
  assert.equal(wedged.guestResponsive, false);
  assert.equal(wedged.recovery?.checkpointId, "v1");
  assert.equal(typeof wedged.recovery?.checkpointAtMs, "number");
});

test("computerStatus names a faulted check and an unprovisioned scope", async () => {
  const none = await sandbox.computerStatus!(scope);
  assert.deepEqual(none, { machine: "no sprite provisioned yet", provisioned: false, guestResponsive: false });
  const h = await sandbox.provision(layers);
  fake.unhealthy(h.id, "disk unreachable");
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.machine, "unhealthy (disk unreachable)");
  assert.equal(s.provisioned, true);
});

test("restartComputer reboots the scope's sprite and heals a wedged exec channel", async () => {
  const h = await sandbox.provision(layers);
  fake.fail502(h.id);
  await assert.rejects(sandbox.run(h, "echo back"), /WebSocket error/);

  await sandbox.restartComputer!(scope);
  assert.deepEqual(fake.restarts(), [h.id]);

  const after = await sandbox.run(h, "echo back");
  assert.equal(after.code, 0);
  assert.equal(after.stdout.trim(), "back");
});

test("a refused restart on a faulted sprite restores the latest checkpoint", async () => {
  const events: Array<{ code: string; message: string }> = [];
  const s = make({ onError: (e: { code: string; message: string }) => events.push(e) });
  const h = await s.provision(layers);
  await s.writeFile(h, "keep.txt", "before\n");
  await s.teardown(h);
  await s.writeFile(h, "keep.txt", "after\n");
  fake.refuseRestart(h.id);
  fake.unhealthy(h.id, "machine unreachable");
  fake.fail502(h.id);

  await s.restartComputer!(scope);
  assert.deepEqual(fake.restarts(), []);
  assert.equal(await s.readFile(h, "keep.txt"), "before\n", "the home is back at the checkpoint");
  const restored = events.find((e) => e.code === "checkpoint_restored");
  assert.ok(restored, "the destructive recovery is reported");
  assert.match(restored!.message, /http 502/);
  assert.match(restored!.message, /machine unreachable/);
  assert.match(restored!.message, /restored checkpoint v1/);
});

test("a refused restart with a healthy check restores nothing and surfaces the refusal", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.refuseRestart(h.id);
  await assert.rejects(sandbox.restartComputer!(scope), /http 502.*reports no fault/s);
  assert.equal(await sandbox.readFile(h, ".ro-layers.manifest"), null);
});

test("a refused restart with no checkpoint to fall back on names all three failures", async () => {
  const h = await sandbox.provision(layers);
  fake.refuseRestart(h.id);
  fake.unhealthy(h.id, "boot loop");
  await assert.rejects(sandbox.restartComputer!(scope), /http 502.*boot loop.*no checkpoint to restore/s);
});

test("a command that ran before the response was lost is never re-executed", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, ": > /home/sprite/workspace/ledger");
  fake.stallAfterRun(h.id);

  await assert.rejects(sandbox.run(h, "echo entry >> /home/sprite/workspace/ledger"));

  const ledger = await sandbox.readFile(h, "ledger");
  assert.equal(ledger, "entry\n", "the side effect must have happened exactly once");
});

test("exec results carry io pressure when the guest exposes it, and omit it when it can't be read", async () => {
  const h = await sandbox.provision(layers);
  const bare = await sandbox.run(h, "echo ok");
  assert.equal(bare.pressure, undefined);

  fake.setPressure(h.id, { full10: 85.17, full60: 86.14, load1: 30.78 });
  const r = await sandbox.run(h, "echo ok");
  assert.equal(r.code, 0);
  assert.deepEqual(r.pressure, { ioFull10: 85.17, ioFull60: 86.14, load1: 30.78 });
});

test("sustained io pressure is reported once per episode, then re-arms after it clears", async () => {
  const events: Array<{ code: string }> = [];
  const s = make({ onError: (e: { code: string }) => events.push(e) });
  const h = await s.provision(layers);

  fake.setPressure(h.id, { full10: 90, full60: 88, load1: 25 });
  await s.run(h, "echo a");
  await s.run(h, "echo b");
  assert.deepEqual(
    events.filter((e) => e.code === "io_pressure_high").length,
    1,
    "a continuing episode records exactly one event",
  );

  fake.setPressure(h.id, { full10: 5, full60: 5, load1: 1 });
  await s.run(h, "echo c");
  fake.setPressure(h.id, { full10: 90, full60: 88, load1: 25 });
  await s.run(h, "echo d");
  assert.equal(events.filter((e) => e.code === "io_pressure_high").length, 2, "a new episode records again");
});

test("computerStatus carries guest pressure alongside the health check", async () => {
  const h = await sandbox.provision(layers);
  fake.setPressure(h.id, { full10: 60, full60: 55, load1: 8 });
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.machine, "healthy");
  assert.equal(s.guestResponsive, true);
  assert.deepEqual(s.pressure, { ioFull10: 60, ioFull60: 55, load1: 8 });
});

test("a garbled pressure read never costs the caller a completed command's result", async () => {
  const h = await sandbox.provision(layers);
  fake.setPressure(h.id, { full10: 60, full60: 55, load1: 8 });
  writeFileSync(join(fake.homeDir(h.id), ".proc-loadavg"), "");
  const r = await sandbox.run(h, "echo survived");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "survived");
  assert.equal(r.pressure, undefined, "partial telemetry is dropped, not surfaced or fatal");
});

test("concurrent restart calls for one sprite collapse into sequential requests", async () => {
  const h = await sandbox.provision(layers);
  await Promise.all([sandbox.restartComputer!(scope), sandbox.restartComputer!(scope)]);
  assert.deepEqual(fake.restarts(), [h.id, h.id], "serialized, one request per call, never interleaved forcing");
});

test("commands cannot swallow the script from stdin", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "cat; echo after-cat");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "after-cat");
});

test("a creation rate limit surfaces the provider's code and retry hint", async () => {
  fake.rateLimitCreate(42);
  await assert.rejects(sandbox.provision(layers), (e: Error) => {
    assert.match(e.message, /sprites create /);
    assert.match(e.message, /sprite_creation_rate_limited/);
    assert.match(e.message, /retry after: 42s/);
    assert.match(e.message, /http 429/);
    assert.ok(e.cause instanceof APIError);
    return true;
  });
  const created = await sandbox.provision(layers);
  assert.equal(created.coldStart, true, "the next attempt creates normally");
  assert.ok(
    fake.calls.some((c) => c.method === "POST" && c.path === "/v1/sprites"),
    "creation goes through the SDK client",
  );
});

test("spritesErrorDetail keeps plain errors as they are and enriches API errors", () => {
  assert.equal(spritesErrorDetail(new Error("boom")), "boom");
  const limited = new APIError("Too many", {
    statusCode: 429,
    errorCode: "concurrent_sprite_limit_exceeded",
    retryAfterHeader: 7,
  });
  assert.equal(spritesErrorDetail(limited), "Too many; http 429; concurrent_sprite_limit_exceeded; retry after 7s");
});

test("a configured memory limit is applied as a resources policy and advertised in the profile", async () => {
  const s = make({ memoryMb: 4096 });
  assert.equal(s.profile.spec?.memoryMb, 4096);
  assert.equal(s.profile.spec?.cpus, 8);
  const h = await s.provision(layers);
  assert.deepEqual(fake.resources(h.id), { limitMB: 4096 });
  assert.equal(sandbox.profile.spec?.memoryMb, undefined, "no knob, no claim");
  assert.equal(fake.resources(sandboxScopeName("qmt", scope))?.limitMB, 4096);
});

test("the profile is honest about the base release and what survives sleep", () => {
  const os = sandbox.profile.spec?.os ?? "";
  assert.match(os, /Ubuntu \(25\.10 for newly created sprites/);
  assert.doesNotMatch(os, /LTS/);
  assert.match(os, /do not survive a cold wake/);
});

test("exportFiles tars workspace + home over the exec channel (the publish fast path)", async () => {
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

  const got = await sandbox.exportFiles!(h);
  const paths = got.map((e) => `${e.area}:${e.path}`).sort();
  assert.ok(paths.includes("workspace:app/index.html"), `workspace file packed (got ${paths.join(", ")})`);
  assert.ok(paths.includes("home:.profile-note"), "home file packed");
  assert.ok(!paths.some((p) => p.includes(".cache")), "content caches pruned by default");
  assert.ok(!paths.some((p) => p.startsWith("home:workspace/")), "workspace pruned from the home area");
  assert.equal(Buffer.from(got.find((e) => e.path === "app/index.html")!.data).toString("utf8"), "hi");
});

test("exportFiles keepContentCaches ships cache-named build output (publish parity)", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "mkdir -p site/.cache && printf real > site/.cache/bundle.js");
  const got = await sandbox.exportFiles!(h, {
    include: ["workspace"],
    keepContentCaches: true,
    exclude: () => false,
  });
  assert.ok(
    got.some((e) => e.path === "site/.cache/bundle.js"),
    "cache-named build output crosses when publish asks for it",
  );
});

test("blob staging is advertised only when the channel is actually wired", async () => {
  assert.equal(
    supportsBlobStaging(make()),
    false,
    "without blobTransfer/secret/apiBaseUrl the capability must not be claimed — copyHome probes for it",
  );
  const wired = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  assert.equal(supportsBlobStaging(wired), true, "wired up, sprites can move bytes by reference");
});

test("stageOut posts to core's blob endpoint by streaming, never by buffering in the guest", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageOut!(h, "artifacts/big.bin"), /sprites stageOut/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs"))!;
  assert.ok(script, "the stageOut curl reached the guest");
  assert.match(script, /--upload-file/, "streams from disk rather than buffering in the guest");
  assert.doesNotMatch(script, /--data-binary/, "the OOM shape must never come back");
  assert.match(script, /-X POST/, "--upload-file alone would send PUT");
  assert.match(script, /x-content-sha256/, "core verifies the upload end-to-end");
});

test("stageIn pulls a blob into the guest atomically (temp then mv)", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageIn!(h, "inbox/big.bin", "f".repeat(32)), /sprites stageIn/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs/"))!;
  assert.match(script, /-o .*\.part/, "downloads to a temp file");
  assert.match(script, /mv -f /, "and only then moves it into place");
  assert.match(script, /curl -fsS/, "-f so an HTTP error fails loudly instead of writing the error body");
});

test("a prep failure that writes nothing still names its cause", () => {
  assert.equal(
    execFailureDetail({ stdout: "", stderr: "", code: 124, timedOut: true }, 60),
    "timed out after 60s with no output",
    "a wedged guest filesystem kills the script before it can explain itself",
  );
  assert.equal(execFailureDetail({ stdout: "", stderr: "", code: 1, timedOut: false }, 60), "exit 1 with no output");
  assert.equal(execFailureDetail({ stdout: "out", stderr: " boom\n", code: 1, timedOut: false }, 60), "boom");
  assert.equal(execFailureDetail({ stdout: " out\n", stderr: "", code: 1, timedOut: false }, 60), "out");
});

test("destroying a scope exports the home to the snapshot store first and a replacement hydrates from it", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const h = await s.provision(layers);
  await s.run(h, 'printf survivor > "$HOME/notes.txt"');
  assert.equal(await snapshots.open(scope), null);

  await s.destroyScope!(scope);
  assert.ok(!fake.names().includes(h.id), "the sprite is gone");
  const stored = await snapshots.open(scope);
  assert.ok(stored && stored.size > 0, "but its home was exported before deletion");

  const again = await s.provision(layers);
  assert.equal(again.coldStart, false, "the replacement is hydrated, not cold");
  const back = await s.run(again, 'cat "$HOME/notes.txt"');
  assert.equal(back.stdout, "survivor");
  assert.equal(typeof s.persistHomeSnapshot, "function", "explicit export is offered when a store is wired");
  assert.equal(typeof make().persistHomeSnapshot, "undefined");
});

test("a failed export refuses to destroy the sprite", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const h = await s.provision(layers);
  fake.fail502(h.id);
  await assert.rejects(s.destroyScope!(scope), /WebSocket error/);
  assert.ok(fake.names().includes(h.id), "an irreversible delete never follows a lost export");
});

test("without a snapshot store a destroy is a single delete that tolerates a missing sprite", async () => {
  await sandbox.destroyScope!(scope);
  assert.deepEqual(
    fake.calls.map((c) => `${c.method} ${c.path}`),
    [`DELETE /v1/sprites/${sandboxScopeName("qmt", scope)}`],
  );
  fake.refuseDelete(503);
  await assert.rejects(sandbox.destroyScope!(scope), /sprites delete .*http 503/);
});

test("control-plane reads retry 429 with Retry-After while exec is never retried", async () => {
  const h = await sandbox.provision(layers);
  fake.failNext(429, { headers: { "retry-after": "0" }, match: (c) => c.path.endsWith("/check") });
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, true);
  assert.equal(status.guestResponsive, true);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/check")).length, 2);

  const before = fake.execScripts().length;
  fake.stallAfterRun(h.id);
  await assert.rejects(sandbox.run(h, "echo hi"), /connection reset/);
  assert.equal(fake.execScripts().length, before + 1);

  for (let i = 1; i <= 4; i++)
    fake.failNext(503, {
      headers: { "retry-after": "0", "x-request-id": `req-${i}` },
      match: (c) => c.method === "DELETE",
    });
  await assert.rejects(sandbox.destroyScope!(scope), /sprites delete .*injected 503/);
});

test("control retries share an elapsed-time budget across backoff and SDK requests", async () => {
  let calls = 0;
  await assert.rejects(
    retrySpritesControl(async () => {
      calls++;
      throw new APIError("rate limited", { statusCode: 429, retryAfterHeader: 30 });
    }, 30),
    { name: "TimeoutError" },
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retrySpritesControl(async () => {
      calls++;
      if (calls === 1) throw new APIError("unavailable", { statusCode: 503, retryAfterHeader: 0 });
      return new Promise((resolve) => setTimeout(() => resolve("late response"), 100));
    }, 30),
    { name: "TimeoutError" },
  );
  assert.equal(calls, 2);
});

for (const outcome of ["healthy", "unknown", "403", "503"]) {
  test(`refused restart with ${outcome} health observation never rolls back newer files`, async () => {
    const h = await sandbox.provision(layers);
    await sandbox.writeFile(h, "ledger", "old");
    await sandbox.teardown(h);
    await sandbox.writeFile(h, "ledger", "new");
    fake.refuseRestart(h.id);
    if (outcome === "healthy" || outcome === "unknown") fake.health(h.id, outcome, "machine is running");
    else
      for (let i = 0; i < (outcome === "503" ? 4 : 1); i++)
        fake.failNext(Number(outcome), { headers: { "retry-after": "0" }, match: (c) => c.path.endsWith("/check") });
    await assert.rejects(sandbox.restartComputer!(scope), /no checkpoint was restored/);
    assert.equal(await sandbox.readFile(h, "ledger"), "new");
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/restore")).length, 0);
  });
}

test("failed hydration and failed deletion remain pending across adapters without overwriting the saved home", async () => {
  const snapshots = createMemorySnapshotStore();
  const initializationStore = createMemoryMap<{ pending: boolean }>();
  const advisoryLock = createMemoryAdvisoryLock();
  let failOpen = false;
  let opens = 0;
  const wrapped = {
    ...snapshots,
    open: async (id: string) => {
      opens++;
      if (failOpen) throw new Error("snapshot unavailable");
      return snapshots.open(id);
    },
  };
  const options = { snapshots: wrapped, initializationStore, advisoryLock };
  const a = make(options);
  const h = await a.provision(layers);
  await a.writeFile(h, "ledger", "saved");
  await a.destroyScope!(scope);
  failOpen = true;
  fake.refuseDelete(403);
  await assert.rejects(a.provision(layers), /snapshot unavailable/);
  assert.deepEqual(await initializationStore.get(h.id), { pending: true });
  const b = make(options);
  await assert.rejects(b.persistHomeSnapshot!(scope), /initialization is incomplete/);
  await assert.rejects(b.restartComputer!(scope), /initialization is incomplete/);
  const before = opens;
  await assert.rejects(b.provision(layers), /snapshot unavailable/);
  assert.equal(opens, before + 1);
  failOpen = false;
  fake.refuseDelete();
  const restored = await make(options).provision(layers);
  assert.equal(await b.readFile(restored, "ledger"), "saved");
  assert.equal(await initializationStore.get(h.id), null);
});
