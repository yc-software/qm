import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

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
  await store.upsertGroup("G1", ["U_ALICE", "U_BOB", "U_SAM"]);
  await store.upsertGroup("G2", ["U_BOB", "U_SAM"]);

  const rosters = await store.groupRosters(["G1", "G2", "G_UNKNOWN"]);

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
  assert.equal((await store.groupRosters([])).size, 0);
});
