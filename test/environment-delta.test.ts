import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentDelta, renderSandboxProfiles } from "../src/core/environment-facts.ts";
import type { ListSection } from "../src/types.ts";
import { currentTimeBlock, renderStandingObligations } from "../src/core/orchestrator/prompt-blocks.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import type { Cron, SessionEntry } from "../src/types.ts";

function entry(
  seq: number,
  blocks: Record<string, string>,
  history: SessionEntry[],
  growing: Record<string, ListSection> = {},
): SessionEntry {
  const snapshot = environmentDelta(blocks, history, "s", growing);
  return {
    sessionId: "s",
    seq,
    parentSeq: seq - 1,
    type: "user",
    createdAt: seq,
    scopeLabel: "personal:U1",
    payload: { text: "hello", environment: snapshot.text, environmentSnapshot: snapshot.record },
  };
}

test("snapshots survive serialized replay and emit only changed or removed inventories", () => {
  const original = { Credentials: "## Credentials\n- a\n- b", Sandboxes: "## Sandboxes\n- box" };
  const first = entry(1, original, []);
  const history: SessionEntry[] = JSON.parse(JSON.stringify([first]));
  assert.equal(environmentDelta(original, history, "s").text, "");
  const changed = { Credentials: "## Credentials\n- b\n- c" };
  const second = entry(2, changed, history);
  const text = (second.payload as { environment: string }).environment;
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
  assert.doesNotMatch(JSON.stringify(delta.payload), /## Skills.*## Skills/);
  assert.ok(
    !JSON.stringify((delta.payload as { environmentSnapshot: unknown }).environmentSnapshot).includes("browse"),
  );
});

const environmentOf = (e: SessionEntry) => (e.payload as { environment: string }).environment;
const skills = (names: string[], total = 9, describe = (n: string) => `does ${n}`): ListSection => ({
  head: `## Skills\nShowing ${names.length} of ${total} available skills.`,
  entries: new Map(names.map((n) => [n, `- **${n}** — ${describe(n)}`])),
});
const whole = (section: ListSection) => [section.head, ...section.entries.values()].join("\n");

test("a growing shortlist sends only entries the model has not seen since the baseline", () => {
  const first = entry(1, {}, [], { Skills: skills(["browse", "publish", "memory"]) });
  const second = entry(2, {}, [first], { Skills: skills(["browse", "trace", "memory"]) });
  const added = environmentOf(second).split("\n\n")[1]!;
  assert.match(added, /- \*\*trace\*\*/);
  assert.doesNotMatch(added, /browse|memory|publish|Showing/);
  const third = entry(3, {}, JSON.parse(JSON.stringify([first, second])), {
    Skills: skills(["publish", "trace", "browse"]),
  });
  assert.equal(environmentOf(third), "");
  const recount = skills(["publish", "trace", "browse"], 10);
  assert.equal(
    environmentOf(entry(4, {}, [first, second, third], { Skills: recount })).split("\n\n")[1],
    whole(recount),
  );
  const edited = skills(["publish", "trace"], 9, (n) => (n === "trace" ? "now traces more" : `does ${n}`));
  assert.equal(environmentOf(entry(4, {}, [first, second, third], { Skills: edited })).split("\n\n")[1], whole(edited));
  const reset = environmentDelta({}, forModelContext([third]), "s", { Skills: skills(["publish"]) });
  assert.equal(reset.text, whole(skills(["publish"])));
  assert.match(environmentDelta({}, [first], "s").text, /No longer included: Skills/);
});

test("a baseline that listed the shortlist as a replaced section resends it whole, not as removed", () => {
  const first = entry(1, { Skills: whole(skills(["browse"])), Where: "## Where you are\nweb" }, []);
  const next = environmentDelta({ Where: "## Where you are\nweb" }, [first], "s", { Skills: skills(["trace"]) });
  assert.match(next.text, /\n\n## Skills\nShowing 1 of 9/);
  assert.doesNotMatch(next.text, /No longer included|## Where you are/);
});
