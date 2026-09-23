import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { DEVICE_FLOW_ORIGIN } from "../src/credentials/device-flow-persist.ts";
import { scopeId } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { createAwsRoleBroker } from "../src/auth/aws-role-broker.ts";

let ff: FakeSprites;
before(() => {
  ff = installGlobalFakeSprites();
});
beforeEach(() => ff.reset());
after(() => ff.cleanup());

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

test("personal credentials are requested explicitly and redacted in all execution outputs", async () => {
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
  assert.equal(direct.status, "ok");
  assert.doesNotMatch(direct.reply ?? "", /AKIA_|AWS_SECRET_ACCESS_KEY=/);
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

test("a scope allow rule permits an unauthenticated command without vending credentials", async () => {
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
  assert.equal(direct.status, "ok");
  assert.doesNotMatch(direct.reply ?? "", /AKIA_|AWS_SECRET_ACCESS_KEY=/);

  const sanctioned = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "dm:credexec-scope-allow-2" },
    text: "!credential acmecli []",
  });
  assert.equal(sanctioned.status, "ok", sanctioned.reason);
});

const actor = { externalId: "U1" };

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
  assert.equal(owner.reply, "|||unset|clean");
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
  assert.equal(brokeredAcmecli.reply, "|", "direct execution never acquires owner credentials implicitly");

  const unpoisoned = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:unpoisoned" },
    text: "!owner test -e ~/.config/acmecorp/auth.json && echo found || echo absent",
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(unpoisoned.reply, "absent", "owner boxes do not restore saved files without a requested handle");
  assert.equal(
    (await built.keychain!.materializeOwnFiles("BOB"))[0]?.files[0]?.contentBase64,
    Buffer.from("file_BOB").toString("base64"),
  );
  const ownerAudit = await built.auditLog.events();
  assert.equal(
    ownerAudit.some((event) => event.action === "keychain.materialize"),
    false,
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
  assert.equal(scoped.reply, "unset|unset|absent|absent", "saved credentials remain absent until explicitly requested");

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
    text: "!run test -e ~/.acmecli/session.json && echo found || echo absent",
  });
  assert.equal(rollback.reply, "absent", "legacy policy does not restore credentials into the persistent computer");
  assert.equal(
    (await built.keychain!.materializeOwnFiles(room))[0]?.files[0]?.contentBase64,
    Buffer.from("legacy_room_acmecli").toString("base64"),
    "unrequested commands cannot mutate saved credentials",
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
  assert.equal(legacyUsage.length, 0, "no resident fallback is restored");

  const realMaterializeOwnFiles = built.keychain!.materializeOwnFiles.bind(built.keychain!);
  built.keychain!.materializeOwnFiles = async () => {
    throw new Error("owner file materialization failed");
  };
  const withoutMaterialization = await built.app.turn({
    surface: "cron",
    actor: bob,
    conversation: { ...conversation, threadRef: "ch:C-owner-auth:init-failure" },
    text: "!owner true",
    triggered: true,
    ownerKeychainUnion: true,
  });
  assert.equal(withoutMaterialization.status, "ok", "provisioning never resolves unrequested file credentials");
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

test("all cutover policies leave credentials absent and fail closed when requested broker vending fails", async () => {
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
    text: "!run test -e ~/.acmecli/session.json && echo found || echo absent",
  });
  assert.equal(fallback.reply, "absent");
  await assert.rejects(
    built.app.turn({
      surface: "slack",
      actor,
      conversation: { ...conversation, threadRef: "ch:C-acmecli-fallback:prefer-broker" },
      text: "!credential acmecli []",
    }),
    /STS unavailable/,
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
    /STS unavailable/,
  );
  const usage = await built.credentialUsage.list({ slug: "acmecli" });
  assert.equal(
    usage.some((row) => row.status === "legacy_fallback"),
    false,
  );
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
  assert.equal(prefer.reply, "unset|");

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const only = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "ch:C-acmecli-flag-off:only" },
    text: '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.acmecli && echo found || echo absent)"',
  });
  assert.equal(only.reply, "unset|absent");
});

for (const sharedOwnerAuthIsolation of [true, false]) {
  test(`requested actor role credentials stay off the shared workspace with owner isolation ${sharedOwnerAuthIsolation}`, async () => {
    const broker = createAwsRoleBroker({
      roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
      region: "us-west-2",
      sessionActions: ["execute-api:Invoke"],
      assumeRole: async () => ({
        Credentials: {
          AccessKeyId: "AKIA_OWNER_ONLY",
          SecretAccessKey: "owner-role-secret",
          SessionToken: "owner-role-session",
          Expiration: new Date(Date.now() + 3_600_000),
        },
      }),
    });
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "role-owner-routing-")),
        signingSecret: "role-owner-test",
        sharedOwnerAuthIsolation,
        deploymentLayerDir: acmecliBrokeredLayer("sh"),
      }),
      { credentialBrokers: { acmecli: broker } },
    );
    const turn = {
      surface: "slack",
      actor,
      conversation: {
        kind: "channel" as const,
        threadRef: "ch:role-owner",
        channelRef: "role-owner",
        audience: [actor, { externalId: "U2" }],
      },
    };
    await built.deviceFlowCutover.set(scopeId("channel", "role-owner"), "acmecli", "ephemeral_only", "admin");
    await built.app.turn({ ...turn, text: "!run printf shared > planted-shared-script" });
    const command = 'test -n "$AWS_ACCESS_KEY_ID" && test ! -e planted-shared-script && echo isolated-auth';
    const requested = await built.app.turn({
      ...turn,
      text: `!execute ${JSON.stringify({ command, ownerAuth: true, credentials: ["broker_acmecli"] })}`,
    });
    assert.equal(requested.reply, "isolated-auth");
    const compatibility = await built.app.turn({
      ...turn,
      text: `!credential acmecli ${JSON.stringify(["-c", command])}`,
    });
    assert.equal(compatibility.reply, "isolated-auth");
    await assert.rejects(
      built.app.turn({ ...turn, text: `!execute ${JSON.stringify({ command, credentials: ["broker_acmecli"] })}` }),
      /requires scope:owner/,
    );
    assert.equal(
      ff.names().some((name) => name.includes("scratch")),
      false,
    );
  });
}
