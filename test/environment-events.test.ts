import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentTimeBlock,
  guidanceUpdateEvent,
  membershipEvent,
  renderSandboxProviders,
  renderStandingObligations,
} from "../src/core/orchestrator/prompt-blocks.ts";
import { type Item, storedItem } from "../src/sessions/items.ts";
import type { Cron } from "../src/triggers/types.ts";

const member = (principalId: string, displayName = principalId.toLowerCase(), slackId?: string) => ({
  principalId,
  displayName,
  ...(slackId ? { slackId } : {}),
});

function entry(seq: number, members: ReturnType<typeof member>[], history: Item[]): Item {
  const event = membershipEvent(members, history, "s");
  return storedItem(
    { kind: "UserMessage", text: "hello", body: { environment: event.text, rosterSnapshot: event.record } },
    { sessionId: "s", seq, createdAt: seq },
  );
}

test("membership changes are reported once, after the turn that first saw the roster", () => {
  const first = entry(1, [member("U1"), member("U2")], []);
  assert.equal(first.body.environment, "");
  const history: Item[] = JSON.parse(JSON.stringify([first]));
  assert.equal(membershipEvent([member("U2"), member("U1")], history, "s").text, "");
  const second = entry(2, [member("U1"), member("u3@example.com", "Cy", "U3")], history);
  assert.equal(second.body.environment, "Joined: Cy (u3@example.com, U3). Left: u2.");
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

test("sandbox providers render the default first, and point at sandbox list only where it exists", () => {
  const line = renderSandboxProviders(["sprites", "e2b", "modal"], "e2b");
  assert.match(line, /^## Sandboxes\ne2b \(default\), /);
  assert.match(line, /sandbox list/);
  assert.doesNotMatch(renderSandboxProviders(["e2b"], "e2b", false), /sandbox list/);
  assert.equal(renderSandboxProviders([]), "");
});

test("sandbox providers name which computers sit behind the egress proxy and which clients fail there", () => {
  const line = renderSandboxProviders(["sprites", "e2b", "modal"], "sprites", true, ["modal", "sprites"]);
  assert.match(line, /\nComputers on modal, sprites reach the network only through the egress proxy/);
  assert.match(line, /urllib/);
  assert.doesNotMatch(line.split("\n")[2] ?? "", /e2b/);
  assert.doesNotMatch(renderSandboxProviders(["sprites", "e2b"], "e2b", true, ["modal"]), /egress proxy/);
  assert.doesNotMatch(renderSandboxProviders(["e2b"], "e2b"), /egress proxy/);
});

test("the local time names the user's zone", () => {
  const line = currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T10:00:00Z"));
  assert.match(line, /2026-03-08 03:00/);
  assert.match(line, /\(America\/Los_Angeles\)$/);
});

test("scheduled work lists every title with a readable timing and no ids, owners or task bodies", () => {
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
  assert.match(text, /^- Task 3 — .*8:00 AM.*Mon.*Wed.*Fri/m);
  assert.doesNotMatch(text, /cron-1|private instructions|private-owner/);
  const fallback = renderStandingObligations(
    [{ ...crons[0]!, schedule: { cron: "0 8 * * FRI#L", timezone: "America/Los_Angeles" } }],
    [],
    [],
  );
  assert.match(fallback, /last Friday/);
  const mixed = renderStandingObligations(
    [crons[0]!, { ...crons[1]!, schedule: { cron: "30 9 * * 1-5", timezone: "Europe/London" } }],
    [],
    [],
  );
  assert.match(mixed, /Task 0 .*America\/Los_Angeles/);
  assert.match(mixed, /Task 1 .*Europe\/London/);
});

test("schedules the short form can't express fall back to cronstrue's wording", () => {
  const cron = (expr: string): Cron => ({
    id: "c",
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    createdAt: 0,
    enabled: true,
    title: "T",
    action: "x",
    schedule: { cron: expr, timezone: "UTC" },
  });
  assert.match(renderStandingObligations([cron("0 8 * * 1-5")], [], []), /- T — 8:00 AM Mon\/Tue\/Wed\/Thu\/Fri$/m);
  assert.match(renderStandingObligations([cron("0 8 * * 1#2")], [], []), /second Monday/);
  assert.match(renderStandingObligations([cron("0 8 1 * *")], [], []), /day 1 of the month/);
});

const revision = (version: number, content: string, sessionId?: string) => ({
  scopeId: "personal:u1" as const,
  content,
  version,
  updatedAt: version,
  ...(sessionId ? { sessionId } : {}),
});

function guidanceTurn(seq: number, guidance: Parameters<typeof guidanceUpdateEvent>[0], history: Item[]) {
  const event = guidanceUpdateEvent(guidance, history, "s");
  const turn = storedItem(
    { kind: "UserMessage", text: "hi", body: { environment: event.text, guidanceSnapshot: event.record } },
    { sessionId: "s", seq, createdAt: seq },
  );
  return { event, history: [...history, turn] };
}

test("a guidance change made in another session is announced once on this session's next turn", () => {
  const v1 = revision(1, "Be brief.");
  const v2 = revision(2, "Be brief.\nNever cite a PR by bare number.", "1aedf13a-0000-4000-8000-000000000000");
  const first = guidanceTurn(1, { version: 1, personal: true, revisions: [v1] }, []);
  assert.equal(first.event.text, "");
  const second = guidanceTurn(2, { version: 2, personal: true, revisions: [v2, v1] }, first.history);
  assert.equal(
    second.event.text,
    'In a different session (1aedf13) the user updated their standing guidance: "Never cite a PR by bare number.". ' +
      "Follow it moving forward but no need to directly mention you're doing so.",
  );
  assert.equal(guidanceTurn(3, { version: 2, personal: true, revisions: [v2, v1] }, second.history).event.text, "");
});

test("guidance this session wrote itself is not announced back to it", () => {
  const v1 = revision(1, "Be brief.");
  const v2 = revision(2, "Be terse.", "s");
  const first = guidanceTurn(1, { version: 1, personal: true, revisions: [v1] }, []);
  assert.equal(guidanceTurn(2, { version: 2, personal: true, revisions: [v2, v1] }, first.history).event.text, "");
});

test("removed guidance and edits made outside any session are announced too", () => {
  const v1 = revision(1, "Be brief.\nUse metric units.");
  const v2 = revision(2, "Be brief.");
  const first = guidanceTurn(1, { version: 1, personal: false, revisions: [v1] }, []);
  assert.equal(
    guidanceTurn(2, { version: 2, personal: false, revisions: [v2, v1] }, first.history).event.text,
    'Outside this session this conversation\'s standing guidance was updated, removing: "Use metric units.". ' +
      "Follow it moving forward but no need to directly mention you're doing so.",
  );
});

test("when the revision this session last saw has been pruned, the notice points at the current instructions", () => {
  const first = guidanceTurn(1, { version: 1, personal: true, revisions: [revision(1, "Be brief.")] }, []);
  assert.equal(
    guidanceTurn(2, { version: 40, personal: true, revisions: [revision(40, "Be terse.", "other")] }, first.history)
      .event.text,
    "In a different session (other) the user updated their standing guidance; the current text is in your instructions. " +
      "Follow it moving forward but no need to directly mention you're doing so.",
  );
});
