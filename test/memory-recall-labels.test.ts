import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRecallLabels } from "../src/memory/recall-labels.ts";

const project = "group:web-project-example";

test("recall headings use stored names without requesting any rosters", async () => {
  const lookups: string[] = [];
  const labels = await memoryRecallLabels(
    [
      "personal:alice",
      "personal:bob@example.com",
      "org:acme",
      "channel:C1",
      project,
      "group:G1",
      "group:C2",
      "channel:unknown",
    ],
    {
      get: async (id) => {
        lookups.push(`person:${id}`);
        return id === "alice" ? { principalId: id, type: "internal", displayName: "Alice" } : null;
      },
      resolveChannel: async (id) => {
        lookups.push(`channel:${id}`);
        return {
          kind: "one",
          channel: id === "C2" ? { channelId: "C2", name: "Alice, Bob" } : { channelId: "C1", name: "engineering" },
        };
      },
    },
    {
      recognizes: (ref) => ref === "web-project-example",
      name: async (ref) => {
        lookups.push(`project:${ref}`);
        return "Launch plan";
      },
    },
  );
  assert.equal(labels.get("personal:alice"), "Alice");
  assert.equal(labels.get("personal:bob@example.com"), "bob@example.com");
  assert.equal(labels.get("org:acme"), "Organization");
  assert.equal(labels.get("channel:C1"), "#engineering");
  assert.equal(labels.get(project), "Launch plan (web project)");
  assert.equal(labels.get("group:G1"), "group:G1");
  assert.equal(labels.get("group:C2"), "Alice, Bob");
  assert.equal(labels.get("channel:unknown"), "channel:unknown");
  assert.deepEqual(
    lookups.sort(),
    [
      "channel:C1",
      "channel:C2",
      "channel:G1",
      "channel:unknown",
      "person:alice",
      "person:bob@example.com",
      "project:web-project-example",
    ].sort(),
  );
});
