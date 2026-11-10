import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("Slack group DM contexts list the other members with their Slack photos", async () => {
  const { app, directory } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ctx-group-")) }));
  await directory.replace([
    { principalId: "U1", displayName: "sam", type: "internal", slackId: "U1" },
    {
      principalId: "U2",
      displayName: "alice",
      type: "internal",
      slackId: "U2",
      avatarUrl: "https://a.example.com/a.png",
    },
    {
      principalId: "U3",
      displayName: "bob",
      type: "internal",
      slackId: "U3",
      avatarUrl: "http://insecure.example.com/b.png",
    },
  ]);
  await directory.upsertGroup("G1", ["U1", "U2", "U3"]);
  await app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "group", threadRef: "grp:G1:t1", channelRef: "G1", isMpim: true },
    text: "hello",
  });

  const group = (await app.listContexts("U1")).find((context) => context.scopeId === "group:G1");

  assert.deepEqual(group?.groupMembers, [
    { principalId: "U2", displayName: "alice", avatarUrl: "https://a.example.com/a.png" },
    { principalId: "U3", displayName: "bob" },
  ]);
});
