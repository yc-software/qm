import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentDelta, renderSandboxProfiles } from "../src/core/environment-facts.ts";
import { currentTimeBlock, renderStandingObligations } from "../src/core/orchestrator/prompt-blocks.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import type { Cron } from "../src/types.ts";
import { storedItem, type Item } from "../src/sessions/items.ts";

function entry(seq: number, blocks: Record<string, string>, history: Item[]): Item {
  const snapshot = environmentDelta(blocks, history, "s");
  return storedItem(
    {
      kind: "UserMessage",
      text: "hello",
      body: { environment: snapshot.text, environmentSnapshot: snapshot.record },
    },
    { sessionId: "s", seq, createdAt: seq },
  );
}

test("snapshots survive serialized replay and emit only changed or removed inventories", () => {
  const original = { Credentials: "## Credentials\n- a\n- b", Sandboxes: "## Sandboxes\n- box" };
  const first = entry(1, original, []);
  const history: Item[] = JSON.parse(JSON.stringify([first]));
  assert.equal(environmentDelta(original, history, "s").text, "");
  const changed = { Credentials: "## Credentials\n- b\n- c" };
  const second = entry(2, changed, history);
  const text = String(second.body.environment);
  assert.match(text, /replace their earlier versions/);
  assert.match(text, /- c/);
  assert.doesNotMatch(text, /- a|- box/);
  assert.match(text, /No longer included: Sandboxes/);
  assert.equal(environmentDelta(changed, [...history, second], "s").text, "");
  const replay = reconstructMessagesFromHistory([...history, second]);
  assert.match(JSON.stringify(replay), /No longer included: Sandboxes/);
});

test("a compacted-away snapshot anchor resets the full baseline even when a later delta remains", () => {
  const blocks = { Credentials: "## Credentials\n- a", Skills: "## Skills\n- browse" };
  const first = entry(1, blocks, []);
  const second = entry(2, { ...blocks, Credentials: "## Credentials\n- b" }, [first]);
  const retained = forModelContext([second]);
  const reset = environmentDelta({ ...blocks, Credentials: "## Credentials\n- b" }, retained, "s");
  assert.match(reset.text, /## Skills/);
  assert.doesNotMatch(reset.text, /Environment changes/);
  assert.equal(reset.record.anchorSeq, undefined);
});

test("unrecorded attempts never advance the baseline; an emitted retry becomes the next baseline", () => {
  const blocks = { Skills: "## Skills\n- browse" };
  const first = entry(1, blocks, []);
  const changed = { Skills: "## Skills\n- search" };
  const attempt = environmentDelta(changed, [first], "s");
  assert.equal(environmentDelta(changed, [first], "s").text, attempt.text);
  const retry = entry(2, changed, [first]);
  assert.equal(environmentDelta(changed, [first, retry], "s").text, "");
  assert.match(environmentDelta({}, [first, retry], "s").text, /No longer included: Skills/);
});

test("local ISO clock follows daylight-saving transitions and non-hour offsets", () => {
  assert.match(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T09:59:59Z")),
    /2026-03-08T01:59:59-08:00/,
  );
  assert.match(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T10:00:00Z")),
    /2026-03-08T03:00:00-07:00/,
  );
  assert.match(currentTimeBlock("Asia/Kathmandu", 0), /1970-01-01T05:30:00\+05:30/);
});

test("standing work includes all titles and readable timings, not IDs, owners or task bodies", () => {
  const crons: Cron[] = Array.from({ length: 15 }, (_, i) => ({
    id: `cron-${i}`,
    ownerScopeId: "personal:U1",
    owner: "private-owner",
    createdBy: "U1",
    createdAt: 0,
    enabled: true,
    title: `Task ${i}`,
    action: "private instructions",
    schedule: { cron: "0 8 * * 1,3,5", timezone: "America/Los_Angeles" },
  }));
  const text = renderStandingObligations(crons, [], []);
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 15);
  assert.match(text, /Task 14/);
  assert.match(text, /08:00 AM, only on Monday, Wednesday, and Friday/);
  assert.doesNotMatch(text, /cron-1|private instructions|private-owner|and .* more/);
  assert.match(
    renderStandingObligations(
      [{ ...crons[0]!, schedule: { cron: "0 8 * * FRI#L", timezone: "America/Los_Angeles" } }],
      [],
      [],
    ),
    /last Friday/,
  );
  const once = renderStandingObligations(
    [{ ...crons[0]!, schedule: { firstFireAt: Date.parse("2026-11-01T10:00:00Z") } }],
    [],
    [],
  );
  assert.match(once, /2026-11-01T02:00:00-08:00/);
});

test("live provider profiles represent configured and unknown capabilities without personal resources", () => {
  const inventory = renderSandboxProfiles(
    [
      { name: "modal", actions: ["create"], spec: { os: "Linux", tools: ["node"] } },
      { name: "sprites", actions: ["create"] },
    ],
    { hasGlobal: false, teamCount: 0 },
  );
  assert.match(inventory["Sandbox provider modal"]!, /node/);
  assert.match(inventory["Sandbox provider sprites"]!, /unknown/);
});

test("forked entries cannot mistake a resequenced row for the original snapshot anchor", () => {
  const blocks = { Skills: "## Skills\n- browse" };
  const original = entry(5, blocks, []);
  const delta = entry(8, blocks, [original]);
  const fork = [
    { ...original, sessionId: "fork", seq: 0 },
    { ...delta, sessionId: "fork", seq: 1 },
  ];
  assert.equal(environmentDelta(blocks, fork, "fork").text, blocks.Skills);
  assert.equal(environmentDelta(blocks, fork.slice(1), "fork").text, blocks.Skills);
  assert.doesNotMatch(JSON.stringify(delta.body), /## Skills.*## Skills/);
  assert.ok(!JSON.stringify(delta.body.environmentSnapshot).includes("browse"));
});
