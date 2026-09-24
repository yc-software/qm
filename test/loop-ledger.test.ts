import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDraftOf, createLoopItemLedger, loopItemId, type IngestEntryInput } from "../src/loops/item-ledger.ts";
import { ledgerItemView, ledgerState, sortLedgerItems } from "../src/loops/ledger-view.ts";
import { gmailAdapter } from "../src/loops/sources/gmail.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { LoopItem } from "../src/types.ts";

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

test("same-source classification enriches push metadata without requiring a draft", async () => {
  const ledger = createLoopItemLedger();
  const raw = {
    sourceKey: "gmail:thread-1",
    title: "Receipt",
    from: "Billing",
    snippet: "Payment received",
    receivedAt: 1_000,
    gmail: { threadId: "thread-1" },
  };
  const initial = gmailAdapter.parse(raw);
  assert.ok(!("error" in initial));
  await ledger.ingest([entry({ ...initial, proposal: undefined })]);
  const classified = gmailAdapter.parse({ ...raw, automated: true, probablyResolved: true });
  assert.ok(!("error" in classified));
  assert.deepEqual(await ledger.ingest([entry({ ...classified, proposal: undefined })]), {
    created: 0,
    updated: 1,
    skipped: 0,
  });
  const [item] = await ledger.byLoop(LOOP);
  assert.equal(item!.status, "queued");
  assert.equal(item!.proposal, undefined);
  assert.equal((await ledger.summaries([LOOP]))[0]!.inboxPreview!.automated, true);
  assert.deepEqual(await ledger.ingest([entry({ ...initial, proposal: undefined })]), {
    created: 0,
    updated: 0,
    skipped: 1,
  });
  const human = gmailAdapter.parse({ ...raw, automated: false, probablyResolved: false });
  assert.ok(!("error" in human));
  assert.deepEqual(await ledger.ingest([entry({ ...human, proposal: undefined })]), {
    created: 0,
    updated: 1,
    skipped: 0,
  });
  const [summary] = await ledger.summaries([LOOP]);
  assert.equal(summary!.inboxPreview!.automated, false);
  assert.equal(summary!.inboxPreview!.probablyResolved, false);
});

test("same-source enrichment preserves human drafts, decisions, and lifecycle fields", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { data: { body: "My reply" }, by: "human" } })]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.park(item!.id, "Needs review");
  await ledger.acquireDecision(item!.id);
  const before = (await ledger.get(item!.id))!;
  assert.deepEqual(await ledger.ingest([entry({ sourcePayload: { automated: true } })]), {
    created: 0,
    updated: 1,
    skipped: 0,
  });
  const after = (await ledger.get(item!.id))!;
  assert.deepEqual(after, {
    ...before,
    sourcePayload: { ...before.sourcePayload, automated: true },
    inboxPreview: { ...before.inboxPreview, automated: true },
    updatedAt: after.updatedAt,
  });
});

test("duplicate raw push metadata preserves a ready human draft and enriched Gmail recipients", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([
    entry({
      sourcePayload: {
        automated: false,
        gmail: {
          threadId: "thread-1",
          to: ["sender@example.com", "teammate@example.com"],
          cc: ["reviewer@example.com"],
          rfcMessageId: "<message@example.com>",
        },
        context: [{ author: "Ada", text: "Earlier question" }],
      },
      proposal: { data: { body: "My reply" }, by: "human" },
    }),
  ]);
  const [before] = await ledger.byLoop(LOOP);
  assert.deepEqual(
    await ledger.ingest([entry({ sourcePayload: { gmail: { threadId: "thread-1", to: ["sender@example.com"] } } })]),
    { created: 0, updated: 0, skipped: 1 },
  );
  assert.deepEqual(await ledger.get(before!.id), before);
});

test("classification enrichment rejects older, missing, and resolved source updates", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  for (const sourceAt of [999, undefined]) {
    assert.deepEqual(await ledger.ingest([entry({ sourceAt, sourcePayload: { automated: true } })]), {
      created: 0,
      updated: 0,
      skipped: 1,
    });
    assert.equal((await ledger.get(item!.id))!.sourcePayload!.automated, undefined);
  }
  for (const outcome of ["dismissed", "actioned"] as const) {
    await ledger.recordAction(item!.id, { kind: outcome, outcome });
    const before = await ledger.get(item!.id);
    assert.deepEqual(await ledger.ingest([entry({ sourcePayload: { automated: true } })]), {
      created: 0,
      updated: 0,
      skipped: 1,
    });
    assert.deepEqual(await ledger.get(item!.id), before);
  }
});

test("automated retention uses message age and preserves drafts, outputs, claims, and decisions", async () => {
  const ledger = createLoopItemLedger();
  const now = Date.now();
  for (const [key, overrides] of [
    ["old-gmail", {}],
    ["old-slack", { source: "slack" }],
    ["human", { sourcePayload: { automated: false } }],
    ["human-draft", { proposal: { data: { body: "Keep my reply" }, by: "human" as const } }],
    ["agent-draft", { proposal: { data: { body: "Reply" }, by: "agent" as const } }],
    ["other-source", { source: "webhook" }],
    ["working", {}],
    ["outputs", {}],
    ["deciding", {}],
    ["expired-decision", {}],
  ] satisfies Array<[string, Partial<IngestEntryInput>]>) {
    await ledger.ingest([entry({ dedupeKey: key, sourceAt: 1_000, sourcePayload: { automated: true }, ...overrides })]);
  }
  const id = (key: string) => loopItemId(LOOP, key);
  await ledger.claim(id("working"), now);
  const outputs = await ledger.claim(id("outputs"), now);
  await ledger.markReady(id("outputs"), ["output-1"], outputs!.claimToken!);
  await ledger.acquireDecision(id("deciding"), now);
  await ledger.acquireDecision(id("expired-decision"), now - 300_001);
  await ledger.ingest([
    entry({ dedupeKey: "old-gmail", sourceAt: 1_000, sourcePayload: { automated: true, from: "Enriched today" } }),
  ]);
  assert.equal(await ledger.prune(LOOP, { includeAutomated: true, maxItems: 500, retentionMs: 86_400_000, now }), 3);
  assert.deepEqual((await ledger.byLoop(LOOP)).map((item) => item.sourceKey).sort(), [
    "agent-draft",
    "deciding",
    "human",
    "human-draft",
    "other-source",
    "outputs",
    "working",
  ]);
});

test("automated retention bounds the oldest messages without deleting unresolved human work", async () => {
  const ledger = createLoopItemLedger();
  for (let n = 1; n <= 3; n++) {
    await ledger.ingest([entry({ dedupeKey: String(n), sourceAt: n, sourcePayload: { automated: true } })]);
  }
  await ledger.ingest([entry({ dedupeKey: "human", sourceAt: 1 })]);
  assert.equal(await ledger.prune(LOOP, { includeAutomated: true, maxItems: 2, retentionMs: 10_000, now: 4 }), 2);
  assert.deepEqual((await ledger.byLoop(LOOP)).map((item) => item.sourceKey).sort(), ["3", "human"]);
});

test("automated retention falls back to creation time rather than enrichment time", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ sourceAt: undefined, sourcePayload: { automated: true } })]);
  const [item] = await ledger.byLoop(LOOP);
  await ledger.annotate(item!.id, { from: "Updated later" });
  assert.equal(
    await ledger.prune(LOOP, { includeAutomated: true, maxItems: 500, retentionMs: 100, now: item!.createdAt + 100 }),
    1,
  );
});

test("automated retention cannot delete a draft or newer source written after its snapshot", async () => {
  for (const change of ["draft", "source"]) {
    const backing = createMemoryMap<LoopItem>();
    const conditionalDelete = backing.deleteIf!;
    const ledger = createLoopItemLedger(backing);
    await ledger.ingest([
      entry({ dedupeKey: "changed", sourcePayload: { automated: true } }),
      entry({ dedupeKey: "unchanged", sourcePayload: { automated: true } }),
    ]);
    const target = loopItemId(LOOP, "changed");
    backing.deleteIf = async (id, predicate) => {
      if (id === target) {
        if (change === "draft") await ledger.setProposal(id, { data: { body: "Keep my reply" }, by: "human" });
        else
          await ledger.ingest([entry({ dedupeKey: "changed", sourceAt: 2_000, sourcePayload: { automated: true } })]);
      }
      return conditionalDelete(id, predicate);
    };
    assert.equal(await ledger.prune(LOOP, { includeAutomated: true, maxItems: 500, retentionMs: 100, now: 10_000 }), 1);
    const remaining = await ledger.byLoop(LOOP);
    assert.deepEqual(
      remaining.map((item) => item.id),
      [target],
    );
    if (change === "draft") assert.equal(remaining[0]!.proposal!.data.body, "Keep my reply");
    else assert.equal(remaining[0]!.sourceAt, 2_000);
  }
});

test("retention skips all messages when the backing lacks atomic deletion", async () => {
  const backing = createMemoryMap<LoopItem>();
  delete backing.deleteIf;
  const ledger = createLoopItemLedger(backing);
  await ledger.ingest([entry({ sourcePayload: { automated: true } }), entry({ dedupeKey: "resolved" })]);
  await ledger.recordAction(loopItemId(LOOP, "resolved"), { kind: "dismiss", outcome: "dismissed" });
  backing.delete = async () => assert.fail("Pruning must not use unconditional deletion");
  assert.equal(await ledger.prune(LOOP, { includeAutomated: true, maxItems: 0, retentionMs: 100, now: 10_000 }), 0);
  assert.equal((await ledger.byLoop(LOOP)).length, 2);
});

test("automated classification clears stale agent drafts even when the payload is unchanged", async () => {
  for (const automated of [false, true]) {
    const ledger = createLoopItemLedger();
    await ledger.ingest([
      entry({ sourcePayload: { automated }, proposal: { by: "agent", data: { body: "Stale reply" } } }),
    ]);
    const [before] = await ledger.byLoop(LOOP);
    assert.deepEqual(await ledger.ingest([entry({ sourcePayload: { automated: true } })]), {
      created: 0,
      updated: 1,
      skipped: 0,
    });
    const item = (await ledger.get(before!.id))!;
    assert.equal(item.proposal, undefined);
    assert.equal(item.status, "ready");
    assert.equal(item.sourcePayload!.automated, true);
    assert.deepEqual(item.agentDrafts, before!.agentDrafts);
  }
});

test("automated reclassification waits for an active decision before removing an agent draft", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ proposal: { by: "agent", data: { body: "Under review" } } })]);
  const [item] = await ledger.byLoop(LOOP);
  const token = await ledger.acquireDecision(item!.id);
  const before = await ledger.get(item!.id);
  await assert.rejects(ledger.ingest([entry({ sourcePayload: { automated: true } })]), /active decision/);
  assert.deepEqual(await ledger.get(item!.id), before);
  await ledger.releaseDecision(item!.id, token!);
  await ledger.ingest([entry({ sourcePayload: { automated: true } })]);
  assert.equal((await ledger.get(item!.id))!.proposal, undefined);
});

test("classification prevents an in-flight worker from restoring an automated reply draft", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry()]);
  const [item] = await ledger.byLoop(LOOP);
  const claimed = await ledger.claim(item!.id);
  await ledger.ingest([entry({ sourcePayload: { automated: true } })]);
  assert.equal(
    await ledger.setProposal(
      item!.id,
      { by: "agent", data: { body: "Outdated background reply" } },
      { expectedClaimToken: claimed!.claimToken! },
    ),
    null,
  );
  assert.equal((await ledger.get(item!.id))!.proposal, undefined);
  await ledger.markReady(item!.id, [], claimed!.claimToken!);
  assert.ok(await ledger.setProposal(item!.id, { by: "agent", data: { body: "Explicitly requested reply" } }));
  assert.ok(await ledger.setProposal(item!.id, { by: "human", data: { body: "My edited reply" } }));
  await ledger.ingest([entry({ sourcePayload: { automated: true } })]);
  assert.equal((await ledger.get(item!.id))!.proposal!.data.body, "My edited reply");
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

test("continuing a sent reply clears the old draft without losing chat or allowing a second reset", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([
    entry({ sourcePayload: { sentChat: true }, proposal: { data: { body: "First reply" }, by: "human" } }),
  ]);
  const item = (await ledger.byLoop(LOOP))[0]!;
  await ledger.appendThread(item.id, [{ role: "human", text: "Help with this thread" }]);
  await ledger.recordAction(item.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.reopen(item.id), null);
  const reply = await ledger.reopen(item.id, { sentReply: true });
  assert.equal(reply!.proposal!.data.body, "");
  assert.ok(reply!.proposal!.at > item.proposal!.at);
  assert.equal(reply!.thread![0]!.text, "Help with this thread");
  assert.equal(ledgerState(reply!), "held");
  assert.equal(await ledger.reopen(item.id, { sentReply: true }), null);
  assert.equal(
    await ledger.setProposal(
      item.id,
      { data: { body: "Stale resend" }, by: "human" },
      { expectedAt: item.proposal!.at },
    ),
    null,
  );
  await ledger.ingest([entry({ dedupeKey: "ordinary" })]);
  const ordinary = (await ledger.byLoop(LOOP)).find((item) => item.sourceKey === "ordinary")!;
  await ledger.recordAction(ordinary.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.reopen(ordinary.id, { sentReply: true }), null);
});

test("generic loop pruning keeps unresolved automated inputs unless inbox retention is requested", async () => {
  const ledger = createLoopItemLedger();
  await ledger.ingest([entry({ sourceAt: 1, sourcePayload: { automated: true } })]);
  assert.equal(await ledger.prune(LOOP, { maxItems: 0, retentionMs: 1, now: 100 }), 0);
  assert.equal((await ledger.byLoop(LOOP)).length, 1);
});
