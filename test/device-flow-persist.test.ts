import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createKeychain, type Keychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  captureDeviceFlowLogins,
  deviceFlowCredOwner,
  materializeDeviceFlowLogins,
  removeDeviceFlowLogins,
  DEVICE_FLOW_ORIGIN,
} from "../src/credentials/device-flow-persist.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { createAwsRoleBroker } from "../src/auth/aws-role-broker.ts";

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

function acmecliBrokeredLayer(binary?: string, approvals?: Array<{ pattern: string; reason?: string }>): string {
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
        broker: {
          kind: "aws-role",
          roleArnEnv: "TEST_BROKER_ROLE_ARN",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
        },
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

test("personal ephemeral-only credentials run only through credential_exec and are redacted", async () => {
  let assumes = 0;
  const sentinels = {
    access: "AKIA_CREDENTIAL_EXEC_SENTINEL",
    secret: "credential_exec_secret_sentinel",
    token: "credential_exec_session_sentinel",
  };
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-credential-exec-")),
      signingSecret: "device-flow-test-secret",
      deploymentLayerDir: acmecliBrokeredLayer("env"),
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole: async () => {
            assumes++;
            return {
              Credentials: {
                AccessKeyId: sentinels.access,
                SecretAccessKey: sentinels.secret,
                SessionToken: sentinels.token,
                Expiration: new Date(Date.now() + 3_600_000),
              },
            };
          },
        }),
      },
    },
  );
  const personal = scopeId("personal", actor.externalId);
  const conversation = {
    kind: "dm" as const,
    threadRef: "dm:credential-exec",
    audience: [actor],
  };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");
  const ambient = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: "!run printf '%s' \"${AWS_ACCESS_KEY_ID-unset}\"",
  });
  assert.equal(ambient.reply, "unset");
  assert.equal(assumes, 0);
  const direct = await built.app.turn({ surface: "slack", actor, conversation, text: "!run env" });
  assert.match(`${direct.reason ?? ""} ${direct.reply ?? ""}`, /credential_exec/);
  const brokered = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: "!credential acmecli []",
  });
  assert.equal(assumes, 1);
  assert.match(brokered.reply ?? "", /<redacted:AWS_ACCESS_KEY_ID>/);
  assert.match(brokered.reply ?? "", /<redacted:AWS_SECRET_ACCESS_KEY>/);
  assert.match(brokered.reply ?? "", /<redacted:AWS_SESSION_TOKEN>/);
  for (const value of Object.values(sentinels)) assert.doesNotMatch(brokered.reply ?? "", new RegExp(value));
  const durable = JSON.stringify(await built.sessions.getEntries(brokered.sessionId!));
  for (const value of Object.values(sentinels)) assert.doesNotMatch(durable, new RegExp(value));
  assert.equal(
    ff.names().some((name) => name.includes("credential-exec")),
    false,
  );
});

test("credential_exec honors deployment approval rules before vending credentials", async () => {
  let assumes = 0;
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-credexec-approval-")),
      signingSecret: "device-flow-test-secret",
      deploymentLayerDir: acmecliBrokeredLayer("env", [
        { pattern: "\\benv\\b\\s+tool\\b", reason: "mutating subcommand" },
      ]),
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole: async () => {
            assumes++;
            return {
              Credentials: {
                AccessKeyId: "AKIA_APPROVAL_GATE",
                SecretAccessKey: "approval_gate_secret_value",
                SessionToken: "approval_gate_session_token",
                Expiration: new Date(Date.now() + 3_600_000),
              },
            };
          },
        }),
      },
    },
  );
  const personal = scopeId("personal", actor.externalId);
  const conversation = { kind: "dm" as const, threadRef: "dm:credexec-approval", audience: [actor] };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");

  const gated = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: '!credential acmecli ["tool","delete"]',
  });
  assert.equal(gated.status, "pending_approval");
  assert.equal(assumes, 0, "no AssumeRole call happens for a blocked command");
  const pending = gated.pendingApprovals![0]!;
  assert.match(pending.reason, /mutating subcommand/);

  const approved = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: '!credential acmecli ["tool","delete"]',
    approval: { requestId: pending.requestId, approved: true },
  });
  assert.equal(approved.status, "ok", approved.reason);
  assert.equal(assumes, 1, "approval unblocks exactly one vended invocation");

  const unrelated = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "dm:credexec-approval-3" },
    text: '!credential acmecli ["me"]',
  });
  assert.equal(unrelated.status, "ok", "subcommands without approval rules run without a grant");
  assert.equal(assumes, 1, "the broker's per-actor credential cache is reused within its TTL");
});

test("a scope allow rule cannot override the ephemeral_only direct-execution deny", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-credexec-scope-allow-")),
      signingSecret: "device-flow-test-secret",
      deploymentLayerDir: acmecliBrokeredLayer("env"),
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole: async () => ({
            Credentials: {
              AccessKeyId: "AKIA_SCOPE_ALLOW",
              SecretAccessKey: "scope_allow_secret_value",
              SessionToken: "scope_allow_session_token",
              Expiration: new Date(Date.now() + 3_600_000),
            },
          }),
        }),
      },
    },
  );
  const personal = scopeId("personal", actor.externalId);
  built.config.setCommandPolicy(personal, {
    mode: "denylist",
    rules: [{ pattern: "\\benv\\b", decision: "allow" }],
  });
  const conversation = { kind: "dm" as const, threadRef: "dm:credexec-scope-allow", audience: [actor] };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");

  const direct = await built.app.turn({ surface: "slack", actor, conversation, text: "!run env" });
  assert.match(`${direct.reason ?? ""} ${direct.reply ?? ""}`, /credential_exec/);

  const sanctioned = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "dm:credexec-scope-allow-2" },
    text: "!credential acmecli []",
  });
  assert.equal(sanctioned.status, "ok", sanctioned.reason);
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

test("free coverage: a never-seen tool that follows the ~/.config convention is captured + restored", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, "mkdir -p ~/.config/acmecorp && printf 'tok_NEWTOOL' > ~/.config/acmecorp/auth.json");
  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), [
    "acmecorp",
  ]);

  rmSync(ff.homeDir(h1.id), { recursive: true, force: true });
  const h2 = await sb.provision(layers);
  await materializeDeviceFlowLogins({ sandbox: sb, handle: h2, keychain: k, ownerId: "U1" });
  const back = await sb.run(h2, "cat ~/.config/acmecorp/auth.json");
  assert.match(back.stdout, /tok_NEWTOOL/, "an undocumented tool's login survived machine replacement");
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

  assert.deepEqual(await captureDeviceFlowLogins({ sandbox: sb, handle: h1, keychain: k, ownerId: "U1" }), ["bigtool"]);
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

test("shape backstop: a tree dumped into a config dir is skipped loudly, not stored", async () => {
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
    onAnomaly: (service) => skipped.push(service),
  });
  assert.deepEqual(saved, ["gh"], "the real login still got captured");
  assert.deepEqual(skipped, ["bloat"], "the dumped tree was skipped");
  assert.ok(!(await k.listByOwner("U1")).some((c) => c.service === "bloat"), "and never stored");
});

test("materialize round-trip: login → machine replaced → files restored 0600 behind the symlinks", async () => {
  const sb = sprites();
  const k = kc();
  const layers = rw(scopeId("personal", "U1"));
  const h1 = await sb.provision(layers);
  await sb.run(h1, "mkdir -p ~/.config/glab && printf 'token: glpat_SECRET' > ~/.config/glab/config.yml");
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

test("shared ACMECLI cutover isolates brokered STS without shrinking the existing scopeShared owner union", async () => {
  const acmecliBroker = createAwsRoleBroker({
    roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
    region: "us-west-2",
    sessionActions: ["execute-api:Invoke"],
    assumeRole: async ({ RoleSessionName }) => ({
      Credentials: {
        AccessKeyId: `AKIA_${RoleSessionName}`,
        SecretAccessKey: `secret_${RoleSessionName}`,
        SessionToken: `session_${RoleSessionName}`,
        Expiration: new Date(Date.now() + 3_600_000),
      },
    }),
  });
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-owner-box-")),
      signingSecret: "device-flow-test-secret",
      sharedOwnerAuthIsolation: true,
      deploymentLayerDir: acmecliBrokeredLayer(),
    }),
    { credentialBrokers: { acmecli: acmecliBroker } },
  );
  const bob = { externalId: "BOB" };
  const alice = { externalId: "ALICE" };
  const room = scopeId("channel", "C-owner-auth");
  const conversation = {
    kind: "channel" as const,
    threadRef: "ch:C-owner-auth:cron",
    channelRef: "C-owner-auth",
    audience: [bob, alice],
  };
  await built.keychain!.save({ ownerId: "BOB", service: "npm", secret: "npm_BOB", envKey: "NPM_TOKEN" });
  await built.keychain!.save({
    ownerId: "BOB",
    service: "aws",
    secret: "AKIA_BOB_GENERAL",
    envKey: "AWS_ACCESS_KEY_ID",
  });
  await built.keychain!.save({
    ownerId: "BOB",
    service: "acmecorp",
    files: [{ path: ".config/acmecorp/auth.json", contentBase64: Buffer.from("file_BOB").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  await built.keychain!.save({
    ownerId: room,
    service: "acmecli",
    files: [{ path: ".acmecli/session.json", contentBase64: Buffer.from("legacy_room_acmecli").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  const owner = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation,
    text: '!owner printf \'%s|%s|%s|%s|%s\' "$NPM_TOKEN" "$AWS_ACCESS_KEY_ID" "$(cat ~/.config/acmecorp/auth.json)" "${AGENT_API_TOKEN-unset}" "$(env | grep -q secret_BOB && echo leaked || echo clean)"; printf poisoned > ~/.config/acmecorp/auth.json',
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(owner.status, "ok", owner.reason);
  assert.equal(owner.reply, "npm_BOB|AKIA_BOB_GENERAL|file_BOB|unset|clean");
  assert.equal(
    ff.names().some((n) => n.includes("scratch")),
    false,
    "the owner-auth body is destroyed after success",
  );

  const brokeredAcmecli = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:brokered-acmecli" },
    text: "!owner mkdir -p /tmp/bin; printf '%s\\n' '#!/bin/sh' 'printf \"%s\" \"$AWS_ACCESS_KEY_ID\"' > /tmp/bin/acmecli; chmod +x /tmp/bin/acmecli; export PATH=\"/tmp/bin:$PATH\"; printf '%s|' \"$AWS_ACCESS_KEY_ID\"; acmecli",
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(
    brokeredAcmecli.reply,
    "AKIA_BOB_GENERAL|AKIA_BOB_GENERAL",
    "prefer-ephemeral direct execution retains the owner's legacy fallback without broker vending",
  );

  const unpoisoned = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:unpoisoned" },
    text: "!owner cat ~/.config/acmecorp/auth.json",
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(unpoisoned.reply, "file_BOB", "owner-box mutations never capture back into Bob's durable keychain");
  const ownerAudit = await built.auditLog.events();
  assert.ok(
    ownerAudit.some((event) => event.action === "keychain.materialize" && event.resource.includes("owner-auth box")),
  );
  assert.equal(
    ownerAudit.some((event) => event.action === "credential.materialize"),
    false,
  );

  const scoped = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:scoped" },
    text: '!run printf \'%s|%s|%s|%s\' "${NPM_TOKEN-unset}" "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)" "$(test -e ~/.acmecli/session.json && echo found || echo absent)"',
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(scoped.status, "ok", scoped.reason);
  assert.equal(
    scoped.reply,
    "unset|unset|absent|found",
    "prefer-isolated keeps resident ACMECLI as a live fallback without placing Bob's private credentials on the room",
  );

  const poisoned = await built.app.turn({
    surface: "slack",
    actor: alice,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:poison" },
    text: "!run printf poisoned > ~/.acmecli/session.json",
  });
  assert.equal(poisoned.status, "ok", poisoned.reason);

  const aliceTurn = await built.app.turn({
    surface: "slack",
    actor: alice,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:alice" },
    text: '!run printf \'%s|%s|%s\' "${NPM_TOKEN-unset}" "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)"',
  });
  assert.equal(aliceTurn.status, "ok", aliceTurn.reason);
  assert.equal(aliceTurn.reply, "unset|unset|absent");

  const aliceAcmecli = await built.app.turn({
    surface: "slack",
    actor: alice,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:alice-acmecli" },
    text: '!owner mkdir -p /tmp/bin; printf \'%s\\n\' \'#!/bin/sh\' \'printf "%s" "$AWS_ACCESS_KEY_ID"\' > /tmp/bin/acmecli; chmod +x /tmp/bin/acmecli; export PATH="/tmp/bin:$PATH"; acmecli; printf \'|%s|%s\' "${NPM_TOKEN-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)"',
  });
  assert.equal(aliceAcmecli.status, "ok", aliceAcmecli.reason);
  assert.equal(
    aliceAcmecli.reply,
    "|unset|absent",
    "direct execution has no brokered identity and no access to Bob's keychain",
  );
  assert.equal(
    ff.names().some((n) => n.includes("scratch")),
    false,
  );

  await built.deviceFlowCutover.set(room, "acmecli", "legacy", "rollback@example.com");
  const rollback = await built.app.turn({
    surface: "slack",
    actor: alice,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:rollback" },
    text: "!run cat ~/.acmecli/session.json",
  });
  assert.equal(
    rollback.reply,
    "legacy_room_acmecli",
    "prefer-mode mutations never poison the encrypted rollback input",
  );
  assert.equal(
    await built.deviceFlowCutover.residentResetGeneration(room, "acmecli"),
    null,
    "rollback reset is consumed after one verified restore",
  );

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const requarantined = await built.app.turn({
    surface: "slack",
    actor: alice,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:requarantine" },
    text: "!run test -e ~/.acmecli/session.json && echo found || echo absent",
  });
  assert.equal(
    requarantined.reply,
    "absent",
    "ephemeral-only removes already-materialized legacy files without deleting the stored record",
  );
  const acmecliUsage = await built.credentialUsage.list({ slug: "acmecli" });
  assert.equal(
    acmecliUsage.some((row) => row.status === "ephemeral_vended"),
    false,
  );
  const legacyUsage = await built.credentialUsage.list({ slug: "keychain:acmecli" });
  assert.ok(
    legacyUsage.some((row) => row.status === "legacy_retained"),
    "prefer-isolated records that resident fallback remains present",
  );

  const realMaterializeOwnFiles = built.keychain!.materializeOwnFiles.bind(built.keychain!);
  built.keychain!.materializeOwnFiles = async () => {
    throw new Error("owner file materialization failed");
  };
  await assert.rejects(
    built.app.turn({
      surface: "cron",
      actor: bob,
      conversation: { ...conversation, threadRef: "ch:C-owner-auth:init-failure" },
      text: "!owner true",
      triggered: true,
      ownerKeychainUnion: true,
    }),
    /owner file materialization failed/,
  );
  built.keychain!.materializeOwnFiles = realMaterializeOwnFiles;
  assert.equal(
    ff.names().some((n) => n.includes("scratch")),
    false,
    "failed owner-box initialization destroys its pending body",
  );

  const realTeardown = built.sandbox.teardown.bind(built.sandbox);
  let ownerDestroyAttempts = 0;
  built.sandbox.teardown = async (handle, opts) => {
    if (handle.scratch && opts?.destroy && ownerDestroyAttempts++ < 2)
      throw new Error("transient owner destroy failure");
    return realTeardown(handle, opts);
  };
  const retriedDestroy = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:destroy-retry" },
    text: "!owner true",
    triggered: true,
    ownerKeychainUnion: true,
  });
  built.sandbox.teardown = realTeardown;
  assert.equal(retriedDestroy.status, "ok", retriedDestroy.reason);
  assert.equal(ownerDestroyAttempts, 3, "credential-bearing owner bodies retry destruction before losing the handle");
  assert.equal(
    ff.names().some((n) => n.includes("scratch")),
    false,
  );

  let stranded: Parameters<typeof realTeardown>[0] | undefined;
  built.sandbox.teardown = async (handle, opts) => {
    if (handle.scratch && opts?.destroy) {
      stranded = handle;
      throw new Error("persistent control-plane deletion failure");
    }
    return realTeardown(handle, opts);
  };
  await assert.rejects(
    built.app.turn({
      surface: "cron",
      actor: bob,
      conversation: { ...conversation, threadRef: "ch:C-owner-auth:destroy-failure-containment" },
      text: "!owner printf changed > ~/.config/acmecorp/auth.json",
      triggered: true,
      ownerKeychainUnion: true,
    }),
    /persistent control-plane deletion failure/,
  );
  built.sandbox.teardown = realTeardown;
  assert.ok(stranded);
  assert.equal(
    stranded.env?.NPM_TOKEN,
    undefined,
    "long-lived owner env credentials never enter machine configuration",
  );
  assert.equal(
    (await built.sandbox.run(stranded, "test ! -e ~/.config/acmecorp/auth.json")).code,
    0,
    "owner files are scrubbed before remote deletion is attempted",
  );
  await realTeardown(stranded, { destroy: true });

  const realRun = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = async (handle, command, opts) => {
    if (handle.scratch && command.endsWith("explode-owner")) throw new Error("owner command exploded");
    return realRun(handle, command, opts);
  };
  await assert.rejects(
    built.app.turn({
      surface: "cron",
      actor: bob,
      conversation: { ...conversation, threadRef: "ch:C-owner-auth:throw" },
      text: "!owner explode-owner",
      triggered: true,
      ownerKeychainUnion: true,
    }),
    /owner command exploded/,
  );
  built.sandbox.run = realRun;
  assert.equal(
    ff.names().some((n) => n.includes("scratch")),
    false,
    "the owner-auth body is destroyed after a thrown turn",
  );
});

test("prefer-isolated keeps legacy ACMECLI when STS vending fails; isolated-only fails closed", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-acmecli-fallback-")),
      signingSecret: "device-flow-test-secret",
      sharedOwnerAuthIsolation: true,
      deploymentLayerDir: acmecliBrokeredLayer(),
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole: async () => {
            throw new Error("STS unavailable");
          },
        }),
      },
    },
  );
  const room = scopeId("channel", "C-acmecli-fallback");
  await built.keychain!.save({
    ownerId: room,
    service: "acmecli",
    files: [{ path: ".acmecli/session.json", contentBase64: Buffer.from("legacy_ok").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  await built.keychain!.save({
    ownerId: actor.externalId,
    service: "acmecli",
    files: [{ path: ".acmecli/session.json", contentBase64: Buffer.from("owner_legacy").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  const conversation = {
    kind: "channel" as const,
    channelRef: "C-acmecli-fallback",
    audience: [actor],
  };

  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  const fallback = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:prefer" },
    text: "!run cat ~/.acmecli/session.json",
  });
  assert.equal(fallback.reply, "legacy_ok");
  await assert.rejects(
    built.app.turn({
      surface: "slack",
      actor,
      conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:prefer-broker" },
      text: "!credential acmecli []",
    }),
    /could not vend credentials/,
  );

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const closed = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:only" },
    text: '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.acmecli && echo found || echo absent)"',
  });
  assert.equal(closed.reply, "unset|absent");
  const ownerClosed = await built.app.turn({
    surface: "cron",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:owner-only" },
    text: "!owner test -e ~/.acmecli && echo found || echo absent",
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(
    ownerClosed.reply,
    "absent",
    "isolated-only never restores an owner's ambient ACMECLI after broker failure",
  );
  await assert.rejects(
    built.app.turn({
      surface: "slack",
      actor,
      conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:only-broker" },
      text: "!credential acmecli []",
    }),
    /could not vend credentials/,
  );
  const usage = await built.credentialUsage.list({ slug: "acmecli" });
  assert.ok(usage.some((row) => row.status === "legacy_fallback"));
  assert.ok(usage.some((row) => row.status === "ephemeral_failed_closed"));
});

test("a nonlegacy policy never places brokered STS on a shared room when isolation is disabled", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dfp-acmecli-flag-off-")),
      signingSecret: "device-flow-test-secret",
      sharedOwnerAuthIsolation: false,
      deploymentLayerDir: acmecliBrokeredLayer(),
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole: async () => ({
            Credentials: {
              AccessKeyId: "AKIA_SHOULD_NOT_REACH_ROOM",
              SecretAccessKey: "secret",
              SessionToken: "session",
              Expiration: new Date(Date.now() + 3_600_000),
            },
          }),
        }),
      },
    },
  );
  const room = scopeId("channel", "C-acmecli-flag-off");
  await built.keychain!.save({
    ownerId: room,
    service: "acmecli",
    files: [{ path: ".acmecli/session.json", contentBase64: Buffer.from("legacy_ok").toString("base64") }],
    origin: DEVICE_FLOW_ORIGIN,
  });
  const conversation = {
    kind: "channel" as const,
    channelRef: "C-acmecli-flag-off",
    audience: [actor],
  };

  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  const prefer = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-flag-off:prefer" },
    text: '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(cat ~/.acmecli/session.json)"',
  });
  assert.equal(prefer.reply, "unset|legacy_ok");

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const only = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-flag-off:only" },
    text: '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.acmecli && echo found || echo absent)"',
  });
  assert.equal(only.reply, "unset|absent");
});
