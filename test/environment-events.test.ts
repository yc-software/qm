import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipEvent, renderSandboxProviders } from "../src/core/environment-facts.ts";
import { currentTimeBlock, renderStandingObligations } from "../src/core/orchestrator/prompt-blocks.ts";
import type { Cron, SessionEntry } from "../src/types.ts";

const member = (principalId: string, displayName = principalId.toLowerCase(), slackId?: string) => ({
  principalId,
  displayName,
  ...(slackId ? { slackId } : {}),
});

function entry(seq: number, members: ReturnType<typeof member>[], history: SessionEntry[]): SessionEntry {
  const event = membershipEvent(members, history, "s");
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
  assert.equal(membershipEvent([member("U2"), member("U1")], history, "s").text, "");
  const second = entry(2, [member("U1"), member("u3@example.com", "Cy", "U3")], history);
  assert.equal((second.payload as { environment: string }).environment, "Joined: Cy (U3). Left: u2.");
  assert.equal(
    membershipEvent([member("U1"), member("u3@example.com", "Cy", "U3")], [...history, second], "s").text,
    "",
  );
});

test("membership is compared with the last recorded roster, and turns without a roster record none", () => {
  const first = entry(1, [member("U1")], []);
  const joined = [member("U1"), member("U2")];
  assert.equal(membershipEvent(joined, [first], "s").text, "Joined: u2 (U2).");
  assert.match(
    membershipEvent(joined, [first, entry(2, [member("U3")], [first])], "s").text,
    /^Joined: u1 \(U1\), u2 \(U2\)\. Left: u3\.$/,
  );
  assert.deepEqual(membershipEvent(undefined, [first], "s"), { text: "" });
});

test("sandbox providers render as one line, default first", () => {
  assert.equal(
    renderSandboxProviders(["sprites", "e2b", "modal"], "e2b"),
    "## Sandboxes\ne2b (default), modal, sprites. `sandbox list` for details.",
  );
  assert.equal(renderSandboxProviders([]), "");
});

test("local clock follows daylight-saving transitions and non-hour offsets", () => {
  assert.equal(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T09:59:59Z")),
    "Local time: 2026-03-08 01:59 PST (America/Los_Angeles)",
  );
  assert.equal(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T10:00:00Z")),
    "Local time: 2026-03-08 03:00 PDT (America/Los_Angeles)",
  );
  assert.equal(currentTimeBlock("Asia/Kathmandu", 0), "Local time: 1970-01-01 05:30 GMT+5:30 (Asia/Kathmandu)");
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
  assert.match(text, /^## Scheduled here \(America\/Los_Angeles\)$/m);
  assert.match(text, /^- Task 3 — 8:00 AM Mon\/Wed\/Fri$/m);
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
  assert.match(once, /— once at 2026-11-01 2:00 AM$/m);
  assert.match(
    renderStandingObligations([{ ...crons[0]!, schedule: { everyMs: 900_000 } }], [], []),
    /^## Scheduled here\n- Task 0 — every 15 min$/,
  );
  const mixed = renderStandingObligations(
    [crons[0]!, { ...crons[1]!, schedule: { cron: "30 9 * * 1-5", timezone: "Europe/London" } }],
    [],
    [],
  );
  assert.match(mixed, /^## Scheduled here\n/);
  assert.match(mixed, /- Task 1 — 9:30 AM Mon–Fri \(Europe\/London\)/);
});
