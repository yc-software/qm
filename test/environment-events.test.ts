import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipEvent, renderSandboxProviders } from "../src/core/environment-facts.ts";
import { currentTimeBlock, renderStandingObligations } from "../src/core/orchestrator/prompt-blocks.ts";
import type { Cron, SessionEntry } from "../src/types.ts";

const member = (principalId: string, displayName = principalId.toLowerCase()) => ({ principalId, displayName });

function entry(seq: number, members: ReturnType<typeof member>[], history: SessionEntry[]): SessionEntry {
  const event = membershipEvent(members, history);
  return {
    sessionId: "s",
    seq,
    parentSeq: seq - 1,
    type: "user",
    createdAt: seq,
    scopeLabel: "channel:C1",
    payload: { text: "hello", environment: event.text, environmentSnapshot: event.record },
  };
}

test("membership changes are reported once, after the turn that first saw the roster", () => {
  const first = entry(1, [member("U1"), member("U2")], []);
  assert.equal((first.payload as { environment: string }).environment, "");
  const history: SessionEntry[] = JSON.parse(JSON.stringify([first]));
  assert.equal(membershipEvent([member("U2"), member("U1")], history).text, "");
  const second = entry(2, [member("U1"), member("U3", "Cy")], history);
  assert.equal(
    (second.payload as { environment: string }).environment,
    "Joined this conversation since your last turn: Cy (U3).\nLeft this conversation since your last turn: u2 (U2).",
  );
  assert.equal(membershipEvent([member("U1"), member("U3", "Cy")], [...history, second]).text, "");
});

test("membership is compared with the last recorded roster, and turns without a roster record none", () => {
  const first = entry(1, [member("U1")], []);
  const joined = [member("U1"), member("U2")];
  assert.match(membershipEvent(joined, [first]).text, /Joined .*U2/);
  assert.match(
    membershipEvent(joined, [first, entry(2, [member("U3")], [first])]).text,
    /Joined .*U1.*U2[^]*Left .*U3/,
  );
  assert.deepEqual(membershipEvent(undefined, [first]), { text: "" });
});

test("sandbox providers render as one sorted line naming the default", () => {
  assert.equal(
    renderSandboxProviders(["sprites", "e2b", "modal"], "e2b"),
    "## Sandboxes\nProviders: e2b (default), modal, sprites. Use `sandbox list` for details; the workspace path is $PWD.",
  );
  assert.equal(renderSandboxProviders([]), "");
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
