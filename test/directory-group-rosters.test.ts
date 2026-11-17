import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { recordGroupRoster } from "../src/directory/directory-store.ts";

test("group rosters come back in one read with Slack photos, skipping unknown groups", async () => {
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  await store.replace([
    {
      principalId: "U_ALICE",
      displayName: "alice",
      type: "internal",
      slackId: "U_ALICE",
      avatarUrl: "https://a.example.com/alice.png",
    },
    { principalId: "U_BOB", displayName: "bob", type: "internal", slackId: "U_BOB" },
    { principalId: "U_SAM", displayName: "sam", type: "internal", slackId: "U_SAM" },
  ]);
  await recordGroupRoster(store, "slack", "G1", ["U_ALICE", "U_BOB", "U_SAM"]);
  await recordGroupRoster(store, "slack", "G2", ["U_BOB", "U_SAM"]);

  const rosters = await store.conversationRosters(["G1", "G2", "G_UNKNOWN"]);

  assert.deepEqual(
    rosters.get("G1")?.map((m) => [m.principalId, m.avatarUrl]),
    [
      ["U_ALICE", "https://a.example.com/alice.png"],
      ["U_BOB", undefined],
      ["U_SAM", undefined],
    ],
  );
  assert.deepEqual(
    rosters.get("G2")?.map((m) => m.principalId),
    ["U_BOB", "U_SAM"],
  );
  assert.equal(rosters.has("G_UNKNOWN"), false);
  assert.equal((await store.conversationRosters([])).size, 0);
});

test("re-recording an unchanged group roster writes nothing; a changed one is written", async () => {
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  await store.replace([
    { principalId: "U_ALICE", displayName: "alice", type: "internal" },
    { principalId: "U_BOB", displayName: "bob", type: "internal" },
  ]);
  let writes = 0;
  const counted = {
    conversationMembers: store.conversationMembers,
    replaceChannels: (...args: Parameters<typeof store.replaceChannels>) => (writes++, store.replaceChannels(...args)),
  };
  await recordGroupRoster(counted, "web", "G3", ["U_ALICE", "U_BOB"]);
  await recordGroupRoster(counted, "web", "G3", ["U_BOB", "U_ALICE"]);
  assert.equal(writes, 1);
  await recordGroupRoster(counted, "web", "G3", ["U_ALICE"]);
  assert.equal(writes, 2);
  assert.deepEqual(
    (await store.conversationMembers("G3"))?.map((m) => m.principalId),
    ["U_ALICE"],
  );
});
