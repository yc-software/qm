import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDraftOf, createLoopItemLedger, loopItemId, type IngestEntryInput } from "../src/loops/item-ledger.ts";
import { ledgerItemView, ledgerState, sortLedgerItems } from "../src/loops/ledger-view.ts";

const LOOP = "loop-1";

function entry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    loopId: LOOP,
    dedupeKey: "gmail:thread-1",
    source: "gmail",
    summary: "can you look at this?",
    sourcePayload: { source: "gmail", title: "Budget", from: "Ada", snippet: "can you look at this?" },
    sourceAt: 1_000,
    ...over,
  };
}

test("ingest creates pending items and holds the ones that arrive with a proposal", async () => {
  const ledger = createLoopItemLedger();
  const outcome = await ledger.ingest([
    entry(),
    entry({ dedupeKey: "gmail:thread-2", proposal: { data: { body: "on it" }, by: "agent" } }),
  ]);
  assert.deepEqual(outcome, { created: 2, updated: 0, skipped: 0 });
  const items = await ledger.byLoop(LOOP);
  assert.equal(items.length, 2);
  const [pending, held] = [
    items.find((i) => i.sourceKey === "gmail:thread-1")!,
    items.find((i) => i.sourceKey === "gmail:thread-2")!,
  ];
  assert.equal(ledgerState(pending), "pending");
  assert.equal(ledgerState(held), "held");
  assert.equal(held.proposal?.by, "agent");
  assert.ok(held.proposal?.at);
});

test("the ledger id is the dedupe key scoped to its loop", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry(), entry({ loopId: "loop-2" })]);
  assert.equal((await ledger.byLoop(LOOP)).length, 1);
  assert.equal((await ledger.byLoop("loop-2")).length, 1);
  assert.notEqual(loopItemId(LOOP, "k"), loopItemId("loop-2", "k"));
});

test("re-ingesting the same source event with nothing new is skipped", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  assert.deepEqual(await ledger.ingest([entry()]), { created: 0, updated: 0, skipped: 1 });
});

test("a newer source event refreshes the payload and the proposal", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "first" }, by: "agent" } })]);
  const outcome = await ledger.ingest([
    entry({
      sourceAt: 2_000,
      sourcePayload: { source: "gmail", title: "Budget", from: "Ada", snippet: "bumping this" },
      proposal: { data: { body: "second" }, by: "agent" },
    }),
  ]);
  assert.deepEqual(outcome, { created: 0, updated: 1, skipped: 0 });
  const [item] = await ledger.byLoop(LOOP);
  assert.equal(item?.sourceAt, 2_000);
  assert.equal(item?.sourcePayload?.snippet, "bumping this");
  assert.deepEqual(item?.proposal?.data, { body: "second" });
});

test("a proposal the person edited survives a sync that brings no newer message", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "agent draft" }, by: "agent" } })]);
  const [before] = await ledger.byLoop(LOOP);
  await ledger.setProposal(before!.id, { data: { body: "my own words" }, by: "human" });
  await ledger.ingest([entry({ proposal: { data: { body: "agent rewrite" }, by: "agent" } })]);
  const [after] = await ledger.byLoop(LOOP);
  assert.deepEqual(after?.proposal?.data, { body: "my own words" });
  assert.equal(after?.proposal?.by, "human");
});

test("a newer message overrides even an edited proposal", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "agent draft" }, by: "agent" } })]);
  const [before] = await ledger.byLoop(LOOP);
  await ledger.setProposal(before!.id, { data: { body: "my own words" }, by: "human" });
  await ledger.ingest([entry({ sourceAt: 5_000, proposal: { data: { body: "fresh draft" }, by: "agent" } })]);
  const [after] = await ledger.byLoop(LOOP);
  assert.deepEqual(after?.proposal?.data, { body: "fresh draft" });
});

test("actioned items are never resurrected by a stale sync", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.recordAction(item!.id, { kind: "send", outcome: "actioned", result: "sent" });
  assert.deepEqual(await ledger.ingest([entry()]), { created: 0, updated: 0, skipped: 1 });
  const [after] = await ledger.byLoop(LOOP);
  assert.equal(ledgerState(after!), "actioned");
  assert.equal(after?.actionResult, "sent");
});

test("a newer message revives a dismissed item", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.recordAction(item!.id, { kind: "dismiss", outcome: "dismissed" });
  assert.equal(ledgerState((await ledger.get(item!.id))!), "dismissed");
  await ledger.ingest([entry({ sourceAt: 9_000, proposal: { data: { body: "reply" }, by: "agent" } })]);
  const revived = await ledger.get(item!.id);
  assert.equal(ledgerState(revived!), "held");
  assert.equal(revived?.actedAt, undefined);
});

test("an actioned item cannot be actioned or edited again", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.recordAction(item!.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.recordAction(item!.id, { kind: "send", outcome: "actioned" }), null);
  assert.equal(await ledger.setProposal(item!.id, { data: { body: "late" }, by: "human" }), null);
  assert.equal(await ledger.reopen(item!.id), null);
});

test("reopen brings a dismissed item back to held when it holds a proposal", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "reply" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.recordAction(item!.id, { kind: "dismiss", outcome: "dismissed" });
  const reopened = await ledger.reopen(item!.id);
  assert.equal(ledgerState(reopened!), "held");
});

test("the thread accumulates chat turns and stays bounded", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.appendThread(item!.id, [{ role: "human", text: "make it shorter", actorId: "josh" }]);
  const after = await ledger.appendThread(item!.id, [{ role: "agent", text: "done" }]);
  assert.deepEqual(
    after?.thread?.map((m) => [m.role, m.text]),
    [
      ["human", "make it shorter"],
      ["agent", "done"],
    ],
  );
  assert.ok(after?.thread?.every((m) => m.id && m.at));
  for (let i = 0; i < 210; i++) await ledger.appendThread(item!.id, [{ role: "agent", text: `turn ${i}` }]);
  const bounded = await ledger.get(item!.id);
  assert.equal(bounded?.thread?.length, 200);
  assert.equal(bounded?.thread?.at(-1)?.text, "turn 209");
});

test("setProposal promotes a pending item to held", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  const held = await ledger.setProposal(item!.id, { data: { body: "draft" }, by: "agent", sessionId: "s1" });
  assert.equal(ledgerState(held!), "held");
  assert.equal(held?.proposal?.sessionId, "s1");
});

test("annotate merges into the source payload, leaving the item's state and proposal alone", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "on it" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  const annotated = await ledger.annotate(item!.id, { reactions: ["eyes"] });
  assert.equal(ledgerState(annotated!), "held");
  assert.deepEqual(annotated?.proposal?.data, { body: "on it" });
  assert.deepEqual(annotated?.sourcePayload, {
    source: "gmail",
    title: "Budget",
    from: "Ada",
    snippet: "can you look at this?",
    reactions: ["eyes"],
  });
  assert.equal(await ledger.annotate("no-such-item", { reactions: [] }), null);
});

test("a newer source event replaces the payload the annotation lived in", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.annotate(item!.id, { reactions: ["eyes"] });
  await ledger.ingest([entry({ sourceAt: 2_000 })]);
  assert.equal((await ledger.get(item!.id))?.sourcePayload?.reactions, undefined);
});

test("prune drops resolved items past retention and over the cap, never open ones", async () => {
  const ledger = createLoopItemLedger();
  const now = Date.now();
  await ledger.ingest([
    entry({ dedupeKey: "a" }),
    entry({ dedupeKey: "b" }),
    entry({ dedupeKey: "c" }),
    entry({ dedupeKey: "d" }),
  ]);
  const items = await ledger.byLoop(LOOP);
  const byKey = new Map(items.map((i) => [i.sourceKey, i]));
  await ledger.recordAction(byKey.get("b")!.id, { kind: "send", outcome: "actioned" });
  await ledger.recordAction(byKey.get("c")!.id, { kind: "dismiss", outcome: "dismissed" });
  await ledger.recordAction(byKey.get("d")!.id, { kind: "dismiss", outcome: "dismissed" });
  const dropped = await ledger.prune(LOOP, { maxItems: 3, retentionMs: 1, now: now + 10 });
  assert.equal(dropped, 3);
  const left = await ledger.byLoop(LOOP);
  assert.deepEqual(
    left.map((i) => i.sourceKey),
    ["a"],
  );
});

test("prune keeps resolved items inside retention while under the cap", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ dedupeKey: "a" }), entry({ dedupeKey: "b" })]);
  const items = await ledger.byLoop(LOOP);
  await ledger.recordAction(items[0]!.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.prune(LOOP, { maxItems: 50, retentionMs: 60_000 }), 0);
});

test("open items sort ahead of resolved ones, newest source event first", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([
    entry({ dedupeKey: "old", sourceAt: 1 }),
    entry({ dedupeKey: "new", sourceAt: 100 }),
    entry({ dedupeKey: "done", sourceAt: 500 }),
  ]);
  const items = await ledger.byLoop(LOOP);
  await ledger.recordAction(items.find((i) => i.sourceKey === "done")!.id, { kind: "send", outcome: "actioned" });
  const sorted = sortLedgerItems(await ledger.byLoop(LOOP));
  assert.deepEqual(
    sorted.map((i) => i.sourceKey),
    ["new", "old", "done"],
  );
});

test("the ledger view exposes the generic shape and never leaks claim tokens", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "hi" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  const view = ledgerItemView(item!);
  assert.equal(view.dedupeKey, "gmail:thread-1");
  assert.equal(view.state, "held");
  assert.equal(view.source, "gmail");
  assert.deepEqual(view.sourcePayload, item!.sourcePayload);
  assert.deepEqual(view.thread, []);
  assert.equal("claimToken" in view, false);
  assert.equal("decisionToken" in view, false);
});

test("a parked item reads as failed, not dismissed", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.claim(item!.id);
  const claimed = await ledger.get(item!.id);
  await ledger.park(item!.id, "connector down", claimed!.claimToken);
  assert.equal(ledgerState((await ledger.get(item!.id))!), "failed");
});

test("a person's edit keeps the agent drafts alongside it, and new agent drafts accumulate", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "agent v1" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  assert.equal(item!.proposal?.by, "agent");
  await ledger.setProposal(item!.id, { data: { body: "my words" }, by: "human" });
  let after = (await ledger.get(item!.id))!;
  assert.equal(after.proposal?.by, "human");
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }],
  );
  await ledger.setProposal(item!.id, { data: { body: "my words 2" }, by: "human" });
  after = (await ledger.get(item!.id))!;
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }],
    "a second edit adds nothing",
  );
  await ledger.setProposal(item!.id, { data: { body: "agent v2" }, by: "agent" });
  after = (await ledger.get(item!.id))!;
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }, { body: "agent v2" }],
  );
  assert.equal(after.proposal?.by, "agent");
  for (let i = 3; i < 20; i++) await ledger.setProposal(item!.id, { data: { body: `agent v${i}` }, by: "agent" });
  assert.equal((await ledger.get(item!.id))!.agentDrafts?.length, 10, "history is bounded");
});

test("a re-ingested agent draft becomes the draft authorship is judged against, even after a human edit", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "agent v1" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.setProposal(item!.id, { data: { body: "my words" }, by: "human" });
  await ledger.ingest([entry({ sourceAt: 2_000, proposal: { data: { body: "agent v2 <!here>" }, by: "agent" } })]);
  const after = (await ledger.get(item!.id))!;
  assert.deepEqual(agentDraftOf(after)?.data, { body: "agent v2 <!here>" });
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }, { body: "agent v2 <!here>" }],
  );
  await ledger.setProposal(item!.id, { data: { body: "mine again" }, by: "human" });
  assert.deepEqual(agentDraftOf((await ledger.get(item!.id))!)?.data, { body: "agent v2 <!here>" });
});

test("setProposal can be conditioned on the draft version the caller saw", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "agent v1" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  const seenAt = item!.proposal!.at;
  assert.equal(
    await ledger.setProposal(item!.id, { data: { body: "late" }, by: "human" }, { expectedAt: seenAt - 1 }),
    null,
  );
  assert.deepEqual((await ledger.get(item!.id))!.proposal!.data, { body: "agent v1" }, "a stale write changes nothing");
  assert.ok(await ledger.setProposal(item!.id, { data: { body: "on time" }, by: "human" }, { expectedAt: seenAt }));
});

test("an item ingested without a draft still carries an empty agent-draft history", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  assert.deepEqual(item!.agentDrafts, []);
});

test("mention identities the agent ever wrote are kept even after the draft history rolls over", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "team <!here> look" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  for (let i = 0; i < 12; i++) await ledger.setProposal(item!.id, { data: { body: `calm v${i}` }, by: "agent" });
  const after = (await ledger.get(item!.id))!;
  assert.equal(after.agentDrafts?.length, 10);
  assert.ok(!after.agentDrafts!.some((d) => JSON.stringify(d.data).includes("<!here>")));
  assert.deepEqual(after.agentMentionKeys, ["!here"]);
});

test("re-ingesting the identical agent draft does not bump its timestamp", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "same" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  const at = item!.proposal!.at;
  await new Promise((r) => setTimeout(r, 3));
  await ledger.ingest([entry({ proposal: { data: { body: "same" }, by: "agent" } })]);
  assert.equal((await ledger.get(item!.id))!.proposal!.at, at);
});

test("draft identity ignores key order, as stored JSON does not preserve it", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "hi", to: ["a@x"], subject: "s" }, by: "agent" } })]);
  const [item] = await ledger.byLoop(LOOP);
  const at = item!.proposal!.at;
  await new Promise((r) => setTimeout(r, 3));
  await ledger.ingest([entry({ proposal: { data: { subject: "s", to: ["a@x"], body: "hi" }, by: "agent" } })]);
  const after = (await ledger.get(item!.id))!;
  assert.equal(after.proposal!.at, at);
  assert.equal(after.agentDrafts!.length, 1);
});
