import { test } from "node:test";
import assert from "node:assert/strict";
import { createAwsRoleBroker, brokerSessionName } from "../src/auth/aws-role-broker.ts";

type AssumeInput = { RoleArn: string; RoleSessionName: string; DurationSeconds: number; Policy: string };

function stubAssumeRole(over: { Expiration?: Date } = {}) {
  const calls: AssumeInput[] = [];
  const fn = async (input: AssumeInput) => {
    calls.push(input);
    return {
      Credentials: {
        AccessKeyId: `AKIA-${calls.length}`,
        SecretAccessKey: `secret-${calls.length}`,
        SessionToken: `token-${calls.length}`,
        ...(over.Expiration ? { Expiration: over.Expiration } : {}),
      },
    };
  };
  return { fn, calls };
}

test("brokerSessionName keeps Slack ids and emails, sanitizes the rest, truncates to 64", () => {
  assert.equal(brokerSessionName("U0EXAMPLE01"), "U0EXAMPLE01");
  assert.equal(brokerSessionName("blair@example.com"), "blair@example.com");
  assert.equal(brokerSessionName("a b/c:d"), "a-b-c-d");
  assert.equal(brokerSessionName("x".repeat(80)).length, 64);
});

test("credsForActor assumes the role with the user as session name and a policy scoped to the declared actions", async () => {
  const stub = stubAssumeRole();
  const broker = createAwsRoleBroker({
    roleArn: "arn:aws:iam::111122223333:role/example/ecs/data-broker",
    region: "us-west-2",
    sessionActions: ["execute-api:Invoke"],
    assumeRole: stub.fn,
  });

  const creds = await broker.credsForActor("U0EXAMPLE01");

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]!.RoleArn, "arn:aws:iam::111122223333:role/example/ecs/data-broker");
  assert.equal(stub.calls[0]!.RoleSessionName, "U0EXAMPLE01");
  const policy = JSON.parse(stub.calls[0]!.Policy);
  assert.deepEqual(policy.Statement, [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }]);
  assert.equal(creds.accessKeyId, "AKIA-1");
  assert.equal(creds.sessionToken, "token-1");
  assert.equal(creds.region, "us-west-2");
});

test("credsForActor caches per session name until near expiry, then re-assumes", async () => {
  let nowMs = 1_000_000;
  const stub = stubAssumeRole({ Expiration: new Date(nowMs + 3600_000) });
  const broker = createAwsRoleBroker({
    roleArn: "arn:aws:iam::1:role/data-broker",
    region: "us-west-2",
    sessionActions: ["execute-api:Invoke"],
    assumeRole: stub.fn,
    now: () => nowMs,
    refreshMarginMs: 5 * 60_000,
  });

  await broker.credsForActor("U1");
  await broker.credsForActor("U1");
  assert.equal(stub.calls.length, 1);

  await broker.credsForActor("U2");
  assert.equal(stub.calls.length, 2);

  nowMs += 3600_000;
  await broker.credsForActor("U1");
  assert.equal(stub.calls.length, 3);
});

test("a multi-action broker emits an Action array in the session policy", async () => {
  const stub = stubAssumeRole();
  const broker = createAwsRoleBroker({
    roleArn: "arn:aws:iam::1:role/data-broker",
    region: "us-east-1",
    sessionActions: ["execute-api:Invoke", "s3:GetObject"],
    assumeRole: stub.fn,
  });
  await broker.credsForActor("U1");
  const policy = JSON.parse(stub.calls[0]!.Policy);
  assert.deepEqual(policy.Statement, [
    { Effect: "Allow", Action: ["execute-api:Invoke", "s3:GetObject"], Resource: "*" },
  ]);
});

test("credsForActor throws when STS returns incomplete credentials", async () => {
  const broker = createAwsRoleBroker({
    roleArn: "arn:aws:iam::1:role/data-broker",
    region: "us-west-2",
    sessionActions: ["execute-api:Invoke"],
    assumeRole: async () => ({ Credentials: { AccessKeyId: "AKIA" } }),
  });
  await assert.rejects(() => broker.credsForActor("U1"), /incomplete credentials/);
});
