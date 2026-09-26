import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebClient } from "@slack/web-api";
import { channelThreadRef, parseSlackThreadRef } from "../../src/slack/message-gating.ts";
import { createDirectory } from "../../src/slack/directory.ts";
import type { SlackCoreClient } from "../../src/api/slack-core-client.ts";
import { createSlackResponder, type SlackProfile } from "./workload-slack.ts";
import type { WorkloadFixture } from "./workload.ts";

const fixture: WorkloadFixture = {
  schemaVersion: 1,
  fixtureId: "qm-perf-slack-test",
  databaseName: "qm_perf_slack_test",
  profileSha256: "synthetic",
  qualified: false,
};
const profile: SlackProfile = {
  schemaVersion: 1,
  fixtureId: fixture.fixtureId,
  tokenEnv: "QM_PERF_SLACK_TEST_TOKEN",
  host: "127.0.0.1",
  port: 0,
  teamId: "TPERF000001",
  botUserId: "UPERFBOT001",
  botId: "BPERF000001",
  users: [
    { id: "UPERF000001", principalId: "one@example.invalid", displayName: "Fixture one" },
    { id: "UPERF000002", principalId: "two@example.invalid", displayName: "Fixture two" },
  ],
  conversations: [
    { id: "perf-1", name: "fixture-channel", kind: "channel", members: ["UPERF000001", "UPERF000002"] },
    { id: "GPERF000001", name: "fixture-group", kind: "group", members: ["UPERF000002"] },
    { id: "DPERF000001", name: "fixture-dm", kind: "dm", members: ["UPERF000001"] },
  ],
  writableConversationIds: ["DPERF000001"],
  messages: [{ channel: "DPERF000001", ts: "1790000000.000001", user: "UPERF000001", text: "Fixture turn" }],
};
const token = "xoxb-qm-perf-test-only";

test("installed Slack client preserves complete channel/group rosters and delivers only to explicit fixture conversations", async () => {
  const records: Record<string, unknown>[] = [];
  const responder = createSlackResponder(profile, fixture, (record) => records.push(record), {
    QM_PERF_SLACK_TEST_TOKEN: token,
  });
  responder.server.listen(0, "127.0.0.1");
  await once(responder.server, "listening");
  const address = responder.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/`;
  const client = new WebClient(token, { slackApiUrl: url, retryConfig: { retries: 0 } });
  const pushes: Record<string, unknown>[] = [];
  const core = {
    holdDirectorySync: async (f: (lost: Promise<void>) => Promise<unknown>) => f(new Promise(() => {})),
    pushDirectory: async (body: Record<string, unknown>) => {
      pushes.push(body);
      return true;
    },
  } as unknown as SlackCoreClient;
  const ids = {
    ownTeamId: profile.teamId,
    botUserId: profile.botUserId,
    ownBotId: profile.botId,
    botHandle: "fixture",
    ownWorkspaceUrl: "",
    identityMode: "email" as const,
  };
  try {
    assert.equal((await client.auth.test()).team_id, profile.teamId);
    assert.equal((await client.conversations.info({ channel: "perf-1" })).channel?.id, "perf-1");
    assert.deepEqual(parseSlackThreadRef(channelThreadRef("channel", "perf-1", "1790000000.000001")), {
      container: "perf-1",
      root: "1790000000.000001",
    });
    const directory = createDirectory({ core, ids });
    const snapshot = await directory.getUserSnapshot(client);
    assert.equal(snapshot?.byId.size, 2);
    assert.equal(pushes.length, 1);
    assert.deepEqual(
      pushes[0]!.members,
      profile.users.map((u) => ({
        principalId: u.principalId,
        displayName: u.displayName,
        type: "internal",
        slackId: u.id,
      })),
    );
    assert.deepEqual(pushes[0]!.channelMembers, [
      { channelId: "perf-1", principalId: "one@example.invalid" },
      { channelId: "perf-1", principalId: "two@example.invalid" },
    ]);
    assert.deepEqual(pushes[0]!.groupMembers, [{ groupId: "GPERF000001", principalId: "two@example.invalid" }]);
    const incoming = await client.conversations.history({
      channel: "DPERF000001",
      latest: "1790000000.000001",
      inclusive: true,
    });
    assert.equal(incoming.messages?.length, 1);
    const posted = await client.chat.postMessage({ channel: "DPERF000001", text: "Fixture response" });
    assert.ok(posted.ts);
    await client.chat.update({ channel: "DPERF000001", ts: posted.ts, text: "Fixture final" });
    assert.equal(responder.messages.get("DPERF000001")?.at(-1)?.text, "Fixture final");
    await assert.rejects(client.chat.postMessage({ channel: "perf-1", text: "Forbidden" }));
    await assert.rejects(client.apiCall("fixture.unknown"));
    const denied = await fetch(url + "auth.test", {
      method: "POST",
      headers: { authorization: "Bearer not-the-fixture-token" },
    });
    assert.equal(denied.status, 400);
    for (const body of ["null", '"text"', "[]", "{"]) {
      const malformed = await fetch(url + "auth.test", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
      assert.equal(malformed.status, 400);
    }
    assert.equal((await client.auth.test()).team_id, profile.teamId);
    assert.equal(records.filter((r) => r.error !== null).length, 7);
    assert.ok(records.every((r) => r.qualified === false));
    assert.ok(!JSON.stringify(records).includes(token));
  } finally {
    await responder.close();
  }
});

test("fixture identity and one global conversation namespace are required", () => {
  const bad = structuredClone(profile);
  bad.conversations[1]!.id = bad.conversations[0]!.id;
  assert.throws(() => createSlackResponder(bad, fixture, () => {}, { QM_PERF_SLACK_TEST_TOKEN: token }));
  assert.throws(() =>
    createSlackResponder(profile, { ...fixture, fixtureId: "other" }, () => {}, { QM_PERF_SLACK_TEST_TOKEN: token }),
  );
});
