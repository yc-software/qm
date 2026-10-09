import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { scopeId } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { createAwsRoleBroker } from "../src/auth/aws-role-broker.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { personalScope } from "./support/principal.ts";

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

const actor = { externalId: "U_ENV_BROKER", provider: "slack" as const };
test("role broker vends only for explicitly selected scoped execution", async () => {
  let assumes = 0;
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "legacy-selected-broker-")),
      signingSecret: "legacy-selected-signing",
      deploymentLayerDir: acmecliBrokeredLayer(),
      maxAttempts: 1,
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
                AccessKeyId: "AKIA_LEGACY_SELECTED",
                SecretAccessKey: "legacy-selected-secret",
                SessionToken: "legacy-selected-session",
                Expiration: new Date(Date.now() + 3600000),
              },
            };
          },
        }),
      },
    },
  );
  const owner = await personalScope(built, actor.externalId);
  await selectDefaultSandbox(built, actor.externalId, owner);
  const conversation = { kind: "dm" as const, threadRef: "dm:legacy-selected", audience: [actor] };
  const run = (text: string) => built.app.turn({ surface: "slack", actor, conversation, text });
  assert.equal((await run('!run test -z "${AWS_ACCESS_KEY_ID-}" && echo absent')).reply, "absent");
  assert.equal(assumes, 0);
  await assert.rejects(
    run(`!execute ${JSON.stringify({ command: "true", credentials: ["broker_acmecli"], ownerAuth: true })}`),
    /requires scope:scoped/,
  );
  assert.equal(assumes, 0);
  assert.equal(
    (
      await run(
        `!execute ${JSON.stringify({ command: 'test "$AWS_ACCESS_KEY_ID" = AKIA_LEGACY_SELECTED && echo selected', credentials: ["broker_acmecli"] })}`,
      )
    ).reply,
    "selected",
  );
  assert.equal(assumes, 1);
  assert.equal((await run('!run test -z "${AWS_ACCESS_KEY_ID-}" && echo absent')).reply, "absent");
  assert.equal(assumes, 1);
});

test("selected broker execute honors deployment approval rules before vending credentials", async () => {
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
  const personal = await personalScope(built, actor.externalId);
  const conversation = { kind: "dm" as const, threadRef: "dm:credexec-approval", audience: [actor] };
  await selectDefaultSandbox(built, actor.externalId, personal);

  const gated = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: `!execute ${JSON.stringify({ command: "env tool delete", credentials: ["broker_acmecli"] })}`,
  });
  assert.equal(gated.status, "pending_approval");
  assert.equal(assumes, 0, "no AssumeRole call happens for a blocked command");
  const pending = gated.pendingApprovals![0]!;
  assert.match(pending.reason, /mutating subcommand/);

  const approved = await built.app.turn({
    surface: "slack",
    actor,
    conversation,
    text: `!execute ${JSON.stringify({ command: "env tool delete", credentials: ["broker_acmecli"] })}`,
    approval: { requestId: pending.requestId, approved: true },
  });
  assert.equal(approved.status, "ok", approved.reason);
  assert.equal(assumes, 1, "approval unblocks exactly one vended invocation");

  const unrelated = await built.app.turn({
    surface: "slack",
    actor,
    conversation: { ...conversation, threadRef: "dm:credexec-approval-3" },
    text: `!execute ${JSON.stringify({ command: "env", credentials: ["broker_acmecli"] })}`,
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
