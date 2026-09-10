import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_SOFT_FRACTION,
  MAX_COMPACT_SUMMARY_CHARS,
  boundCompactSummary,
  compactedScopeLabel,
  deterministicCompactSummary,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
} from "../src/harness/context-compaction.ts";
import { countTokens } from "../src/util/tokens.ts";
import type { Harness, HarnessCompactInput } from "../src/harness/harness.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { contextSummaryPayload, createContextSummaryPayload } from "../src/sessions/session-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId, type Conversation, type Principal, type SessionEntry } from "../src/types.ts";

const ORG = "default-org";
const tokensOf = (...texts: string[]): number => texts.reduce((n, t) => n + countTokens(t), 0);
const msgTexts = (n: number): string[] => Array.from({ length: n }, (_, i) => `msg ${i}`);
const KEEP_RECENT_TOKEN_FRACTION = 0.6;
const budgetBetweenSoftAndHard = (historyTokens: number): number =>
  Math.round(historyTokens / ((COMPACT_SOFT_FRACTION + COMPACT_HARD_FRACTION) / 2));
const budgetKeepingOnlyNewest = (...newestTwoTexts: string[]): number => tokensOf(...newestTwoTexts);
const budgetWhoseKeepWindowFits = (keepTokens: number): number => Math.ceil(keepTokens / KEEP_RECENT_TOKEN_FRACTION);
const actor: Principal = { id: "U1", type: "internal", teamIds: ["eng"] };
const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
const PERSONAL = scopeId("personal", "U1");
const ORG_SCOPE = scopeId("org", ORG);
const TEAM = scopeId("team", "eng");

function spyHarness(opts: { withSummarizer?: boolean } = {}) {
  const base = createMockHarness();
  const compactCalls: HarnessCompactInput[] = [];
  const resetCalls: string[] = [];
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      resetSession(sessionId: string) {
        resetCalls.push(sessionId);
      },
    },
    models: { ...base.models },
  };
  if (opts.withSummarizer === false) {
    delete harness.models.compactHistory;
  } else {
    harness.models.compactHistory = async (input: HarnessCompactInput) => {
      compactCalls.push(input);
      return base.models.compactHistory!(input);
    };
  }
  return { harness, compactCalls, resetCalls };
}

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational compaction turn must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "snapshot_to_workspace",
      processSessions: false,
    },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

function buildOrchestrator(harness: Harness, maxContextTokens?: number, defaultTurnWallClockMs?: number) {
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const sessions = createMemorySessionStore();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "cc-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "cc-deploy"),
    auditLog,
    acl,
  });
  const orch = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy,
    acl,
    maxContextTokens,
    defaultTurnWallClockMs,
  });
  return { orch, sessions };
}

async function seed(sessions: SessionStore, entries: Array<Partial<SessionEntry>>): Promise<string> {
  const session = await sessions.getOrCreateByThread(conv.threadRef, "dm", PERSONAL);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease, "could not acquire lease to seed");
  for (const e of entries) {
    await sessions.append(lease!, {
      type: e.type ?? "user",
      payload: e.payload ?? { text: "x" },
      scopeLabel: (e.scopeLabel ?? PERSONAL) as never,
    });
  }
  await sessions.releaseLease(lease!);
  return session.id;
}

const turn = (text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: conv,
  origin: { kind: "direct" },
  text,
});
const spineTurn = (text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: conv,
  origin: { kind: "direct" },
  text,
  surfaceTools: true,
});

async function summaryEntries(sessions: SessionStore, sessionId: string): Promise<SessionEntry[]> {
  return (await sessions.getEntries(sessionId)).filter((e) => contextSummaryPayload(e));
}

async function waitForSummary(sessions: SessionStore, sessionId: string, deadlineMs = 3_000): Promise<SessionEntry[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await summaryEntries(sessions, sessionId);
    if (found.length || Date.now() > deadline) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForLeaseRelease(sessions: SessionStore, sessionId: string, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { lease } = await sessions.acquireLease(sessionId);
    if (lease) {
      await sessions.releaseLease(lease);
      return;
    }
    assert.ok(Date.now() < deadline, "the background pass never released the session lease");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("overflow over the injected token budget summarizes: compactHistory runs over the oldest entries, a summary is appended, the session resets, the rebuilt context is bounded", async () => {
  const { harness, compactCalls, resetCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ payload: { text } })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "compactHistory should be called on overflow");
  const summarized = compactCalls[0]!.history;
  assert.deepEqual(
    summarized.map((e) => e.seq),
    [0, 1, 2, 3, 4],
    "should summarize the oldest entries past the keep-recent budget",
  );

  const summaries = await summaryEntries(sessions, sid);
  assert.equal(contextSummaryPayload(summaries[0]!)!.throughSeq, 4, "summary throughSeq must advance to seq 4");

  assert.equal(resetCalls[0], sid, "resetSession must be called with the session id");

  assert.equal(res.reply, "history:2", "rebuilt context is [summary, keep-recent…]");
});

test("the background pass labels the lease it takes, so a turn it locks out can name what beat it", async () => {
  const { harness } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));
  const holders: Array<string | undefined> = [];
  const acquire = sessions.acquireLease.bind(sessions);
  sessions.acquireLease = async (sessionId, holder) => {
    holders.push(holder);
    return acquire(sessionId, holder);
  };

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ payload: { text } })),
  );
  assert.equal((await orch.handleTurn(turn("!histcount"))).status, "ok");

  const deadline = Date.now() + 3_000;
  while (!holders.includes("compaction") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    holders.includes("compaction"),
    "the post-turn background pass takes the lock as compaction, not as a turn",
  );
  assert.ok(holders.includes("turn"), "…and the turn itself takes it as a turn");
  await waitForLeaseRelease(sessions, sid);
});

test("token overflow triggers compaction with only a few huge entries", async () => {
  const { harness, compactCalls, resetCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 50);

  const big = "many different tokens here ".repeat(25);
  const sid = await seed(
    sessions,
    Array.from({ length: 4 }, (_, i) => ({ payload: { text: `${big} ${i}` } })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "token overflow must trigger compaction despite the low entry count");
  assert.equal(resetCalls[0], sid, "compaction resets the harness session");
  const summaries = await summaryEntries(sessions, sid);
  assert.ok(summaries.length >= 1, "a summary entry is written");
  assert.ok(
    compactCalls[0]!.history.length >= 1 && compactCalls[0]!.history.length < 4,
    "the oldest entries (not all, not none) are summarized; the newest turn stays verbatim",
  );
});

test("a prior summary that still fits is reused, not regenerated", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 1_000_000);

  const sid = await seed(sessions, [
    { payload: { text: "old 0" } },
    { payload: { text: "old 1" } },
    { payload: { text: "old 2" } },
    { payload: { text: "old 3" } },
    { type: "system", payload: createContextSummaryPayload(3, "prior summary"), scopeLabel: PERSONAL },
    { payload: { text: "new 5" } },
  ]);

  const before = await summaryEntries(sessions, sid);
  assert.equal(before.length, 1, "fixture seeds exactly one summary");

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(
    compactCalls.every((c) => c.history.some((e) => e.seq >= 6)),
    "an already-fitting summary must be reused on the hot path, not regenerated",
  );

  assert.equal(res.reply, "history:2", "reuse returns [summary, recent raw…]");
});

test("with no harness summarizer, overflow falls back to a plain slice — no summary entry written", async () => {
  const { harness, compactCalls, resetCalls } = spyHarness({ withSummarizer: false });
  assert.equal(harness.models.compactHistory, undefined, "fixture: summarizer is absent");
  const { orch, sessions } = buildOrchestrator(harness, tokensOf("msg 2", "msg 3", "msg 4", "msg 5"));

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ payload: { text } })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.equal(compactCalls.length, 0, "no summarizer → compactHistory never called");
  assert.deepEqual(resetCalls, [], "no summarizer → no session reset");
  const summaries = await summaryEntries(sessions, sid);
  assert.equal(summaries.length, 0, "fallback must NOT write a summary entry");
  assert.equal(res.reply, "history:4", "fallback returns the newest entries that fit the token budget");
});

test("a tool_call at the summarize/keep boundary whose result is KEPT is not summarized as interrupted", async () => {
  const { harness, compactCalls } = spyHarness();
  const callPayload = { tool: "execute", command: "bash refresh.sh", callId: "c1" };
  const resultPayload = { tool: "execute", callId: "c1", result: "wrote inv=89", isError: false };
  const { orch, sessions } = buildOrchestrator(
    harness,
    budgetKeepingOnlyNewest(JSON.stringify(callPayload), JSON.stringify(resultPayload)),
  );

  const sid = await seed(sessions, [
    { payload: { text: "msg 0" } },
    { payload: { text: "msg 1" } },
    { payload: { text: "msg 2" } },
    { payload: { text: "msg 3" } },
    { type: "tool_call", payload: callPayload },
    { type: "tool_result", payload: resultPayload },
  ]);

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "overflow should still trigger the inline compaction");
  assert.deepEqual(
    compactCalls[0]!.history.map((e) => e.seq),
    [0, 1, 2, 3],
    "the boundary tool_call (seq 4) must be held back with its kept result, not summarized",
  );
  const summaries = await summaryEntries(sessions, sid);
  assert.doesNotMatch(contextSummaryPayload(summaries[0]!)!.text, /interrupted/, "no false interrupted marker");
});

test("a genuinely interrupted tool_call (no result anywhere) IS marked interrupted in the summary", async () => {
  const { harness } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));

  const sid = await seed(sessions, [
    { type: "tool_call", payload: { tool: "execute", command: "bash refresh.sh", callId: "c1" } },
    { payload: { text: "(system note: the platform restarted mid-turn...)" } },
    { payload: { text: "msg 2" } },
    { payload: { text: "msg 3" } },
    { payload: { text: "msg 4" } },
    { payload: { text: "msg 5" } },
  ]);

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  const summaries = await summaryEntries(sessions, sid);
  assert.ok(summaries.length >= 1);
  assert.match(
    contextSummaryPayload(summaries[0]!)!.text,
    /interrupted/,
    "interrupted call must be flagged, not invented",
  );
});

test("compactedScopeLabel inherits the narrowest audience and refuses ambiguous cross-audience folds", async () => {
  const entry = (label: string): SessionEntry => ({
    sessionId: "s",
    seq: 0,
    parentSeq: null,
    type: "user",
    payload: { text: "x" },
    scopeLabel: label,
    createdAt: 0,
  });

  assert.equal(compactedScopeLabel([entry(PERSONAL)], PERSONAL, ORG_SCOPE), PERSONAL);
  assert.equal(compactedScopeLabel([entry(TEAM)], PERSONAL, ORG_SCOPE), TEAM);
  assert.equal(compactedScopeLabel([entry(PERSONAL), entry(ORG_SCOPE)], PERSONAL, ORG_SCOPE), PERSONAL);
  assert.equal(compactedScopeLabel([entry(PERSONAL), entry(scopeId("personal", "U2"))], PERSONAL, ORG_SCOPE), null);
  assert.equal(compactedScopeLabel([entry(ORG_SCOPE)], PERSONAL, ORG_SCOPE), ORG_SCOPE);
});

test("a summary over narrower (team) data inherits the team label, never the broader session/org floor", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("team 4", "recent 5"));

  const sid = await seed(sessions, [
    { payload: { text: "team 0" }, scopeLabel: TEAM },
    { payload: { text: "team 1" }, scopeLabel: TEAM },
    { payload: { text: "team 2" }, scopeLabel: TEAM },
    { payload: { text: "team 3" }, scopeLabel: TEAM },
    { payload: { text: "team 4" }, scopeLabel: TEAM },
    { payload: { text: "recent 5" } },
  ]);

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.ok(compactCalls.length >= 1, "the team-data overflow is still summarized");

  const summaries = await summaryEntries(sessions, sid);
  assert.ok(summaries.length >= 1);
  assert.equal(
    summaries[0]!.scopeLabel,
    TEAM,
    "the summary must inherit the narrower team label, not the session/org floor (no audience widening)",
  );
});

const mkEntry = (over: Partial<SessionEntry> & { seq: number }): SessionEntry => ({
  sessionId: "s",
  parentSeq: over.seq === 0 ? null : over.seq - 1,
  type: "user",
  payload: { text: `msg ${over.seq}` },
  scopeLabel: PERSONAL,
  createdAt: over.seq,
  ...over,
});

test("overBudgetFraction: soft < hard — the gap where a background pass runs but a turn need not block", () => {
  const history = Array.from({ length: 10 }, (_, i) => mkEntry({ seq: i }));
  const budget = budgetBetweenSoftAndHard(estimateHistoryTokens(history));
  assert.equal(overBudgetFraction(history, budget, COMPACT_SOFT_FRACTION), true, "past soft ⇒ background pass fires");
  assert.equal(overBudgetFraction(history, budget, COMPACT_HARD_FRACTION), false, "under hard ⇒ turn need not block");
  assert.ok(COMPACT_SOFT_FRACTION < COMPACT_HARD_FRACTION, "soft must be below hard");
});

test("entry count alone never triggers compaction: hundreds of tiny entries under the token budget stay uncompacted", () => {
  const history = Array.from({ length: 500 }, (_, i) => mkEntry({ seq: i, payload: { text: `tiny ${i}` } }));
  const budget = estimateHistoryTokens(history) * 4;
  assert.equal(overBudgetFraction(history, budget, COMPACT_SOFT_FRACTION), false);
  assert.equal(planCompaction(history, budget, 0.6), null);
});

test("overBudgetFraction trips on the token budget (a few huge entries)", () => {
  const big = "many different tokens here ".repeat(250);
  const history = Array.from({ length: 3 }, (_, i) => mkEntry({ seq: i, payload: { text: big } }));
  assert.equal(overBudgetFraction(history, 2_000, COMPACT_HARD_FRACTION), true);
});

test("planCompaction summarizes ONLY the evicted (oldest overflow) chunk, not the whole transcript", () => {
  const history = Array.from({ length: 8 }, (_, i) => mkEntry({ seq: i }));
  const plan = planCompaction(history, budgetWhoseKeepWindowFits(estimateHistoryTokens(history.slice(5))), 0.6)!;
  assert.ok(plan, "over budget ⇒ a plan");
  assert.deepEqual(
    plan.toSummarize.map((e) => e.seq),
    [0, 1, 2, 3, 4],
    "only the evicted chunk is summarized",
  );
  assert.deepEqual(
    plan.kept.map((e) => e.seq),
    [5, 6, 7],
    "the newest turns stay verbatim (re-pullable detail lost only from the old chunk)",
  );
  assert.equal(plan.reuse, undefined, "no prior summary to reuse");
});

test("planCompaction chains a prior summary into the batch instead of accumulating summaries", () => {
  const history: SessionEntry[] = [
    {
      sessionId: "s",
      seq: 0,
      parentSeq: null,
      type: "system",
      payload: createContextSummaryPayload(-1, "prior"),
      scopeLabel: PERSONAL,
      createdAt: 0,
    },
    ...Array.from({ length: 6 }, (_, i) => mkEntry({ seq: i + 1 })),
  ];
  const plan = planCompaction(history, budgetWhoseKeepWindowFits(estimateHistoryTokens(history.slice(-3))), 0.6)!;
  assert.ok(
    plan.toSummarize.some((e) => contextSummaryPayload(e)),
    "the prior summary is folded into the new batch",
  );
});

test("planCompaction returns null when nothing needs to move (a still-fitting prior summary is reused)", () => {
  const history: SessionEntry[] = [
    {
      sessionId: "s",
      seq: 0,
      parentSeq: null,
      type: "system",
      payload: createContextSummaryPayload(2, "prior"),
      scopeLabel: PERSONAL,
      createdAt: 0,
    },
    mkEntry({ seq: 3 }),
    mkEntry({ seq: 4 }),
  ];
  const plan = planCompaction(history, 1_000_000, 0.6)!;
  assert.equal(plan.toSummarize.length, 0, "nothing to summarize");
  assert.equal(plan.reuse?.seq, 0, "the fitting prior summary is reused");
});

test("planCompaction never splits a tool_call from its kept tool_result (no fabricated interruption)", () => {
  const history: SessionEntry[] = [
    mkEntry({ seq: 0 }),
    mkEntry({ seq: 1 }),
    {
      sessionId: "s",
      seq: 2,
      parentSeq: 1,
      type: "tool_call",
      payload: { tool: "execute", callId: "c1" },
      scopeLabel: PERSONAL,
      createdAt: 2,
    },
    {
      sessionId: "s",
      seq: 3,
      parentSeq: 2,
      type: "tool_result",
      payload: { tool: "execute", callId: "c1", result: "ok" },
      scopeLabel: PERSONAL,
      createdAt: 3,
    },
    mkEntry({ seq: 4 }),
    mkEntry({ seq: 5 }),
  ];
  const plan = planCompaction(history, budgetWhoseKeepWindowFits(estimateHistoryTokens(history.slice(3))), 0.6)!;
  assert.deepEqual(
    plan.toSummarize.map((e) => e.seq),
    [0, 1],
    "the boundary tool_call is pulled back to its kept result",
  );
  assert.deepEqual(
    plan.kept.map((e) => e.seq),
    [2, 3, 4, 5],
  );
});

for (const [kind, mkTurn] of [
  ["spine", spineTurn],
  ["DM", turn],
] as const) {
  test(`a ${kind} turn between soft and hard does NOT block on compaction; the background pass sheds it`, async () => {
    const { harness, compactCalls } = spyHarness();
    const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
    const sid = await seed(
      sessions,
      msgTexts(8).map((text) => ({ payload: { text } })),
    );

    const res = await orch.handleTurn(mkTurn("!histcount"));
    assert.equal(res.status, "ok");
    assert.equal(res.reply, "history:8", "under the hard limit the turn runs on raw history, unblocked");

    const summaries = await waitForSummary(sessions, sid);
    assert.equal(summaries.length, 1, "the background pass compacts off the hot path");
    assert.equal(compactCalls.length, 1, "exactly one (background) compaction, none inline");
  });
}

test("a model-overridden session's background pass sizes against the override's budget, not the scope default", async () => {
  const { harness, compactCalls } = spyHarness();
  const OVERRIDE = "tiny-context-model";
  const overrideBudget = budgetBetweenSoftAndHard(tokensOf(...msgTexts(8)));
  harness.models.contextTokenBudget = (_scopeLabel?: string, model?: string) =>
    model === OVERRIDE ? overrideBudget : 1_000_000;
  const { orch, sessions } = buildOrchestrator(harness);
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  const res = await orch.handleTurn({ ...turn("!histcount"), model: OVERRIDE });
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "history:8", "between soft and hard for the override ⇒ the turn itself is unblocked");

  const summaries = await waitForSummary(sessions, sid);
  assert.equal(
    summaries.length,
    1,
    "the background pass judges fullness by the override model's budget — under the scope default it would never fire",
  );
  assert.equal(compactCalls.length, 1, "exactly one background compaction against the override's budget");
});

test("a rapid follow-up that outran the background pass AND is over the HARD limit blocks and compacts inline", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, Math.floor(tokensOf(...msgTexts(8)) * COMPACT_HARD_FRACTION));
  await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  assert.ok(compactCalls.length >= 1, "over the hard limit ⇒ inline (blocking) compaction ran");
  assert.notEqual(res.reply, "history:8", "the turn did NOT see the full raw history — it was compacted first");
});

test("a session UNDER the soft threshold triggers no compaction at all (background pass is a no-op)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 1_000_000);
  await seed(
    sessions,
    Array.from({ length: 3 }, (_, i) => ({ payload: { text: `msg ${i}` } })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.reply, "history:3", "under soft ⇒ the turn runs on raw history, no inline compaction");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(compactCalls.length, 0, "nothing over soft ⇒ no compaction, foreground or background");
});

test("a DM follow-up after the background pass reuses the summary — no blocking summarizer call on its hot path", async () => {
  const { harness, compactCalls } = spyHarness();
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    compactCalls.push(input);
    return "tiny recap";
  };
  const keptAfterFirstTurn = ["msg 4", "msg 5", "msg 6", "msg 7", "!histcount", "history:8"];
  const { orch, sessions } = buildOrchestrator(harness, budgetWhoseKeepWindowFits(tokensOf(...keptAfterFirstTurn)));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  await orch.handleTurn(turn("!histcount"));
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the background pass ran after the first DM turn");
  assert.equal(compactCalls.length, 1);
  await waitForLeaseRelease(sessions, sid);

  delete harness.models.compactHistory;
  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "history:7", "the follow-up starts on [summary, recent…] with no summarizer call");
});

test("forModelContext strips thinking/text/soul (never laundered into a durable summary)", () => {
  const entries: SessionEntry[] = [
    mkEntry({ seq: 0, type: "user" }),
    mkEntry({ seq: 1, type: "thinking", payload: { thinking: "secret reasoning" } }),
    mkEntry({ seq: 2, type: "text", payload: { text: "scaffold" } }),
    mkEntry({ seq: 3, type: "soul", payload: { text: "soul" } }),
    mkEntry({ seq: 4, type: "assistant" }),
  ];
  assert.deepEqual(
    forModelContext(entries).map((e) => e.type),
    ["user", "assistant"],
  );
});

test("background compaction excludes thinking entries from the summary batch (Bugbot: history filter)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(sessions, [
    ...msgTexts(8).map((text) => ({ payload: { text } })),
    { type: "thinking" as const, payload: { thinking: "signature-less reasoning" } },
  ]);

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  const summaries = await waitForSummary(sessions, sid);
  assert.equal(summaries.length, 1, "a background compaction ran");
  assert.equal(compactCalls.length, 1);
  assert.ok(
    compactCalls[0]!.history.every((e) => e.type !== "thinking"),
    "the summarizer batch must not include the durable thinking entry",
  );
});

test("a session parked over soft with a too-large prior summary re-summarizes (Bugbot: reuse-parked)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(
    harness,
    budgetBetweenSoftAndHard(tokensOf("prior recap", ...msgTexts(8))),
  );
  await seed(sessions, [
    { type: "system" as const, payload: createContextSummaryPayload(-1, "prior recap"), scopeLabel: PERSONAL },
    ...msgTexts(8).map((text) => ({ payload: { text } })),
  ]);

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  for (let i = 0; i < 300 && compactCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(compactCalls.length, 1, "over soft with an unfitting prior summary ⇒ re-summarize, not park");
  assert.ok(
    compactCalls[0]!.history.some((e) => contextSummaryPayload(e)),
    "the prior summary is chained into the new batch",
  );
});

test("the compaction prompt tells the summarizer to preserve constraints and NOT launder untrusted content into fact", async () => {
  const { CONTEXT_COMPACTION_PROMPT } = (await import("../src/harness/pi-harness.ts")) as unknown as {
    CONTEXT_COMPACTION_PROMPT: string;
  };
  const p = CONTEXT_COMPACTION_PROMPT.toLowerCase();
  assert.match(p, /untrusted history, not/, "keeps the existing untrusted-history framing");
  assert.match(p, /constraint/, "preserves stated constraints");
  assert.match(p, /launder/, "explicitly forbids laundering untrusted content into fact");
  assert.match(p, /trust label|attributed/, "preserves trust labels / author attribution");
  assert.match(p, /do not continue the conversation/, "forbids continuing the conversation");
  assert.match(p, /do not respond to/, "forbids answering questions or instructions in the transcript");
  assert.match(p, /do not perform, resume, or plan any/, "forbids resuming the task");
  assert.match(p, /output only the summary/, "requires summary-only output");
  assert.match(p, /under 8,000 characters/, "gives the model a length target well under the hard cap");
  assert.match(p, /index/, "frames the summary as an index into the transcript");
  assert.match(p, /history tool/, "names the tool that dereferences pointers");
  assert.match(p, /seq or seq range/, "asks for seq pointers in place of retrievable detail");
  assert.match(p, /cannot be re-derived/, "keeps only non-re-derivable facts inline");
  assert.match(p, /fold its still-relevant content/, "gives merge semantics for a folded prior summary");
});

test("boundCompactSummary passes a normal summary through trimmed", () => {
  const history = [mkEntry({ seq: 1 }), mkEntry({ seq: 2 })];
  assert.equal(boundCompactSummary("  a tidy summary  ", history), "a tidy summary");
});

test("boundCompactSummary falls back deterministically when the model output is empty or missing", () => {
  const history = [mkEntry({ seq: 1 })];
  const fallback = deterministicCompactSummary(history);
  assert.equal(boundCompactSummary(undefined, history), fallback);
  assert.equal(boundCompactSummary("   ", history), fallback);
});

test("boundCompactSummary falls back deterministically when the summarizer runs away instead of summarizing", () => {
  const history = [mkEntry({ seq: 1 })];
  const runaway = "I'll scan for new signed replies… ".repeat(2_000);
  assert.ok(runaway.length > MAX_COMPACT_SUMMARY_CHARS);
  const out = boundCompactSummary(runaway, history);
  assert.equal(out, deterministicCompactSummary(history));
  assert.ok(out.length <= MAX_COMPACT_SUMMARY_CHARS, "the fallback itself fits the cap, so it never re-triggers");
});

test("the deterministic fallback keeps the newest entries — a late stated constraint survives the slice", () => {
  const history = [
    ...Array.from({ length: 40 }, (_, i) => mkEntry({ seq: i, payload: { text: `filler ${i} ${"x".repeat(400)}` } })),
    mkEntry({ seq: 40, payload: { text: "don't touch prod" } }),
  ];
  const out = deterministicCompactSummary(history);
  assert.match(out, /don't touch prod/);
  assert.ok(out.length <= MAX_COMPACT_SUMMARY_CHARS);
});

test("a runaway summarizer output is bounded at the orchestrator: the persisted summary is the deterministic fallback", async () => {
  const { harness } = spyHarness();
  harness.models.compactHistory = async () => "I'll scan for new signed replies… ".repeat(2_000);
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(12))));
  const sid = await seed(
    sessions,
    msgTexts(12).map((text) => ({ payload: { text } })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");

  const summaries = await waitForSummary(sessions, sid);
  assert.ok(summaries.length >= 1, "a summary is persisted");
  const persisted = contextSummaryPayload(summaries[0]!)!.text;
  assert.match(persisted, /^Compacted \d+ prior entr/, "the runaway output was replaced deterministically");
  assert.ok(persisted.length <= MAX_COMPACT_SUMMARY_CHARS);
});

function assertSummaryBoundary(history: SessionEntry[], label: string): void {
  const summaries = history.filter((e) => contextSummaryPayload(e));
  assert.ok(summaries.length <= 1, `${label}: at most one summary in the model context (got ${summaries.length})`);
  if (!summaries.length) return;
  const through = contextSummaryPayload(summaries[0]!)!.throughSeq;
  for (const e of history) {
    if (contextSummaryPayload(e)) continue;
    assert.ok(e.seq > through, `${label}: entry seq ${e.seq} is covered by the summary (throughSeq ${through})`);
  }
}

function captureHarness(harness: Harness) {
  const seen: SessionEntry[][] = [];
  const wrapped: Harness = {
    ...harness,
    turns: {
      ...harness.turns,
      runTurn: (input) => {
        seen.push(input.history);
        return harness.turns.runTurn(input);
      },
    },
  };
  return { wrapped, seen };
}

const stackedLog = (): Array<Partial<SessionEntry>> => [
  ...Array.from({ length: 4 }, (_, i) => ({ payload: { text: `old ${i}` } })),
  { type: "system" as const, payload: createContextSummaryPayload(3, "recap A"), scopeLabel: PERSONAL },
  ...Array.from({ length: 3 }, (_, i) => ({ payload: { text: `mid ${i}` } })),
  { type: "system" as const, payload: createContextSummaryPayload(7, "recap B"), scopeLabel: PERSONAL },
  ...Array.from({ length: 2 }, (_, i) => ({ payload: { text: `new ${i}` } })),
];

test("forModelContext applies the latest-summary boundary: one summary, nothing it covers, older summaries dropped", () => {
  const entries = stackedLog().map((e, seq) => ({
    sessionId: "s",
    seq,
    parentSeq: null,
    type: e.type ?? "user",
    payload: e.payload!,
    scopeLabel: PERSONAL,
    createdAt: seq,
  })) as SessionEntry[];
  const view = forModelContext(entries);
  assertSummaryBoundary(view, "forModelContext");
  assert.deepEqual(
    view.map((e) => e.seq),
    [8, 9, 10],
    "latest summary first, then only uncovered entries",
  );
});

test("hiding a tainted latest summary does not expose the raw entries it covers", () => {
  const entries = [
    mkEntry({ seq: 0, type: "user", payload: { text: "old clean" } }),
    mkEntry({ seq: 1, type: "user", payload: { text: "old tainted", securityTainted: true } }),
    mkEntry({
      seq: 2,
      type: "system",
      payload: { ...createContextSummaryPayload(1, "tainted recap"), securityTainted: true },
    }),
    mkEntry({ seq: 3, type: "assistant", payload: { text: "new clean" } }),
  ];

  assert.deepEqual(
    forModelContext(entries).map((e) => e.seq),
    [3],
  );
  assert.deepEqual(
    forModelContext(entries, { includeSecurityTainted: true }).map((e) => e.seq),
    [2, 3],
  );
});

test("under-HARD turn: the harness sees the boundary-filtered context, not stacked summaries over raw history", async () => {
  const base = spyHarness();
  const { wrapped, seen } = captureHarness(base.harness);
  const { orch, sessions } = buildOrchestrator(wrapped, 1_000_000);
  await seed(sessions, stackedLog());

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(seen.length, 1);
  assertSummaryBoundary(seen[0]!, "under-hard");
  assert.equal(res.reply, "history:3", "summary B + the 2 uncovered entries only");
});

test("over-HARD turn with a summarizer: the rebuilt context honors the boundary", async () => {
  const base = spyHarness();
  const { wrapped, seen } = captureHarness(base.harness);
  const { orch, sessions } = buildOrchestrator(
    wrapped,
    Math.floor(tokensOf("recap B", "new 0", "new 1") * COMPACT_HARD_FRACTION),
  );
  await seed(sessions, stackedLog());

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(seen.length, 1);
  assertSummaryBoundary(seen[0]!, "over-hard");
});

test("over-HARD turn with NO summarizer (boundRecent fallback): the boundary still holds and the summary survives the slice", async () => {
  const base = spyHarness({ withSummarizer: false });
  const { wrapped, seen } = captureHarness(base.harness);
  const { orch, sessions } = buildOrchestrator(wrapped, budgetKeepingOnlyNewest("recap B", "new 1"));
  await seed(sessions, stackedLog());

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(seen.length, 1);
  assertSummaryBoundary(seen[0]!, "boundRecent fallback");
  assert.ok(
    seen[0]!.some((e) => contextSummaryPayload(e)),
    "the bounding slice must keep the latest summary",
  );
});

test("the context window start never regresses as the log grows", () => {
  const entries: SessionEntry[] = [];
  const add = (type: SessionEntry["type"], payload: object) => {
    entries.push({
      sessionId: "s",
      seq: entries.length,
      parentSeq: null,
      type,
      payload,
      scopeLabel: PERSONAL,
      createdAt: entries.length,
    } as SessionEntry);
  };
  let prevStart = -1;
  const startOf = (view: SessionEntry[]): number => {
    const summary = view.find((e) => contextSummaryPayload(e));
    return summary ? contextSummaryPayload(summary)!.throughSeq + 1 : (view[0]?.seq ?? 0);
  };
  for (let i = 0; i < 30; i++) {
    add("user", { text: `msg ${i}` });
    if (i === 10) add("system", createContextSummaryPayload(8, "recap 1"));
    if (i === 20) add("system", createContextSummaryPayload(17, "recap 2"));
    const start = startOf(forModelContext(entries));
    assert.ok(start >= prevStart, `window start regressed at i=${i}: ${prevStart} -> ${start}`);
    prevStart = start;
  }
});

function gatedHarness() {
  const { harness, compactCalls, resetCalls } = spyHarness();
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  const summarize = harness.models.compactHistory!;
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    const text = await summarize(input);
    await gate;
    return text;
  };
  return { harness, compactCalls, resetCalls, open };
}

async function untilTrue(what: string, predicate: () => boolean, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("the background pass leaves the session writable while it summarizes — a follow-up turn is never locked out", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease } = await sessions.acquireLease(sid, "turn");
  assert.ok(lease, "background compaction must not hold the write-lock across its model call");
  await sessions.releaseLease(lease!);

  open();
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "and the summary still lands afterwards");
});

test("the background pass summarizes first and requests its lease only after the summarizer returns", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const events: string[] = [];
  const gated = harness.models.compactHistory!;
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    events.push("summarize:start");
    const text = await gated(input);
    events.push("summarize:end");
    return text;
  };
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const acquire = sessions.acquireLease.bind(sessions);
  sessions.acquireLease = async (sessionId, holder) => {
    if (holder === "compaction") events.push("acquire:compaction");
    return acquire(sessionId, holder);
  };
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => events.includes("summarize:start"));

  assert.ok(
    !events.includes("acquire:compaction"),
    `the pass must not request the session lease before the summarizer has returned (saw ${events.join(" → ")})`,
  );
  const { lease: probe } = await sessions.acquireLease(sid, "turn");
  assert.ok(probe, "the session lease stays free for the whole summarization call");
  await sessions.releaseLease(probe!);

  open();
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the summary lands once the lease is taken");
  assert.ok(
    events.indexOf("acquire:compaction") > events.indexOf("summarize:end"),
    `the compaction lease must be requested strictly after the summarizer returns (saw ${events.join(" → ")})`,
  );
  assert.equal(compactCalls.length, 1, "and the model was called exactly once");
});

test("the background pass waits out a turn that holds the lock rather than throwing its summary away", async () => {
  const { harness, compactCalls, resetCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease: held } = await sessions.acquireLease(sid, "turn");
  assert.ok(held);
  open();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await summaryEntries(sessions, sid)).length, 0, "the pass wrote nothing behind the turn's back");
  assert.equal(resetCalls.length, 0);

  await sessions.releaseLease(held!);
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the summary lands once the turn is done");
  assert.equal(compactCalls.length, 1, "and the model was called exactly once for it");
});

test("a turn landing mid-summarization does not disturb the fold: it covers a prefix, the turn's entries stay", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const paddedTexts = Array.from(
    { length: 15 },
    (_, i) => `msg ${i} with enough padding words that a mid-summarization turn stays under the hard threshold`,
  );
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...paddedTexts)));
  const sid = await seed(
    sessions,
    paddedTexts.map((text) => ({ payload: { text } })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:15");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);
  const beforeTurn = ((await sessions.getEntries(sid)).at(-1)?.seq ?? -1) + 1;

  assert.equal((await orch.handleTurn(turn("!histcount"))).status, "ok");
  const appended = (await sessions.getEntries(sid)).filter((e) => e.seq >= beforeTurn);
  assert.ok(appended.length > 0, "the turn really did write while the summarizer was parked");

  open();
  const summaries = await waitForSummary(sessions, sid);
  assert.ok(summaries.length >= 1);
  const throughSeq = contextSummaryPayload(summaries[0]!)!.throughSeq;
  assert.ok(
    throughSeq < appended[0]!.seq,
    `the fold covers only the prefix it summarized (through ${throughSeq}, turn started at ${appended[0]!.seq})`,
  );
  const survivors = await sessions.getEntries(sid);
  for (const entry of appended) {
    assert.ok(
      survivors.some((e) => e.seq === entry.seq),
      `the turn's entry ${entry.seq} survived the fold`,
    );
  }
});

test("a summary that landed while the pass was summarizing makes it drop its own — never two overlapping folds", async () => {
  const { harness, compactCalls, resetCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ payload: { text } })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease: rival } = await sessions.acquireLease(sid, "compaction");
  assert.ok(rival);
  await sessions.append(rival!, {
    type: "system",
    payload: createContextSummaryPayload(6, "a rival fold"),
    scopeLabel: PERSONAL,
  });
  await sessions.releaseLease(rival!);

  open();
  await new Promise((r) => setTimeout(r, 300));
  const summaries = await summaryEntries(sessions, sid);
  assert.equal(summaries.length, 1, "only the rival fold — the stale one was dropped");
  assert.equal(contextSummaryPayload(summaries[0]!)?.text, "a rival fold");
  assert.equal(resetCalls.length, 0, "the dropped pass never reached its write");
});

test("the token estimate counts the environment note persisted on a user entry", () => {
  const environment = `<environment>\n${"## What you remember\nlikes terse replies. ".repeat(40)}\n</environment>`;
  const bare = {
    sessionId: "s",
    seq: 1,
    parentSeq: null,
    type: "user",
    payload: { text: "hi" },
    scopeLabel: "org:o",
    createdAt: 1,
  } as SessionEntry;
  const withEnv = { ...bare, seq: 2, payload: { text: "hi", environment } } as SessionEntry;
  const delta = estimateHistoryTokens([withEnv]) - estimateHistoryTokens([bare]);
  assert.ok(delta >= countTokens(environment) * 0.9, `environment tokens must be counted (delta ${delta})`);
});

test("runtime handoff continues once with saved results under the original run and remaining deadline", async () => {
  const base = createMockHarness();
  const seen: import("../src/harness/harness.ts").HarnessTurnInput[] = [];
  let resets = 0;
  const choice = { harnessId: "pi" as const, modelId: "gpt-6-astra", effortLevel: "high", fastMode: false };
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      resetSession: async () => {
        resets++;
      },
      runTurn: async (input) => {
        seen.push(input);
        if (seen.length === 1) {
          await input.emit({ type: "user", payload: { text: input.input }, scopeLabel: input.scopeLabel });
          await input.emit({
            type: "tool_result",
            payload: {
              tool: "runtime",
              runId: input.runId,
              actorId: actor.id,
              runtimeHandoff: { choice, lifetime: "task" },
            },
            scopeLabel: input.scopeLabel,
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { reply: "must not be delivered", runtimeHandoff: { choice, lifetime: "task" }, modelCalls: 1 };
        }
        assert.deepEqual(input.runtime, choice);
        assert.equal(input.runId, "runtime-run");
        assert.ok(input.history.some((e) => e.type === "tool_result"));
        assert.ok(input.turnWallClockMs! < seen[0]!.turnWallClockMs!);
        await input.emit({ type: "assistant", payload: { text: "continued" }, scopeLabel: input.scopeLabel });
        return { reply: "continued", modelCalls: 1 };
      },
    },
  };
  const { orch, sessions } = buildOrchestrator(harness, undefined, 60000);
  await orch.handleTurn({ ...turn("switch then finish"), runId: "runtime-run", surfaceTools: false });
  assert.equal(seen.length, 2);
  assert.equal(resets, 1);
  const session = await sessions.getByThread(conv.threadRef);
  const entries = await sessions.getEntries(session!.id);
  assert.deepEqual(
    entries.filter((e) => e.type === "assistant").map((e) => (e.payload as { text: string }).text),
    ["continued"],
  );
});

test("runtime handoff cannot restart a stopped task", async () => {
  const base = createMockHarness();
  let calls = 0;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async () => {
        calls++;
        return {
          reply: "",
          stopped: true,
          runtimeHandoff: { choice: { harnessId: "pi", modelId: "gpt-6-astra" }, lifetime: "task" },
        };
      },
    },
  };
  const { orch } = buildOrchestrator(harness);
  await orch.handleTurn({ ...turn("switch"), surfaceTools: false });
  assert.equal(calls, 1);
});

test("a retry restores a committed runtime decision after reset crashes, without replaying the selection", async () => {
  const base = createMockHarness();
  const choice = { harnessId: "pi" as const, modelId: "gpt-6-astra" };
  let calls = 0;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      resetSession: async () => {
        throw new Error("worker died during reset");
      },
      runTurn: async (input) => {
        calls++;
        if (calls === 1) {
          await input.emit({ type: "user", payload: { text: input.input }, scopeLabel: input.scopeLabel });
          await input.emit({
            type: "tool_result",
            payload: {
              tool: "runtime",
              runId: input.runId,
              actorId: actor.id,
              runtimeHandoff: { choice, lifetime: "task" },
            },
            scopeLabel: input.scopeLabel,
          });
          return { reply: "", runtimeHandoff: { choice, lifetime: "task" } };
        }
        assert.deepEqual(input.runtime, choice);
        return { reply: "resumed" };
      },
    },
  };
  const { orch } = buildOrchestrator(harness);
  const input = { ...turn("switch and finish"), runId: "retry-runtime", surfaceTools: false };
  await assert.rejects(() => orch.handleTurn(input), /worker died/);
  await orch.handleTurn({ ...input, attempt: 2 });
  assert.equal(calls, 2);
});
