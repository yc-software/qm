import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createKeychain, KeychainError, type Keychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  captureDeviceFlowLogins,
  deviceFlowCredOwner,
  materializeDeviceFlowLogins,
  registerLoginPaths,
  removeDeviceFlowLogins,
  DEVICE_FLOW_ORIGIN,
} from "../src/credentials/device-flow-persist.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";

let ff: FakeSprites;
before(() => {
  ff = installGlobalFakeSprites();
});
beforeEach(() => ff.reset());
after(() => ff.cleanup());

const KEY = deriveConnectorKey("device-flow-test-key");

function kc(): Keychain {
  return createKeychain({ creds: createMemoryMap(), grants: createMemoryMap(), asks: createMemoryMap(), key: KEY });
}

function sprites() {
  const dir = mkdtempSync(join(tmpdir(), "dfp-ws-"));
  return createSpritesSandbox(createLocalWorkspaceStore(dir), {
    token: "test-token",
    client: ff.client,
    fetchImpl: ff.fetchImpl,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

function acmecliCredentialLayer(binary?: string, approvals?: Array<{ pattern: string; reason?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "dfp-layer-"));
  mkdirSync(join(dir, "tools/acmecli"), { recursive: true });
  writeFileSync(
    join(dir, "tools/acmecli/tool.json"),
    JSON.stringify({
      id: "acmecli",
      ...(binary ? { install: { binary } } : {}),
      ...(approvals ? { approvals } : {}),
      auth: {
        check: "acmecli me",
        reauth: "acmecli login --use-device-code",
        credentialPaths: [{ path: ".acmecli", kind: "directory" }],
      },
    }),
  );
  return dir;
}

test("deviceFlowCredOwner: the person on their own personal box, the scope on a shared box", () => {
  assert.equal(deviceFlowCredOwner(scopeId("personal", "U1"), "U1"), "U1");
  assert.equal(deviceFlowCredOwner(scopeId("channel", "C1"), "U1"), scopeId("channel", "C1"));
  assert.equal(deviceFlowCredOwner(scopeId("personal", "U2"), "U1"), scopeId("personal", "U2"));
});

test("capture saves changed login bundles per service and fingerprint-skips unchanged ones", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  const login = await sb.run(
    h,
    "mkdir -p ~/.config/gh && printf 'oauth_token: gho_SECRET' > ~/.config/gh/hosts.yml && " +
      "printf 'machine x login y password z' > ~/.netrc",
  );
  assert.equal(login.code, 0, login.stderr);

  const input = { sandbox: sb, handle: h, keychain: k, ownerId: "U1" };
  assert.deepEqual((await captureDeviceFlowLogins(input)).sort(), ["gh", "netrc"]);

  const records = await k.listByOwner("U1");
  const gh = records.find((c) => c.service === "gh");
  assert.equal(gh?.kind, "file");
  assert.deepEqual(gh?.targets, [".config/gh/hosts.yml"]);
  assert.ok(!JSON.stringify(records).includes("gho_SECRET"), "listing carries metadata only");

  assert.deepEqual(await captureDeviceFlowLogins(input), []);

  await sb.run(h, "printf 'oauth_token: gho_ROTATED' > ~/.config/gh/hosts.yml");
  assert.deepEqual(await captureDeviceFlowLogins(input), ["gh"]);
});

test("capture grabs the AWS SSO token under .aws/sso/cache; gcloud's cache/logs bulk dirs are pruned", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  const setup = await sb.run(
    h,
    "mkdir -p ~/.aws/sso/cache ~/.aws/cli/cache ~/.config/gcloud/logs ~/.config/gcloud/cache && " +
      "printf '[profile acme]' > ~/.aws/config && " +
      'printf \'{"accessToken":"sso_SECRET"}\' > ~/.aws/sso/cache/token.json && ' +
      'printf \'{"Credentials":"role_SECRET"}\' > ~/.aws/cli/cache/role.json && ' +
      "printf 'gcloud_creds' > ~/.config/gcloud/credentials.db && " +
      "printf 'noise' > ~/.config/gcloud/logs/run.log && printf 'noise' > ~/.config/gcloud/cache/x.json",
  );
  assert.equal(setup.code, 0, setup.stderr);

  const input = { sandbox: sb, handle: h, keychain: k, ownerId: "U1" };
  assert.deepEqual((await captureDeviceFlowLogins(input)).sort(), ["aws", "gcloud"]);

  const records = await k.listByOwner("U1");
  const aws = records.find((c) => c.service === "aws");
  assert.deepEqual(
    aws?.targets?.slice().sort(),
    [".aws/cli/cache/role.json", ".aws/config", ".aws/sso/cache/token.json"],
    "the SSO token and assumed-role cache rode along, not just .aws/config",
  );
  const gcloud = records.find((c) => c.service === "gcloud");
  assert.deepEqual(
    gcloud?.targets,
    [".config/gcloud/credentials.db"],
    "the real gcloud cred is captured; its cache (discovery docs) and logs bulk dirs are pruned",
  );

  rmSync(ff.homeDir(h.id), { recursive: true, force: true });
  const h2 = await sb.provision(rw(scopeId("personal", "U1")));
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const back = await sb.run(h2, "cat ~/.aws/sso/cache/token.json");
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /sso_SECRET/, "auth survived machine replacement");
});

test("an unregistered ~/.config tool is neither swept nor stored (known services still are)", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(
    h,
    "mkdir -p ~/.config/gh ~/.config/acmecorp && printf 'oauth_token: gho_OK' > ~/.config/gh/hosts.yml && " +
      "printf 'tok_NEWTOOL' > ~/.config/acmecorp/auth.json",
  );
  const skipped: string[] = [];
  const saved = await captureDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s) => skipped.push(s),
  });
  assert.deepEqual(saved, ["gh"], "the known service is captured; the unregistered one is not");
  assert.deepEqual(skipped, [], "an unregistered dir is not swept, so it never trips the caps warning");
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "acmecorp"), "acmecorp was never stored");
});

test("lossless migration only follows device-flow records, not operator-saved credentials", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/opsaved && printf 'operator_secret' > ~/.config/opsaved/auth.json");
  await k.save({
    ownerId: "U1",
    service: "opsaved",
    files: [{ path: ".config/opsaved/auth.json", contentBase64: Buffer.from("op_v0").toString("base64") }],
    origin: "agent-session:personal:U1",
  });

  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }),
    [],
    "an operator/API-saved credential is not adopted into the device-flow sweep and not overwritten",
  );
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "opsaved");
  assert.equal(rec?.origin, "agent-session:personal:U1", "its origin is untouched");
});

test("lossless migration: a service captured before keeps being swept via its record targets", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, "mkdir -p ~/.config/acmecorp && printf 'tok_v1' > ~/.config/acmecorp/auth.json");
  await k.save({
    ownerId: "U1",
    service: "acmecorp",
    files: [{ path: ".config/acmecorp/auth.json", contentBase64: Buffer.from("tok_v0").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });

  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), [
    "acmecorp",
  ]);

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const back = await sb.run(h2, "cat ~/.config/acmecorp/auth.json");
  assert.match(back.stdout, /tok_v1/, "the previously-captured tool's rotated login still rides along");
});

test("pre-XDG holdout: a tool that keeps its login in ~/.<tool> (fly) is captured + restored", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, "mkdir -p ~/.fly && printf 'access_token: fo1_SECRET' > ~/.fly/config.yml");
  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), ["fly"]);

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const back = await sb.run(h2, "cat ~/.fly/config.yml");
  assert.match(back.stdout, /fo1_SECRET/, "a non-XDG holdout's login survived machine replacement");
});

test("large multi-file bundle round-trips intact (past the exec ~16KiB request + ~4MB response caps)", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  const setup =
    "mkdir -p ~/.config/bigtool && " +
    "for i in $(seq 0 29); do head -c 102400 /dev/zero | tr '\\0' 'X' > ~/.config/bigtool/part$i.dat; done && " +
    "printf 'TOKEN_SENTINEL_END' >> ~/.config/bigtool/part29.dat";
  assert.equal((await sb.run(h1, setup)).code, 0);

  const bigInput = {
    sandbox: sb,
    handle: h1,
    keychain: k,
    ownerId: "U1",
    credentialPaths: [{ path: ".config/bigtool", kind: "directory" as const }],
  };
  assert.deepEqual(await captureDeviceFlowLogins(bigInput), ["bigtool"]);
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "bigtool");
  assert.equal(rec?.targets?.length, 30, "every file in the large bundle was captured, none dropped to truncation");

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const check = await sb.run(
    h2,
    'echo "size=$(wc -c < ~/.config/bigtool/part0.dat)"; echo "sentinel=$(tail -c 18 ~/.config/bigtool/part29.dat)"; echo "count=$(ls ~/.config/bigtool | wc -l)"',
  );
  assert.equal(check.code, 0, check.stderr);
  const fields = Object.fromEntries(
    check.stdout
      .trim()
      .split("\n")
      .map((l) => l.split("=").map((s) => s.trim())),
  );
  assert.equal(
    Number(fields.size),
    100 * 1024,
    "a large file restored at full size, not truncated under the write cap",
  );
  assert.equal(fields.sentinel, "TOKEN_SENTINEL_END", "the last file's trailing bytes survived (no silent corruption)");
  assert.equal(Number(fields.count), 30, "every file came back");
});

test("shape backstop: a registered path that balloons past the caps is skipped loudly, not stored", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(
    h,
    "mkdir -p ~/.config/gh ~/.config/bloat && printf 'oauth_token: gho_OK' > ~/.config/gh/hosts.yml && " +
      "for i in $(seq 1 600); do printf x > ~/.config/bloat/f$i; done",
  );
  const skipped: string[] = [];
  const saved = await captureDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    credentialPaths: [{ path: ".config/bloat", kind: "directory" }],
    onAnomaly: (service) => skipped.push(service),
  });
  assert.deepEqual(saved, ["gh"], "the real login still got captured");
  assert.deepEqual(skipped, ["bloat"], "the registered but oversized path was skipped by the caps backstop");
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "bloat"), "and never stored");
});

test("a browser profile under ~/.config no longer trips the capture — neither swept nor warned", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  const setup = await sb.run(
    h,
    "mkdir -p ~/.config/gh ~/.config/chromium-headless/Default && " +
      "printf 'oauth_token: gho_OK' > ~/.config/gh/hosts.yml && " +
      "touch ~/.config/chromium-headless/'Local State' ~/.config/chromium-headless/SingletonLock && " +
      "for i in $(seq 1 700); do printf xxxx > ~/.config/chromium-headless/Default/blob$i; done",
  );
  assert.equal(setup.code, 0, setup.stderr);
  const files = await sb.run(h, "find ~/.config/chromium-headless -type f | wc -l");
  assert.ok(Number(files.stdout.trim()) >= 700, `the browser profile really exists (${files.stdout.trim()} files)`);

  const skipped: string[] = [];
  const saved = await captureDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s) => skipped.push(s),
  });
  assert.deepEqual(saved, ["gh"], "only the real login is captured");
  assert.deepEqual(skipped, [], "no capture-skipped warning — the browser profile was never swept");
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "chromium-headless"), "and never stored");
});

test("materialize round-trip: login → machine replaced → files restored 0600 behind the symlinks", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(
    h1,
    "mkdir -p ~/.config/glab && printf 'token: glpat_SECRET' > ~/.config/glab/config.yml && chmod 600 ~/.config/glab/config.yml",
  );
  await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" });

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });

  const restored = await sb.run(
    h2,
    "cat ~/.config/glab/config.yml && stat -c %a ~/.config/glab/config.yml 2>/dev/null || stat -f %Lp ~/.config/glab/config.yml",
  );
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /glpat_SECRET/);
  assert.match(restored.stdout, /600/);
  const link = await sb.run(h2, "readlink ~/.config/glab >/dev/null && echo islink");
  assert.match(link.stdout, /islink/);
});

test("materialize never overwrites a file already on disk — the live machine's login wins", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_OLD' > ~/.config/gh/hosts.yml");
  await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" });

  await sb.run(h, "printf 'oauth_token: gho_NEWER' > ~/.config/gh/hosts.yml");
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" });
  const read = await sb.run(h, "cat ~/.config/gh/hosts.yml");
  assert.equal(read.stdout, "oauth_token: gho_NEWER");
});

test("a legacy bundle stamped with a past expiresAt (by the deleted refresher) still restores", async () => {
  const sb = sprites();
  const k = kc();
  await k.save({
    ownerId: "U1",
    service: "aws",
    files: [
      { path: ".aws/config", contentBase64: Buffer.from("[default]\nregion=us-west-2", "utf8").toString("base64") },
    ],
    origin: DEVICE_FLOW_ORIGIN,
    expiresAt: Date.now() - 3_600_000,
  });
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" });
  const read = await sb.run(h, "cat ~/.aws/config");
  assert.match(read.stdout, /us-west-2/, "file bundles are durability-only: a stale expiry stamp never blocks restore");
});

test("ACMECLI quarantine removes the canonical root even with no record or a stale partial record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dfp-ws-"));
  const sb = createSpritesSandbox(createLocalWorkspaceStore(dir), {
    token: "test-token",
    client: ff.client,
    fetchImpl: ff.fetchImpl,
    credentialPaths: [{ path: ".acmecli", kind: "directory" }],
  });
  const k = kc();
  const h = await sb.provision(rw(scopeId("channel", "C1")));
  await sb.run(h, "mkdir -p ~/.acmecli && printf live > ~/.acmecli/unrecorded.json");
  await removeDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: scopeId("channel", "C1"),
    services: ["acmecli"],
    canonicalRoots: [".acmecli"],
  });
  assert.equal(
    (await sb.run(h, "test ! -e ~/.acmecli && test ! -e /tmp/agent-creds/.acmecli")).code,
    0,
    "an uncaptured warm-machine login and its resolved ephemeral target are removed",
  );

  await k.save({
    ownerId: scopeId("channel", "C1"),
    service: "acmecli",
    files: [{ path: ".acmecli/known.json", contentBase64: Buffer.from("old").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  await sb.run(h, "mkdir -p ~/.acmecli && printf known > ~/.acmecli/known.json && printf newer > ~/.acmecli/new.json");
  await removeDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: scopeId("channel", "C1"),
    services: ["acmecli"],
    canonicalRoots: [".acmecli"],
  });
  assert.equal(
    (await sb.run(h, "test ! -e ~/.acmecli && test ! -e /tmp/agent-creds/.acmecli")).code,
    0,
    "new files absent from the encrypted record are removed from the ephemeral target too",
  );
});

function freshApp() {
  return buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-app-")),
      signingSecret: "device-flow-test-secret",
    }),
  );
}

const actor = { externalId: "U1" };

function dm(text: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: "dm:U1:t1" }, text };
}

function channel(text: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [actor] },
    text,
  };
}

test("a DM turn auto-captures a device-flow login under the PERSON, and a fresh machine gets it back", async () => {
  const { app, keychain } = freshApp();
  const res = await app.turn(
    dm("!run mkdir -p ~/.config/gh && printf 'oauth_token: gho_E2E' > ~/.config/gh/hosts.yml && echo done"),
  );
  assert.equal(res.status, "ok");

  const records = await keychain!.listByOwner("U1");
  const gh = records.find((c) => c.service === "gh");
  assert.ok(gh, "post-turn capture persisted the login under the actor");
  assert.equal(gh!.kind, "file");

  for (const name of ff.names()) rmSync(ff.homeDir(name), { recursive: true, force: true });
  const back = await app.turn(dm("!run cat ~/.config/gh/hosts.yml"));
  assert.equal(back.status, "ok");
  assert.match(back.reply ?? "", /gho_E2E/, "auth survived machine replacement");
});

test("a login performed on a shared channel box is keyed to the SCOPE, like its workspace", async () => {
  const { app, keychain } = freshApp();
  const res = await app.turn(
    channel("!run mkdir -p ~/.config/glab && printf 'token: glpat_CH' > ~/.config/glab/config.yml && echo done"),
  );
  assert.equal(res.status, "ok", res.reason);

  assert.equal((await keychain!.listByOwner("U1")).length, 0, "no personal record from a channel turn");
  const scoped = await keychain!.listByOwner(scopeId("channel", "C1"));
  assert.equal(scoped.find((c) => c.service === "glab")?.kind, "file");
});

test("a capture failure is logged as an error event and does NOT fail the turn", async () => {
  const { app, keychain, errors } = freshApp();
  const realSave = keychain!.save.bind(keychain!);
  keychain!.save = async () => {
    throw new Error("injected keychain outage");
  };
  const res = await app.turn(
    dm("!run mkdir -p ~/.config/gh && printf 'oauth_token: gho_X' > ~/.config/gh/hosts.yml && echo done"),
  );
  assert.equal(res.status, "ok", "capture is best-effort — the turn still succeeds");
  const logged = (await errors.list()).find((e) => e.code === "device_flow_capture_failed");
  assert.ok(logged, "the failure is durably visible to operators");

  keychain!.save = realSave;
  const retry = await app.turn(dm("!run echo retry"));
  assert.equal(retry.status, "ok");
  assert.ok((await keychain!.listByOwner("U1")).some((c) => c.service === "gh"));
});

test("removing platform credential vending preserves stored quarantine on personal and shared sandboxes", async () => {
  for (const shared of [false, true]) {
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "dfp-quarantine-")),
        signingSecret: "device-flow-test-secret",
        deploymentLayerDir: acmecliCredentialLayer(),
      }),
    );
    const request = shared ? channel("!run echo ready") : dm("!run echo ready");
    const ownerId = shared ? scopeId("channel", "C1") : "U1";
    const targetScope = shared ? scopeId("channel", "C1") : scopeId("personal", "U1");
    await built.keychain!.save({
      ownerId,
      service: "acmecli",
      files: [{ path: ".acmecli/session.json", contentBase64: Buffer.from("stored-login").toString("base64") }],
      origin: DEVICE_FLOW_ORIGIN,
    });
    const read = "!run cat ~/.acmecli/session.json";
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "stored-login");
    await built.deviceFlowCutover.set(targetScope, "acmecli", "ephemeral_only", "security@example.com");
    const hidden = await built.app.turn({
      ...request,
      text: "!run test -e ~/.acmecli/session.json && echo found || echo absent",
    });
    assert.equal(hidden.reply, "absent");
    assert.ok((await built.keychain!.listByOwner(ownerId)).some((record) => record.service === "acmecli"));
    await built.deviceFlowCutover.set(targetScope, "acmecli", "legacy", "security@example.com");
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "stored-login");
  }
});

test("capture never clobbers an operator-saved record for a swept service", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_BOX' > ~/.config/gh/hosts.yml");
  await k.save({
    ownerId: "U1",
    service: "gh",
    files: [
      { path: ".config/gh/hosts.yml", contentBase64: Buffer.from("oauth_token: gho_OPERATOR").toString("base64") },
    ],
    origin: "agent-session:personal:U1",
  });

  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }), []);
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "gh");
  assert.equal(rec?.origin, "agent-session:personal:U1", "the operator's record and origin survive capture");
});

test("a shared-box capture sweeps only the scope owner's roots, never another person's registrations", async () => {
  const sb = sprites();
  const k = kc();
  const shared = scopeId("channel", "C1");
  const h = await sb.provision(rw(shared));
  await sb.run(h, "mkdir -p ~/.config/acmecorp && printf 'tok_ROTATED' > ~/.config/acmecorp/auth.json");
  await k.save({
    ownerId: "U1",
    service: "acmecorp",
    files: [{ path: ".config/acmecorp/auth.json", contentBase64: Buffer.from("tok_v0").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });

  const saved = await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: shared });
  assert.deepEqual(saved, [], "a person's private registration does not widen what a shared box exfiltrates");
  assert.ok(!(await k.listByOwner(shared)).some((c) => c.service === "acmecorp"), "nothing saved under the scope");
});

test("a registered file under an already-swept dotdir is not tarred twice", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, 'mkdir -p ~/.aws/sso/cache && printf \'{"accessToken":"sso_X"}\' > ~/.aws/sso/cache/token.json');
  await k.save({
    ownerId: "U1",
    service: "aws",
    files: [{ path: ".aws/sso/cache/token.json", contentBase64: Buffer.from("old").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });

  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }), ["aws"]);
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "aws");
  assert.deepEqual(rec?.targets, [".aws/sso/cache/token.json"], "one entry, not a find+file-loop duplicate");

  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }),
    [],
    "an unchanged box fingerprints clean on the very next capture — no duplicate-entry churn",
  );
});

test("keychain.save with expectedOrigin atomically refuses to overwrite a foreign-origin record", async () => {
  const k = kc();
  await k.save({
    ownerId: "U1",
    service: "tool",
    files: [{ path: ".config/tool/auth.json", contentBase64: Buffer.from("operator").toString("base64") }],
    origin: "agent-session:personal:U1",
  });
  await assert.rejects(
    k.save({
      ownerId: "U1",
      service: "tool",
      files: [{ path: ".config/tool/auth.json", contentBase64: Buffer.from("box").toString("base64") }],
      origin: DEVICE_FLOW_ORIGIN,
      expectedOrigin: DEVICE_FLOW_ORIGIN,
    }),
    /already exists/,
  );
  await k.save({
    ownerId: "U1",
    service: "fresh",
    files: [{ path: ".config/fresh/auth.json", contentBase64: Buffer.from("v1").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
    expectedOrigin: DEVICE_FLOW_ORIGIN,
  });
  await k.save({
    ownerId: "U1",
    service: "fresh",
    files: [{ path: ".config/fresh/auth.json", contentBase64: Buffer.from("v2").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
    expectedOrigin: DEVICE_FLOW_ORIGIN,
  });
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "fresh");
  assert.equal(rec?.origin, DEVICE_FLOW_ORIGIN, "a device-flow record updates freely under the precondition");
});

test("registered roots beyond the cap are dropped with one anomaly, after collapsing covered roots", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  for (let i = 0; i < 70; i++) {
    await k.save({
      ownerId: "U1",
      service: `svc${i}`,
      files: [{ path: `.config/svc${i}/a/auth.json`, contentBase64: Buffer.from(`t${i}`).toString("base64") }],
      origin: DEVICE_FLOW_ORIGIN,
    });
  }
  for (let i = 0; i < 5; i++) {
    await k.save({
      ownerId: "U1",
      service: "aws",
      files: [{ path: ".aws/sso/cache/token.json", contentBase64: Buffer.from("x").toString("base64") }],
      origin: DEVICE_FLOW_ORIGIN,
    });
  }
  const anomalies: string[] = [];
  await captureDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s, d) => anomalies.push(`${s}: ${d}`),
  });
  assert.equal(anomalies.length, 1, "exactly one truncation anomaly");
  assert.match(anomalies[0]!, /capture-sweep: 6 services past the 64-root sweep cap were not captured/);
});

test("the cap drops whole services, never a subset of one record's files", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  const paths = Array.from({ length: 70 }, (_, i) => `.tool/f${i}.json`);
  await sb.run(h, "mkdir -p ~/.tool && " + paths.map((p) => `printf x > ~/${p}`).join(" && "));
  await k.save({
    ownerId: "U1",
    service: "tool",
    files: paths.map((p) => ({ path: p, contentBase64: Buffer.from("v0").toString("base64") })),
    origin: DEVICE_FLOW_ORIGIN,
  });

  const anomalies: string[] = [];
  const saved = await captureDeviceFlowLogins({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s, d) => anomalies.push(`${s}: ${d}`),
  });
  assert.deepEqual(saved, [], "a single record whose files exceed the cap is skipped whole, not saved shrunk");
  assert.equal((await k.listByOwner("U1")).find((c) => c.service === "tool")?.targets?.length, 70, "record intact");
  assert.match(anomalies.join("\n"), /services past the 64-root sweep cap were not captured: tool/);
});

test("register_login captures a real CLI login and it survives a machine rebuild", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, 'mkdir -p ~/.kaggle && printf \'{"username":"u","key":"kag_SECRET"}\' > ~/.kaggle/kaggle.json');

  const result = await registerLoginPaths({
    sandbox: sb,
    handle: h1,
    keychain: k,
    ownerId: "U1",
    service: "kaggle",
    paths: [{ path: ".kaggle/kaggle.json", kind: "file" }],
  });
  assert.deepEqual(result, { service: "kaggle", captured: true });
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "kaggle");
  assert.deepEqual(rec?.capturePaths, [{ path: ".kaggle/kaggle.json", kind: "file" }]);
  assert.ok(!JSON.stringify(await k.listByOwner("U1")).includes("kag_SECRET"), "metadata only in the listing");

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const back = await sb.run(h2, "cat ~/.kaggle/kaggle.json");
  assert.match(back.stdout, /kag_SECRET/, "the registered login is restored on a fresh machine");
});

test("a registered service keeps being swept — a later rotation is captured without re-registering", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/rotato && printf 'refresh_v1' > ~/.config/rotato/creds");
  await registerLoginPaths({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    service: "rotato",
    paths: [{ path: ".config/rotato", kind: "directory" }],
  });

  await sb.run(h, "printf 'refresh_v2_ROTATED' > ~/.config/rotato/creds");
  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }), ["rotato"]);
});

test("register_login rejects paths outside the service, built-in overlaps, and missing files", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  const base = { sandbox: sb, handle: h, keychain: k, ownerId: "U1" };

  await assert.rejects(
    registerLoginPaths({ ...base, service: "aws", paths: [{ path: ".aws/sso/cache", kind: "directory" }] }),
    /overlaps the built-in/,
  );
  await assert.rejects(
    registerLoginPaths({ ...base, service: "ghost", paths: [{ path: "../escape", kind: "file" }] }),
    /under \$HOME/,
  );
  await sb.run(h, "true");
  await assert.rejects(
    registerLoginPaths({ ...base, service: "absent", paths: [{ path: ".absent/creds", kind: "file" }] }),
    /nothing to capture|nothing was captured/,
  );
});

test("register_login refuses to adopt a service already owned by an operator/API save", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.opstool && printf 'x' > ~/.opstool/creds");
  await k.save({
    ownerId: "U1",
    service: "opstool",
    files: [{ path: ".opstool/creds", contentBase64: Buffer.from("op").toString("base64") }],
    origin: "agent-session:personal:U1",
  });
  await assert.rejects(
    registerLoginPaths({
      sandbox: sb,
      handle: h,
      keychain: k,
      ownerId: "U1",
      service: "opstool",
      paths: [{ path: ".opstool/creds", kind: "file" }],
    }),
    /not created by a login capture/,
  );
});

test("register_login handles a .cache/<tool> layout and re-captures rotations under the declared service", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.cache/huggingface && printf 'hf_v1' > ~/.cache/huggingface/token");
  const reg = await registerLoginPaths({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    service: "huggingface",
    paths: [{ path: ".cache/huggingface/token", kind: "file" }],
  });
  assert.deepEqual(reg, { service: "huggingface", captured: true });
  const rec = (await k.listByOwner("U1")).find((c) => c.service === "huggingface");
  assert.deepEqual(rec?.targets, [".cache/huggingface/token"], "filed under the declared service, not '.cache'");
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "cache"), "no bogus 'cache' service record");

  await sb.run(h, "printf 'hf_v2_ROTATED' > ~/.cache/huggingface/token");
  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: sb, handle: k && h, keychain: k, ownerId: "U1" }),
    ["huggingface"],
    "a plain re-capture groups the rotation under the registered service via its stored capturePaths",
  );
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "cache"), "still no 'cache' record after rotation");
});

test("capture-on-change: an unchanged box ships nothing — gated by the box-side hash, not just the fingerprint", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_V1' > ~/.config/gh/hosts.yml");
  const input = { sandbox: sb, handle: h, keychain: k, ownerId: "U1" };
  assert.deepEqual(await captureDeviceFlowLogins(input), ["gh"]);
  const state = await sb.run(h, "cat ~/.cred-state");
  assert.equal(state.code, 0, "the committed per-service hash state exists after a successful capture");
  assert.match(state.stdout, /^gh\t/m);

  const rec = (await k.listByOwner("U1")).find((c) => c.service === "gh")!;
  await k.remove("U1", rec.id);
  assert.deepEqual(
    await captureDeviceFlowLogins(input),
    [],
    "unchanged box ships nothing even with the record gone — proof the gate is the box-side hash",
  );

  await sb.run(h, "printf 'oauth_token: gho_V2' > ~/.config/gh/hosts.yml");
  assert.deepEqual(await captureDeviceFlowLogins(input), ["gh"], "a real change ships and re-creates the record");
});

test("capture-on-change: a rebuilt box (no state file) re-ships everything", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, "mkdir -p ~/.fly && printf 'access_token: fo1_X' > ~/.fly/config.yml");
  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), ["fly"]);

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  await sb.run(h2, "printf 'access_token: fo1_ROTATED' > ~/.fly/config.yml");
  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" }),
    ["fly"],
    "with no state file the fresh box ships, and the rotation lands",
  );
});

test("restore preserves each file's captured mode, defaulting old records to 0600", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(
    h1,
    "mkdir -p ~/.modes && printf 'secret' > ~/.modes/tight && chmod 600 ~/.modes/tight && " +
      "printf 'shared-config' > ~/.modes/open && chmod 644 ~/.modes/open && " +
      "printf '#!/bin/sh' > ~/.modes/hook && chmod 700 ~/.modes/hook",
  );
  await registerLoginPaths({
    sandbox: sb,
    handle: h1,
    keychain: k,
    ownerId: "U1",
    service: "modes",
    paths: [{ path: ".modes", kind: "directory" }],
  });

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const modes = await sb.run(h2, "stat -c '%a %n' ~/.modes/* 2>/dev/null || stat -f '%Lp %N' ~/.modes/*");
  assert.match(modes.stdout, /600 .*tight/, "the 0600 credential stays 0600 (deployctl/kaggle tamper checks)");
  assert.match(modes.stdout, /600 .*open/, "group/other bits are stripped on restore — the mode floor policy");
  assert.match(modes.stdout, /700 .*hook/, "owner-exec is preserved through the floor");
});

test("a failed mid-bundle restore rolls back that bundle's files instead of leaving a partial set", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(
    h1,
    "mkdir -p ~/.aws/sso/cache ~/.aws/cli/cache && printf 'a' > ~/.aws/sso/cache/a.json && " +
      "printf 'b' > ~/.aws/cli/cache/b.json && printf 'c' > ~/.aws/config",
  );
  await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" });

  await sb.run(h1, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_OK' > ~/.config/gh/hosts.yml");
  await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" });

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await sb.run(h2, "mkdir -p ~/.aws && printf 'blocking' > ~/.aws/sso");
  const anomalies: string[] = [];
  const restored = await materializeDeviceFlowLogins({
    sandbox: sb,
    handle: h2,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s, d) => anomalies.push(`${s}: ${d}`),
  });
  assert.deepEqual(restored.slice().sort(), ["gh"], "the healthy bundle restores even when a sibling bundle fails");
  assert.match(anomalies.join("\n"), /aws: restore failed mid-bundle/);
  const leftover = await sb.run(h2, "find ~/.aws -type f 2>/dev/null | grep -v '/sso$' | wc -l");
  assert.equal(leftover.stdout.trim(), "0", "no partial multi-file set is left behind");

  await sb.run(h2, "rm -f ~/.aws/sso");
  const clean = await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  assert.deepEqual(clean, ["aws"], "a later healthy restore brings the whole set");
});

test("a root that mutates during the tar is reported volatile and its service is skipped this turn", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_MIDWRITE' > ~/.config/gh/hosts.yml");
  const volatileSb = {
    ...sb,
    run: async (handle: unknown, cmd: string, opts?: unknown) => {
      const result = await sb.run(handle as never, cmd, opts as never);
      if (cmd.includes(".cred-capture-")) return { ...result, stdout: `${result.stdout}VOLATILE\tgh\n` };
      return result;
    },
  };
  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: volatileSb as never, handle: h, keychain: k, ownerId: "U1" }),
    [],
    "a torn snapshot is never saved",
  );
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "gh"));

  assert.deepEqual(
    await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }),
    ["gh"],
    "the next quiet turn captures it cleanly",
  );
});

test("~/.netrc: whole-file capture keeps every tool's entries, and a live machine's copy is never clobbered", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(
    h1,
    "printf 'machine api.wandb.ai\\n  login user\\n  password wandb_KEY\\nmachine api.heroku.com\\n  login u@x\\n  password heroku_TOK\\n' > ~/.netrc && chmod 600 ~/.netrc",
  );
  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), ["netrc"]);

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const restored = await sb.run(h2, "cat ~/.netrc");
  assert.match(restored.stdout, /wandb_KEY/, "wandb's entry survived the rebuild");
  assert.match(restored.stdout, /heroku_TOK/, "heroku's entry survived in the same file");

  await sb.run(h2, "printf 'machine api.wandb.ai\\n  login user\\n  password wandb_NEWER\\n' > ~/.netrc");
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const kept = await sb.run(h2, "cat ~/.netrc");
  assert.match(kept.stdout, /wandb_NEWER/, "a live machine's .netrc is never clobbered by restore");
  assert.doesNotMatch(kept.stdout, /heroku_TOK/, "restore did not merge stale entries over the live file");
});

test("a squatted quarantine dir makes capture fail LOUDLY, never silently skip", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(
    h,
    "rm -rf ~/.agent-displaced && printf squat > ~/.agent-displaced && mkdir -p ~/.config/gh && printf 'oauth_token: gho_X' > ~/.config/gh/hosts.yml",
  );
  await assert.rejects(
    captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" }),
    /workspace unavailable|write .* failed/,
  );
});

test("old-name debris (.agent-cred-*) is reaped by the next capture", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(
    h,
    "printf stale > ~/.agent-cred-state && printf leak > ~/.agent-cred-capture.abc123 && " +
      "mkdir -p ~/.config/gh && printf 'oauth_token: gho_X' > ~/.config/gh/hosts.yml",
  );
  await captureDeviceFlowLogins({ sandbox: sb, handle: h, keychain: k, ownerId: "U1" });
  const left = await sb.run(h, "ls ~/.agent-cred-* 2>/dev/null | wc -l");
  assert.equal(left.stdout.trim(), "0", "legacy scratch and state files are removed");
});

test("a static sweep anomaly fires once, not on every subsequent capture", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.config/gh && printf 'oauth_token: gho_X' > ~/.config/gh/hosts.yml");
  await k.save({
    ownerId: "U1",
    service: "weird",
    files: [{ path: ".weird/has space/tok", contentBase64: Buffer.from("x").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  const anomalies: string[] = [];
  const input = {
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    onAnomaly: (s: string, d: string) => anomalies.push(`${s}: ${d}`),
  };
  await captureDeviceFlowLogins(input);
  const afterFirst = anomalies.length;
  assert.ok(afterFirst >= 1, "the unsweepable stored path is reported");
  await captureDeviceFlowLogins(input);
  assert.equal(anomalies.length, afterFirst, "the identical static condition is not re-reported next turn");
});

test("register_login under a cap-blown fixed dotdir is allowed until the auto service actually persists", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.cargo && printf 'crates_TOKEN' > ~/.cargo/credentials.toml");

  const result = await registerLoginPaths({
    sandbox: sb,
    handle: h,
    keychain: k,
    ownerId: "U1",
    service: "crates",
    paths: [{ path: ".cargo/credentials.toml", kind: "file" }],
  });
  assert.deepEqual(
    result,
    { service: "crates", captured: true },
    "no cargo record exists, so the sweep is not covering it",
  );

  await k.save({
    ownerId: "U2",
    service: "cargo",
    files: [{ path: ".cargo/credentials.toml", contentBase64: Buffer.from("x").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  const h2 = await sb.provision(rw(scopeId("personal", "U2")));
  await sb.run(h2, "mkdir -p ~/.cargo && printf 'y' > ~/.cargo/credentials.toml");
  await assert.rejects(
    registerLoginPaths({
      sandbox: sb,
      handle: h2,
      keychain: k,
      ownerId: "U2",
      service: "crates",
      paths: [{ path: ".cargo/credentials.toml", kind: "file" }],
    }),
    /already captured automatically as "cargo"/,
  );
});

test("register_login refuses capture bookkeeping paths", async () => {
  const sb = sprites();
  const k = kc();
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "printf 'notacred' > ~/.cred-state");
  await assert.rejects(
    registerLoginPaths({
      sandbox: sb,
      handle: h,
      keychain: k,
      ownerId: "U1",
      service: "sneaky",
      paths: [{ path: ".cred-state", kind: "file" }],
    }),
    /capture bookkeeping/,
  );
});

test("a concurrent-save race skips that service and retries it on the next capture", async () => {
  const sb = sprites();
  const k = kc();
  const anomalies: string[] = [];
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  await sb.run(h, "mkdir -p ~/.racy ~/.calm && printf 'r1' > ~/.racy/creds && printf 'c1' > ~/.calm/creds");
  const base = { sandbox: sb, handle: h, keychain: k, ownerId: "U1" };
  await registerLoginPaths({ ...base, service: "racy", paths: [{ path: ".racy/creds", kind: "file" }] });
  await registerLoginPaths({ ...base, service: "calm", paths: [{ path: ".calm/creds", kind: "file" }] });

  await sb.run(h, "printf 'r2_ROTATED' > ~/.racy/creds && printf 'c2_ROTATED' > ~/.calm/creds");
  const realSave = k.save.bind(k);
  let raced = false;
  k.save = async (input) => {
    if (input.service === "racy" && !raced) {
      raced = true;
      throw new KeychainError(503, "credential for racy is being written concurrently — retry");
    }
    return realSave(input);
  };
  const first = await captureDeviceFlowLogins({ ...base, onAnomaly: (s, d) => anomalies.push(`${s}: ${d}`) });
  assert.deepEqual(first, ["calm"], "the raced service is skipped, the rest of the sweep continues");
  assert.match(anomalies.join("\n"), /racy: keychain write raced a concurrent save/);

  const second = await captureDeviceFlowLogins(base);
  assert.deepEqual(second, ["racy"], "the raced service re-ships and saves on the next capture");
});

test("removed layer tools retain quarantine, capture exclusion and reset-to-legacy", async () => {
  for (const shared of [false, true]) {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "dfp-removed-tool-")), signingSecret: "test" }),
    );
    assert.equal(built.credentialTools.length, 0);
    const request = shared ? channel("!run echo ready") : dm("!run echo ready");
    const ownerId = shared ? scopeId("channel", "C1") : "U1";
    const targetScope = shared ? scopeId("channel", "C1") : scopeId("personal", "U1");
    await built.keychain!.save({
      ownerId,
      service: "retired",
      files: [{ path: ".retired/session", contentBase64: Buffer.from("stored-login").toString("base64") }],
      origin: DEVICE_FLOW_ORIGIN,
    });
    const read = "!run cat ~/.retired/session";
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "stored-login");
    await built.deviceFlowCutover.set(targetScope, "retired", "ephemeral_only", "admin");
    assert.equal(
      (await built.app.turn({ ...request, text: "!run test -e ~/.retired/session && echo found || echo absent" }))
        .reply,
      "absent",
    );
    await built.app.turn({ ...request, text: "!run mkdir -p ~/.retired && printf tampered > ~/.retired/session" });
    const stored = (await built.keychain!.listByOwner(ownerId)).find((record) => record.service === "retired")!;
    const files = await built.keychain!.materializeOwn(ownerId);
    assert.equal(files.length, 0);
    assert.ok(stored);
    await built.deviceFlowCutover.set(targetScope, "retired", "prefer_ephemeral", "admin");
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "tampered");
    await built.deviceFlowCutover.clear(targetScope, "retired");
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "stored-login");
    await built.deviceFlowCutover.set(targetScope, "retired", "ephemeral_only", "admin");
    await built.deviceFlowCutover.set(targetScope, "retired", "legacy", "admin");
    assert.equal((await built.app.turn({ ...request, text: read })).reply, "stored-login");
  }
});
