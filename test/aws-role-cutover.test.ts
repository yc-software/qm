import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { DEVICE_FLOW_ORIGIN } from "../src/credentials/device-flow-persist.ts";
import { scopeId } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { createAwsRoleBroker, type AwsRoleBrokerOptions } from "../src/auth/aws-role-broker.ts";

let ff: FakeSprites;
before(() => {
  ff = installGlobalFakeSprites();
});
beforeEach(() => ff.reset());
after(() => ff.cleanup());

const actor = { externalId: "U1" };
const hasScratch = () => ff.names().some((n) => n.includes("scratch"));

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

const sts = (AccessKeyId: string, SecretAccessKey: string, SessionToken: string) => ({
  Credentials: { AccessKeyId, SecretAccessKey, SessionToken, Expiration: new Date(Date.now() + 3_600_000) },
});

function buildBrokered(
  dataDirPrefix: string,
  assumeRole: NonNullable<AwsRoleBrokerOptions["assumeRole"]>,
  layer = acmecliBrokeredLayer(),
) {
  return buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), dataDirPrefix)),
      signingSecret: "device-flow-test-secret",
      deploymentLayerDir: layer,
    }),
    {
      credentialBrokers: {
        acmecli: createAwsRoleBroker({
          roleArn: "arn:aws:iam::123456789012:role/acmecli-broker",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
          assumeRole,
        }),
      },
    },
  );
}

const acmecliSession = (content: string) => [
  { path: ".acmecli/session.json", contentBase64: Buffer.from(content).toString("base64") },
];

const brokerExecute = (command: string) =>
  `!execute ${JSON.stringify({ command, credentials: ["broker_acmecli"], ownerAuth: true })}`;

test("a scope allow rule cannot override the ephemeral_only direct-execution deny", async () => {
  const built = buildBrokered(
    "dfp-credexec-scope-allow-",
    async () => sts("AKIA_SCOPE_ALLOW", "scope_allow_secret_value", "scope_allow_session_token"),
    acmecliBrokeredLayer("env"),
  );
  const personal = scopeId("personal", actor.externalId);
  built.config.setCommandPolicy(personal, {
    mode: "denylist",
    rules: [{ pattern: "\\benv\\b", decision: "allow" }],
  });
  const conversation = { kind: "dm" as const, threadRef: "dm:credexec-scope-allow", audience: [actor] };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");

  const direct = await built.app.turn({ surface: "slack", actor, conversation, text: "!run env" });
  assert.match(
    `${direct.reason ?? ""} ${direct.reply ?? ""}`,
    /requires execute with its broker credential and scope:owner/,
  );
});

test("shared ACMECLI cutover isolates brokered STS without shrinking the existing scopeShared owner union", async () => {
  const built = buildBrokered("dfp-owner-box-", async ({ RoleSessionName }) =>
    sts(`AKIA_${RoleSessionName}`, `secret_${RoleSessionName}`, `session_${RoleSessionName}`),
  );
  const bob = { externalId: "BOB" };
  const alice = { externalId: "ALICE" };
  const room = scopeId("channel", "C-owner-auth");
  const conversation = {
    kind: "channel" as const,
    threadRef: "ch:C-owner-auth:cron",
    channelRef: "C-owner-auth",
    isPrivate: true,
    audience: [bob, alice],
  };
  const bobTurn = (thread: string, text: string) =>
    built.app.turn({
      surface: "cron",
      actor: bob,
      conversation: { ...conversation, threadRef: `ch:C-owner-auth:${thread}` },
      text,
      triggered: true,
      ownerKeychainUnion: true,
    });
  const aliceTurn = (thread: string, text: string) =>
    built.app.turn({
      surface: "slack",
      actor: alice,
      conversation: { ...conversation, threadRef: `ch:C-owner-auth:${thread}` },
      text,
    });
  const npm = await built.keychain!.save({ ownerId: "BOB", service: "npm", secret: "npm_BOB", envKey: "NPM_TOKEN" });
  const aws = await built.keychain!.save({
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
    files: acmecliSession("legacy_room_acmecli"),
    origin: DEVICE_FLOW_ORIGIN,
  });
  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  const ambientOwner = await bobTurn(
    "ambient",
    '!owner printf "%s|%s" "${NPM_TOKEN-unset}" "${AWS_ACCESS_KEY_ID-unset}"',
  );
  assert.equal(ambientOwner.reply, "unset|unset");
  const owner = await bobTurn(
    "cron",
    `!execute ${JSON.stringify({ command: `test "$NPM_TOKEN" = npm_BOB && test "$AWS_ACCESS_KEY_ID" = AKIA_BOB_GENERAL && printf 'selected|%s|%s' "$(cat ~/.config/acmecorp/auth.json)" "\${AGENT_API_TOKEN-unset}"; printf poisoned > ~/.config/acmecorp/auth.json`, credentials: [credentialHandle(npm.id), credentialHandle(aws.id)], ownerAuth: true })}`,
  );
  assert.equal(owner.status, "ok", owner.reason);
  assert.equal(owner.reply, "selected|file_BOB|unset");
  assert.equal(hasScratch(), false, "the owner-auth body is destroyed after success");

  const brokeredAcmecli = await bobTurn(
    "brokered-acmecli",
    brokerExecute(
      'test -n "$AWS_ACCESS_KEY_ID" && test "$AWS_ACCESS_KEY_ID" != AKIA_BOB_GENERAL && test -z "${NPM_TOKEN-}" && test -z "${AGENT_API_TOKEN-}" && echo broker-only',
    ),
  );
  assert.equal(
    brokeredAcmecli.reply,
    "broker-only",
    "selected broker credentials replace ambient owner env and never carry a core API token",
  );

  const unpoisoned = await bobTurn("unpoisoned", "!owner cat ~/.config/acmecorp/auth.json");
  assert.equal(unpoisoned.reply, "file_BOB", "owner-box mutations never capture back into Bob's durable keychain");
  assert.deepEqual(await built.keychain!.grantsForScope(room), []);
  const ownerAudit = await built.auditLog.events();
  assert.ok(
    ownerAudit.some((event) => event.action === "keychain.materialize" && event.resource.includes("owner-auth box")),
  );
  assert.equal(
    ownerAudit.some((event) => event.action === "credential.materialize"),
    false,
  );

  const scoped = await bobTurn(
    "scoped",
    '!run printf \'%s|%s|%s|%s\' "${NPM_TOKEN-unset}" "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)" "$(test -e ~/.acmecli/session.json && echo found || echo absent)"',
  );
  assert.equal(scoped.status, "ok", scoped.reason);
  assert.equal(
    scoped.reply,
    "unset|unset|absent|found",
    "prefer-isolated keeps resident ACMECLI as a live fallback without placing Bob's private credentials on the room",
  );

  const poisoned = await aliceTurn("poison", "!run printf poisoned > ~/.acmecli/session.json");
  assert.equal(poisoned.status, "ok", poisoned.reason);

  const aliceRun = await aliceTurn(
    "alice",
    '!run printf \'%s|%s|%s\' "${NPM_TOKEN-unset}" "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)"',
  );
  assert.equal(aliceRun.status, "ok", aliceRun.reason);
  assert.equal(aliceRun.reply, "unset|unset|absent");

  const aliceAcmecli = await aliceTurn(
    "alice-acmecli",
    '!owner mkdir -p /tmp/bin; printf \'%s\\n\' \'#!/bin/sh\' \'printf "%s" "$AWS_ACCESS_KEY_ID"\' > /tmp/bin/acmecli; chmod +x /tmp/bin/acmecli; export PATH="/tmp/bin:$PATH"; acmecli; printf \'|%s|%s\' "${NPM_TOKEN-unset}" "$(test -e ~/.config/acmecorp/auth.json && echo found || echo absent)"',
  );
  assert.equal(aliceAcmecli.status, "ok", aliceAcmecli.reason);
  assert.equal(
    aliceAcmecli.reply,
    "|unset|absent",
    "direct execution has no brokered identity and no access to Bob's keychain",
  );
  assert.equal(hasScratch(), false);

  await built.deviceFlowCutover.set(room, "acmecli", "legacy", "rollback@example.com");
  const rollback = await aliceTurn("rollback", "!run cat ~/.acmecli/session.json");
  assert.equal(
    rollback.reply,
    "legacy_room_acmecli",
    "prefer-mode mutations never poison the encrypted rollback input",
  );
  const rollbackComputer = await built.sandbox.provision([{ scopeId: room, mountPath: "/", mode: "rw" }]);
  assert.equal(
    await built.deviceFlowCutover.residentResetGeneration(room, "acmecli", rollbackComputer.resourceId),
    null,
    "rollback reset is consumed after one verified restore",
  );

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const requarantined = await aliceTurn(
    "requarantine",
    "!run test -e ~/.acmecli/session.json && echo found || echo absent",
  );
  assert.equal(
    requarantined.reply,
    "absent",
    "ephemeral-only removes already-materialized legacy files without deleting the stored record",
  );
  const acmecliUsage = await built.credentialUsage.list({ slug: "acmecli" });
  assert.equal(
    acmecliUsage.some((row) => row.status === "ephemeral_vended"),
    true,
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
  await assert.rejects(bobTurn("init-failure", "!owner true"), /owner file materialization failed/);
  built.keychain!.materializeOwnFiles = realMaterializeOwnFiles;
  assert.equal(hasScratch(), false, "failed owner-box initialization destroys its pending body");

  const realTeardown = built.sandbox.teardown.bind(built.sandbox);
  let ownerDestroyAttempts = 0;
  built.sandbox.teardown = async (handle, opts) => {
    if (handle.scratch && opts?.destroy && ownerDestroyAttempts++ < 2)
      throw new Error("transient owner destroy failure");
    return realTeardown(handle, opts);
  };
  const retriedDestroy = await bobTurn("destroy-retry", "!owner true");
  built.sandbox.teardown = realTeardown;
  assert.equal(retriedDestroy.status, "ok", retriedDestroy.reason);
  assert.equal(ownerDestroyAttempts, 3, "credential-bearing owner bodies retry destruction before losing the handle");
  assert.equal(hasScratch(), false);

  let stranded: Parameters<typeof realTeardown>[0] | undefined;
  built.sandbox.teardown = async (handle, opts) => {
    if (handle.scratch && opts?.destroy) {
      stranded = handle;
      throw new Error("persistent control-plane deletion failure");
    }
    return realTeardown(handle, opts);
  };
  await assert.rejects(
    bobTurn("destroy-failure-containment", "!owner printf changed > ~/.config/acmecorp/auth.json"),
    (error: Error) => {
      assert.equal(error.message, "Disposable sandbox destruction failed");
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack?.includes("persistent control-plane deletion failure"));
      return true;
    },
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
  await assert.rejects(bobTurn("throw", "!owner explode-owner"), /owner command exploded/);
  built.sandbox.run = realRun;
  assert.equal(hasScratch(), false, "the owner-auth body is destroyed after a thrown turn");
});

test("cutover policy retains legacy files only in prefer-ephemeral mode", async () => {
  const built = buildBrokered("dfp-acmecli-fallback-", async () => {
    throw new Error("STS unavailable");
  });
  const room = scopeId("channel", "C-acmecli-fallback");
  await built.keychain!.save({
    ownerId: room,
    service: "acmecli",
    files: acmecliSession("legacy_ok"),
    origin: DEVICE_FLOW_ORIGIN,
  });
  await built.keychain!.save({
    ownerId: actor.externalId,
    service: "acmecli",
    files: acmecliSession("owner_legacy"),
    origin: DEVICE_FLOW_ORIGIN,
  });
  const conversation = {
    kind: "channel" as const,
    channelRef: "C-acmecli-fallback",
    isPrivate: true,
    audience: [actor],
  };
  const turn = (thread: string, text: string) =>
    built.app.turn({
      surface: "slack",
      actor,
      conversation: { ...conversation, threadRef: `ch:C-acmecli-fallback:${thread}` },
      text,
    });

  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  assert.equal((await turn("prefer", "!run cat ~/.acmecli/session.json")).reply, "legacy_ok");
  await assert.rejects(turn("broker-prefer", brokerExecute("true")), /Could not vend credentials/);

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const closed = await turn(
    "only",
    '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.acmecli && echo found || echo absent)"',
  );
  assert.equal(closed.reply, "unset|absent");
  await assert.rejects(turn("broker-only", brokerExecute("true")), /Could not vend credentials/);
  assert.ok(
    (await built.credentialUsage.list({ slug: "acmecli" })).some((row) => row.status === "ephemeral_failed_closed"),
  );

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
});

test("a nonlegacy policy never places brokered STS on a shared room", async () => {
  const built = buildBrokered("dfp-acmecli-flag-off-", async () =>
    sts("AKIA_SHOULD_NOT_REACH_ROOM", "secret", "session"),
  );
  const room = scopeId("channel", "C-acmecli-flag-off");
  await built.keychain!.save({
    ownerId: room,
    service: "acmecli",
    files: acmecliSession("legacy_ok"),
    origin: DEVICE_FLOW_ORIGIN,
  });
  const turn = (thread: string, text: string) =>
    built.app.turn({
      surface: "slack",
      actor,
      conversation: {
        kind: "channel" as const,
        channelRef: "C-acmecli-flag-off",
        audience: [actor],
        threadRef: `ch:C-acmecli-flag-off:${thread}`,
      },
      text,
    });

  await built.deviceFlowCutover.set(room, "acmecli", "prefer_ephemeral", "security@example.com");
  const prefer = await turn(
    "prefer",
    '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(cat ~/.acmecli/session.json)"',
  );
  assert.equal(prefer.reply, "unset|legacy_ok");

  await built.deviceFlowCutover.set(room, "acmecli", "ephemeral_only", "security@example.com");
  const only = await turn(
    "only",
    '!run printf \'%s|%s\' "${AWS_ACCESS_KEY_ID-unset}" "$(test -e ~/.acmecli && echo found || echo absent)"',
  );
  assert.equal(only.reply, "unset|absent");
});

test("selected broker execute honors deployment approval rules before vending credentials", async () => {
  let assumes = 0;
  const built = buildBrokered(
    "dfp-credexec-approval-",
    async () => {
      assumes++;
      return sts("AKIA_APPROVAL_GATE", "approval_gate_secret_value", "approval_gate_session_token");
    },
    acmecliBrokeredLayer("env", [{ pattern: "\\benv\\b\\s+tool\\b", reason: "mutating subcommand" }]),
  );
  const personal = scopeId("personal", actor.externalId);
  const conversation = { kind: "dm" as const, threadRef: "dm:credexec-approval", audience: [actor] };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");

  const gated = await built.app.turn({ surface: "slack", actor, conversation, text: brokerExecute("env tool delete") });
  assert.equal(gated.status, "pending_approval");
  assert.equal(assumes, 0, "no AssumeRole call happens for a blocked command");
  const pending = gated.pendingApprovals![0]!;
  assert.match(pending.reason, /mutating subcommand/);

  const approved = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: brokerExecute("env tool delete"),
    approval: { requestId: pending.requestId, approved: true },
  });
  assert.equal(approved.status, "ok", approved.reason);
  assert.equal(assumes, 1, "approval unblocks exactly one vended invocation");

  const unrelated = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "dm:credexec-approval-3" },
    text: brokerExecute("env"),
  });
  assert.equal(unrelated.status, "ok", "subcommands without approval rules run without a grant");
  assert.equal(assumes, 1, "the broker's per-actor credential cache is reused within its TTL");
  assert.match(unrelated.reply ?? "", /<redacted:credential>/);
  const durable = JSON.stringify(await built.sessions.getEntries(unrelated.sessionId!));
  for (const value of ["AKIA_APPROVAL_GATE", "approval_gate_secret_value", "approval_gate_session_token"]) {
    assert.ok(!(unrelated.reply ?? "").includes(value));
    assert.ok(!durable.includes(value));
  }
  assert.deepEqual(await built.keychain!.grantsForScope(personal), []);
});
