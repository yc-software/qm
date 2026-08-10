import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox, spriteScopeName } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions, supportsBlobStaging } from "../src/sandbox/sandbox.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeSprites, FAKE_SPRITES_TOKEN, type FakeSprites } from "./support/fake-sprites.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeSprites;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSpritesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "sprites-ws-"))), {
    token: FAKE_SPRITES_TOKEN,
    namePrefix: "qmt",
    client: fake.client,
    fetchImpl: fake.fetchImpl,
    ...extra,
  });
}

beforeEach(() => {
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
  const a = spriteScopeName("qmt", "person:tester");
  assert.equal(a, spriteScopeName("qmt", "person:tester"));
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
  assert.ok(h.env?.HTTPS_PROXY?.includes("proxy.example.com"));
  assert.ok(h.env?.HTTPS_PROXY?.includes(token));
  assert.equal(h.env?.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("force-through strips agent-supplied proxy vars", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token, env: { HTTPS_PROXY: "http://evil:1", FOO: "keep" } });
  assert.ok(!h.env?.HTTPS_PROXY?.includes("evil"));
  assert.equal(h.env?.FOO, "keep");
});

test("force-through fails closed if the policy readback doesn't bind", async () => {
  const brokenFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname.endsWith("/policy/network") && (init?.method ?? "GET") === "GET") {
      return Response.json({ rules: [] });
    }
    return fake.fetchImpl(input, init);
  };
  const s = make({ egressProxyUrl: "https://proxy.example.com", fetchImpl: brokenFetch });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  await assert.rejects(s.provision(layers, { egressToken: token }), /readback mismatch/);
});

test("teardown is a no-op park; destroy deletes the sprite", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.ok(fake.names().includes(h.id));
  await sandbox.teardown(h, { destroy: true });
  assert.ok(!fake.names().includes(h.id));
});

test("backupComputer tars workspace + home over the exec channel (the publish fast path)", async () => {
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

test("backupComputer keepContentCaches ships cache-named build output (publish parity)", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "mkdir -p site/.cache && printf real > site/.cache/bundle.js");
  const got = await sandbox.backupComputer!(h, {
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
  await assert.rejects(() => sb.stageOut!(h, "outbox/big.bin"), /sprites stageOut/);

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

test("restartComputer reboots the scope's sprite and heals a wedged exec channel", async () => {
  const h = await sandbox.provision(layers);
  fake.fail502(h.id);
  await assert.rejects(sandbox.run(h, "echo back"), /http 502/);

  await sandbox.restartComputer!(scope);
  assert.deepEqual(fake.restarts(), [h.id]);

  const after = await sandbox.run(h, "echo back");
  assert.equal(after.code, 0);
  assert.equal(after.stdout.trim(), "back");
});

test("computerStatus reports a healthy machine whose shell has stopped answering", async () => {
  const h = await sandbox.provision(layers);
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "healthy", guestResponsive: true });

  fake.fail502(h.id);
  assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "healthy", guestResponsive: false });
});

test("restartComputer surfaces a refused restart instead of swallowing it", async () => {
  const h = await sandbox.provision(layers);
  fake.refuseRestart(h.id);
  await assert.rejects(sandbox.restartComputer!(scope), /sprites restart .*: http 502/);
  assert.deepEqual(fake.restarts(), []);
});

test("a command that ran before the response was lost is never re-executed", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, ": > /home/sprite/workspace/ledger");
  fake.stallAfterRun(h.id);

  await assert.rejects(sandbox.run(h, "echo entry >> /home/sprite/workspace/ledger"));

  const ledger = await sandbox.readFile(h, "ledger");
  assert.equal(ledger, "entry\n", "the side effect must have happened exactly once");
});

test("an inline write lands atomically, so a reboot mid-write cannot truncate the target", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "cfg.txt", "value\n");
  assert.equal(await sandbox.readFile(h, "cfg.txt"), "value\n");

  const write = fake.execScripts().find((s) => s.includes("cfg.txt") && s.includes("cat >"));
  assert.ok(write, "expected an inline write script");
  assert.match(write!, /\.part\./, "the payload must land on a temp path");
  assert.match(write!, /mv -f/, "and be renamed over the target, never streamed into it");
});
