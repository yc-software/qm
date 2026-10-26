import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { externalSlackNamespace } from "../src/slack/external-access.ts";
import type { TriggerOutcome } from "../src/triggers/run-trigger.ts";
import type { Destination, ScopeId, TurnRequest } from "../src/types.ts";

const policy = { companyDomains: ["example.com"], companyTeamIds: ["TCOMPANY"], serviceCredentials: [] };
const namespace = externalSlackNamespace("TBATCH", policy);

async function setup(t: TestContext) {
  const b = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "trigger-slack-")),
      signingSecret: "trigger-slack-source-secret".repeat(2),
      externalSlackPolicies: { batch: policy },
    }),
  );
  t.after(async () => {
    b.scheduler.stop();
    await b.runtime.stop();
  });
  await b.app.upsertDirectory([
    { principalId: "U_ALICE", displayName: "Alice", type: "internal" },
    { principalId: "U_BOB", displayName: "Bob", type: "internal" },
  ]);
  await b.app.upsertGroups([
    { groupId: "G1", principalId: "U_ALICE" },
    { groupId: "G1", principalId: "U_BOB" },
  ]);
  return b;
}

async function askFrom(
  b: Awaited<ReturnType<typeof setup>>,
  scope: ScopeId,
  threadRef: string,
  destination: Destination,
) {
  const cred = await b.keychain!.save({ ownerId: "U_ALICE", service: "github", secret: "s", envKey: "GITHUB_TOKEN" });
  return (
    await b.keychain!.createAsk({
      credentialId: cred.id,
      requesterId: "U_BOB",
      requesterScopeId: scope,
      requesterDestination: destination,
      requesterThreadRef: threadRef,
      purpose: "clone",
    })
  ).ask;
}

test("approving an ask from a Slack group thread resumes it when external Slack policies exist", async (t) => {
  const b = await setup(t);
  const threadRef = "G1:1700000000.000100";
  const seeded = await b.app.turn({
    surface: "slack",
    actor: { externalId: "U_BOB" },
    slackSource: { accountId: "default", teamId: "TSTAFF", userId: "U_BOB", replyThreadTs: "1700000000.000100" },
    conversation: { kind: "group", channelRef: "G1", threadRef, audience: [{ externalId: "U_BOB" }] },
    text: "needs github",
  } as TurnRequest);
  assert.equal(seeded.status, "ok", JSON.stringify(seeded));
  const direct = await b.app.turn({
    surface: "web",
    actor: { externalId: "U_BOB" },
    triggered: true,
    conversation: { kind: "group", channelRef: "G1", threadRef, audience: [{ externalId: "U_BOB" }] },
    text: "resume",
  } as TurnRequest);
  assert.equal(direct.status, "refused");
  const ask = await askFrom(b, "group:G1", threadRef, {
    type: "slack",
    target: "G1:1700000000.000100",
    audienceScopeId: "group:G1",
  });
  await b.keychainApprovals!.decide(ask.id, { externalId: "U_ALICE" }, "standing");
  const fallbackKey = `ask:${ask.id}:approved:fallback`;
  let resumed;
  for (let i = 0; i < 400 && !resumed; i++) {
    await new Promise((r) => setTimeout(r, 25));
    resumed = (await b.runs.list({ threadRef })).find(
      (r) => r.request.surface === "keychain-ask" && r.status === "done",
    );
  }
  assert.equal(resumed?.request.slackSource?.accountId, "default");
  assert.ok(!(await b.deliveries.pending("slack")).some((d) => d.idempotencyKey === fallbackKey));
});

test("a thread from a Slack account with an external policy still refuses triggered resumes", async (t) => {
  const b = await setup(t);
  const channelRef = `${namespace}:C1`;
  const threadRef = `${channelRef}:1700000000.000200`;
  const seeded = await b.app.turn({
    surface: "slack",
    actor: { externalId: "U_BOB" },
    slackSource: { accountId: "batch", teamId: "TBATCH", userId: "U_BOB", externalPolicyNamespace: namespace },
    externalSlack: { accountId: "batch", teamId: "TBATCH", userId: "U_BOB", ...policy },
    conversation: { kind: "channel", channelRef, threadRef, audience: [{ externalId: "U_BOB" }] },
    text: "needs github",
  } as TurnRequest);
  assert.equal(seeded.status, "ok", JSON.stringify(seeded));
  const before = (await b.runs.list({ threadRef })).length;
  const scope = `channel:${channelRef}` as ScopeId;
  const ask = await askFrom(b, scope, threadRef, { type: "slack", target: threadRef, audienceScopeId: scope });
  const approved = await b.keychain!.approveAsk({
    askId: ask.id,
    ownerId: "U_ALICE",
    mode: "standing",
    purpose: "clone",
  });
  const outcome = (await b.fireAskResolution!(approved.ask, approved.grant)) as TriggerOutcome;
  assert.equal(outcome.status, "refused");
  assert.equal((await b.runs.list({ threadRef })).length, before);
});
