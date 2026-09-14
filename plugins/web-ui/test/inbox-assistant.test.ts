import assert from "node:assert/strict";
import test from "node:test";
import { inboxAssistantContext } from "../server/inbox-assistant.ts";

const items = [
  {
    id: "email/1",
    source: "gmail",
    state: "held",
    sourcePayload: { title: "Design feedback", from: "Alex", snippet: "Please review" },
  },
  { id: "slack1", source: "slack", state: "dismissed", sourcePayload: { title: "Team updates" } },
];

test("inbox context follows the authenticated person's loop and selected filter", async () => {
  const paths: string[] = [];
  const header = await inboxAssistantContext(
    async (path) => {
      paths.push(path);
      return { status: 200, text: JSON.stringify(paths.length === 1 ? { loop: { id: "loop/1" } } : { items }) };
    },
    "alice@example.com",
    "gmail",
    "https://qm.example",
  );
  assert.deepEqual(paths, [
    "/v1/loops/inbox?principalId=alice%40example.com",
    "/v1/loops/loop%2F1/items?principalId=alice%40example.com",
  ]);
  assert.match(header, /Design feedback/);
  assert.match(header, /https:\/\/qm.example\/inbox\/email%2F1/);
  assert.doesNotMatch(header, /Team updates/);
  assert.match(header, /untrusted message data/);
  assert.match(header, /not the entire mailbox/);
});

test("empty inbox still permits searching connected tools", async () => {
  const header = await inboxAssistantContext(
    async () => ({ status: 200, text: '{"loop":null}' }),
    "alice",
    "all",
    "https://qm.example",
  );
  assert.match(header, /Inbox loop: none/);
  assert.match(header, /0 of 0 items/);
  assert.match(header, /Search connected email/);
});

test("failed reads are surfaced rather than presented as an empty inbox", async () => {
  await assert.rejects(
    inboxAssistantContext(async () => ({ status: 403, text: "" }), "alice", "all", "https://qm.example"),
    /Could not load/,
  );
});

test("large inboxes retain valid bounded JSON and disclose omitted items", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    ...items[0],
    id: String(i),
    sourcePayload: { snippet: "a".repeat(3000) },
  }));
  const header = await inboxAssistantContext(
    async (path) => ({
      status: 200,
      text: JSON.stringify(path.includes("/items?") ? { items: many } : { loop: { id: "l" } }),
    }),
    "alice",
    "all",
    "https://qm.example",
  );
  assert.match(header, /80 of 120 items/);
  const snapshot = JSON.parse(header.split("\n\n").at(-1)!);
  assert.equal(snapshot.length, 80);
  assert.equal(snapshot[0].snippet.length, 1000);
});
