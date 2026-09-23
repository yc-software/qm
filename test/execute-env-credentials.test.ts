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

const actor = { externalId: "U_ENV_BROKER" };
test("selected broker credential uses isolated execute with policy before vending", async () => {
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
  const conversation = { kind: "dm" as const, threadRef: "dm:env-broker", audience: [actor] };
  await built.deviceFlowCutover.set(personal, "acmecli", "ephemeral_only", "security@example.com");
  const run = (params: object) =>
    built.app.turn({ surface: "slack", actor, conversation, text: `!execute ${JSON.stringify(params)}` });
  await assert.rejects(run({ command: "env", credentials: ["broker_acmecli"] }), /requires scope:owner/);
  assert.equal(assumes, 0);
  const selected = await run({
    command:
      'test "$AWS_ACCESS_KEY_ID" = AKIA_CREDENTIAL_EXEC_SENTINEL && test -z "${AGENT_API_TOKEN-}" && echo selected',
    credentials: ["broker_acmecli"],
    ownerAuth: true,
  });
  assert.equal(selected.reply, "selected");
  assert.equal(assumes, 1);
  assert.ok(ff.names().every((name) => !name.includes("credential-exec")));
});
