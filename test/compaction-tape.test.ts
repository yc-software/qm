import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import {
  CONTEXT_SUMMARY_HEADER,
  compactionThroughSeq,
  forModelContext,
  planCompaction,
} from "../src/harness/context-compaction.ts";
import { foldTape, lintFold, rehydrateFoldImages } from "../src/harness/tape-fold.ts";
import { appendCoverageImport } from "../src/harness/replay.ts";
import { stripImageBytes } from "../src/harness/pi-harness.ts";
import {
  contextSummaryPayload,
  createContextSummaryPayload,
  tapeCheckpointPayload,
  type TapeRecord,
} from "../src/sessions/session-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:fx@example.com" as ScopeId;
type Msg = { role: string; toolCallId?: string; content: Array<{ type: string; text?: string }> };

async function setup(maxContextTokens: number, stampResults = true) {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("fx", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  let n = 0;
  const deps = {
    sessions,
    maxContextTokens,
    harness: { models: { compactHistory: async () => `SUMMARY-${++n}` }, turns: { resetSession: async () => {} } },
    modelGateway: { recordCall() {} },
  };
  const compaction = createCompaction(deps as unknown as OrchestratorDeps);
  const tape = (rec: Parameters<typeof sessions.appendTape>[1]) => sessions.appendTape(lease, rec);
  async function turn(label: string, tools: number) {
    const u = await sessions.append(lease!, { type: "user", payload: { text: `${label} request` }, scopeLabel: scope });
    await tape({
      kind: "message",
      payload: { role: "user", content: [{ type: "text", text: `${label} request` }], timestamp: u.createdAt },
      scopeLabel: scope,
      entrySeq: u.seq,
      meta: { bareText: `${label} request`, entryCreatedAt: u.createdAt },
    });
    for (let i = 0; i < tools; i++) {
      const callId = `${label}-c${i}`;
      const text = `${callId} `.repeat(150);
      await sessions.append(lease!, {
        type: "tool_call",
        payload: { tool: "execute", callId, command: "x" },
        scopeLabel: scope,
      });
      await tape({
        kind: "message",
        payload: {
          role: "assistant",
          content: [{ type: "toolCall", id: callId, name: "execute", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 1,
        },
        scopeLabel: scope,
      });
      const r = await sessions.append(lease!, {
        type: "tool_result",
        payload: { callId, result: text },
        scopeLabel: scope,
      });
      await tape({
        kind: "message",
        payload: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "execute",
          content: [{ type: "text", text }],
          isError: false,
          timestamp: 1,
        },
        scopeLabel: scope,
        ...(stampResults ? { entrySeq: r.seq } : {}),
      });
    }
    const a = await sessions.append(lease!, {
      type: "assistant",
      payload: { text: `${label} done` },
      scopeLabel: scope,
    });
    await tape({
      kind: "message",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: `${label} done` }],
        stopReason: "stop",
        timestamp: 1,
      },
      scopeLabel: scope,
    });
    await tape({
      kind: "annotation",
      payload: tapeCheckpointPayload("subturnEnd"),
      scopeLabel: scope,
      entrySeq: a.seq,
    });
    await tape({ kind: "annotation", payload: tapeCheckpointPayload("turnEnd"), scopeLabel: scope, entrySeq: a.seq });
  }
  async function compact() {
    const history = forModelContext((await sessions.getContextWindow(session.id)).entries);
    await compaction.compactContextIfNeeded({
      session,
      lease: lease!,
      visibleHistory: history,
      scopeId: scope,
      orgScopeId: "org:test",
      actorId: "fx",
    });
    const latest = (await sessions.getContextWindow(session.id)).entries.findLast((e) => contextSummaryPayload(e));
    return contextSummaryPayload(latest!)!.throughSeq;
  }
  const fold = async () => foldTape(await sessions.getTape(session.id)) as Msg[];
  async function resultSeqs() {
    const map = new Map<string, number>();
    for (const e of (await sessions.getContextWindow(session.id)).entries)
      if (e.type === "tool_result") map.set((e.payload as { callId: string }).callId, e.seq);
    return map;
  }
  return { deps, turn, compact, fold, resultSeqs };
}

const summaries = (f: Msg[]) =>
  f.flatMap((m) =>
    m.content
      .filter((b) => b.type === "text" && b.text?.startsWith(CONTEXT_SUMMARY_HEADER))
      .map((b) => b.text!.split("\n")[1]),
  );

async function longTurnCut(stampResults: boolean) {
  const fx = await setup(3000, stampResults);
  await fx.turn("T0", 0);
  await fx.turn("T1", 12);
  const through = await fx.compact();
  const seqOf = await fx.resultSeqs();
  const folded = await fx.fold();
  const results = folded.filter((m) => m.role === "toolResult").map((m) => seqOf.get(m.toolCallId!)!);
  const uncovered = [...seqOf.values()].filter((s) => s > through);
  return { through, folded, results, uncovered };
}

test("a cutoff inside a long turn drops the tool results the summary covers", async () => {
  const { through, folded, results, uncovered } = await longTurnCut(true);
  assert.ok(uncovered.length > 0, "the cutoff falls inside the turn");
  assert.deepEqual(
    results.filter((s) => s <= through),
    [],
  );
  assert.deepEqual(results, uncovered, "every unsummarized result is still there");
  assert.ok(lintFold(folded).ok);
});

test("an unstamped tape still loses nothing when it cannot cut exactly", async () => {
  const { folded, results, uncovered } = await longTurnCut(false);
  for (const s of uncovered) assert.ok(results.includes(s));
  assert.ok(lintFold(folded).ok);
});

test("a cut never splits a parallel tool batch", () => {
  let seq = 0;
  const row = (r: Partial<TapeRecord>): TapeRecord =>
    ({ sessionId: "s", seq: seq++, createdAt: seq, scopeLabel: scope, ...r }) as TapeRecord;
  const result = (id: string, entrySeq: number) =>
    row({
      kind: "message",
      entrySeq,
      payload: {
        role: "toolResult",
        toolCallId: id,
        toolName: "x",
        content: [{ type: "text", text: id }],
        isError: false,
      },
    });
  const rows = [
    row({ kind: "message", entrySeq: 0, payload: { role: "user", content: [{ type: "text", text: "go" }] } }),
    row({
      kind: "message",
      payload: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "a", name: "x", arguments: {} },
          { type: "toolCall", id: "b", name: "x", arguments: {} },
        ],
      },
    }),
    result("a", 3),
    result("b", 4),
    row({ kind: "context_event", coversEntrySeq: 3, payload: { event: "compaction", text: "S" } }),
  ];
  const folded = foldTape(rows) as Msg[];
  assert.deepEqual(
    folded.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
    ["a", "b"],
  );
  assert.ok(lintFold(folded).ok, "both results stay beside their call");
});

for (const stamped of [true, false]) {
  test(`a second compaction in the same long turn replaces the first summary (${stamped ? "stamped" : "unstamped results"})`, async () => {
    const fx = await setup(3000, stamped);
    await fx.turn("T1", 20);
    const first = await fx.compact();
    await fx.turn("T2", 0);
    fx.deps.maxContextTokens = 1500;
    const second = await fx.compact();
    assert.ok(second > first);
    assert.deepEqual(summaries(await fx.fold()), ["SUMMARY-2"]);
  });
}

test("planner contract: a new summary always folds in the prior one", () => {
  const entry = (seq: number, type: string, payload: unknown) =>
    ({ sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: scope, createdAt: seq }) as never;
  const prior = entry(10, "system", createContextSummaryPayload(9, "old"));
  const history = [prior, ...Array.from({ length: 12 }, (_, i) => entry(11 + i, "user", { text: "x ".repeat(400) }))];
  const plan = planCompaction(history, 2000, 0.3, 0);
  assert.ok(plan);
  assert.equal(plan.toSummarize[0], prior);
  assert.ok(compactionThroughSeq(plan.toSummarize) >= 9);
});

test("with no turn boundary to cut at, a covering compaction replaces the prior summary", () => {
  let seq = 0;
  const row = (r: Partial<TapeRecord>): TapeRecord =>
    ({ sessionId: "s", seq: seq++, createdAt: seq, scopeLabel: scope, ...r }) as TapeRecord;
  const rows = [
    row({ kind: "context_event", coversEntrySeq: 20, payload: { event: "compaction", text: "first" } }),
    row({ kind: "message", payload: { role: "user", content: [{ type: "text", text: "q" }] } }),
    row({ kind: "context_event", coversEntrySeq: 25, payload: { event: "compaction", text: "second" } }),
  ];
  const folded = foldTape(rows) as Msg[];
  assert.deepEqual(summaries(folded), ["second"]);
  assert.equal(folded.length, 2, "the unsummarized message stays");
});

test("a compaction that does not cover the prior summary keeps it", () => {
  let seq = 0;
  const row = (r: Partial<TapeRecord>): TapeRecord =>
    ({ sessionId: "s", seq: seq++, createdAt: seq, scopeLabel: scope, ...r }) as TapeRecord;
  const rows = [
    row({ kind: "context_event", coversEntrySeq: 20, payload: { event: "compaction", text: "first" } }),
    row({ kind: "message", payload: { role: "user", content: [{ type: "text", text: "q" }] } }),
    row({ kind: "context_event", coversEntrySeq: 15, payload: { event: "compaction", text: "second" } }),
  ];
  assert.deepEqual(summaries(foldTape(rows) as Msg[]), ["second", "first"]);
});

async function imageSession(attachments: unknown[]) {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("img", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  const u = await sessions.append(lease!, {
    type: "user",
    payload: { text: "what is in this image?", attachments },
    scopeLabel: scope,
  });
  await sessions.append(lease!, { type: "assistant", payload: { text: "a cat" }, scopeLabel: scope });
  assert.ok(await appendCoverageImport(sessions, lease!, (await sessions.getContextWindow(session.id)).entries, scope));
  return { tape: await sessions.getTape(session.id), u };
}
const shot = { name: "shot.png", mimetype: "image/png", sizeBytes: 4, direction: "in", artifactId: "art-1" };
const load = async (ref: string) => (ref === "art-1" ? { data: "AAAA", mimeType: "image/png", sizeBytes: 4 } : null);
const imageCount = (ms: unknown[]) =>
  ms.flatMap((m) => ((m as { content?: Array<{ type?: string }> }).content ?? []).filter((b) => b.type === "image"))
    .length;

test("a fallback coverage import keeps an attached image as an artifact ref", async () => {
  const { tape, u } = await imageSession([shot, { ...shot, mimetype: "application/pdf", artifactId: "doc" }]);
  const imported = JSON.stringify(tape);
  assert.ok(!imported.includes("AAAA"), "no bytes are copied into the tape");
  const normal = stripImageBytes(
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: u.createdAt,
    },
    [{ artifactId: "art-1" }],
  );
  const normalFold = foldTape([
    { kind: "message", payload: normal, scopeLabel: scope, sessionId: "s", seq: 0, createdAt: 0 },
  ]);
  assert.equal(imageCount(await rehydrateFoldImages(normalFold, load, 1e6)), 1);
  const fallback = await rehydrateFoldImages(foldTape(tape), load, 1e6);
  assert.equal(imageCount(fallback), 1);
  assert.ok(lintFold(fallback).ok);
});

test("an unreadable imported image fails closed like the normal path", async () => {
  const { tape } = await imageSession([{ ...shot, artifactId: "gone" }]);
  assert.equal(lintFold(await rehydrateFoldImages(foldTape(tape), load, 1e6)).ok, false);
});

test("outbound and non-image attachments are not replayed as images", async () => {
  const { tape } = await imageSession([
    { ...shot, direction: "out" },
    { ...shot, mimetype: "text/plain" },
  ]);
  assert.equal(imageCount(foldTape(tape)), 0);
});

function tapeRows() {
  let seq = 0;
  return (r: Partial<TapeRecord>): TapeRecord =>
    ({ sessionId: "s", seq: seq++, createdAt: seq, scopeLabel: scope, ...r }) as TapeRecord;
}
const call = (text?: string) => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: "c1", name: "execute", arguments: {} }],
});
const resultOf = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "execute",
  content: [{ type: "text", text }],
  isError: false,
  ...extra,
});

test("a result resumed after an interruption is cut only by its own entry", () => {
  const row = tapeRows();
  const rows = [
    row({ kind: "message", entrySeq: 0, payload: { role: "user", content: [{ type: "text", text: "go" }] } }),
    row({ kind: "message", payload: call() }),
    row({ kind: "message", entrySeq: 2, payload: resultOf("[interrupted]", { isError: true, interrupted: true }) }),
    row({ kind: "message", entrySeq: 7, payload: resultOf("REAL OUTPUT") }),
    row({ kind: "context_event", coversEntrySeq: 2, payload: { event: "compaction", text: "S" } }),
  ];
  const folded = foldTape(rows) as Msg[];
  const result = folded.find((m) => m.role === "toolResult");
  assert.equal(result?.content[0]?.text, "REAL OUTPUT", "the summary through entry 2 never saw the real result");
  assert.ok(lintFold(folded).ok);
});

test("a turn end before a resumed result does not let its summary cut the result", () => {
  const row = tapeRows();
  const rows = [
    row({ kind: "message", entrySeq: 0, payload: { role: "user", content: [{ type: "text", text: "go" }] } }),
    row({ kind: "message", payload: call() }),
    row({ kind: "message", entrySeq: 2, payload: resultOf("[interrupted]", { isError: true, interrupted: true }) }),
    row({ kind: "annotation", entrySeq: 3, payload: { turnEnd: true } }),
    row({ kind: "message", entrySeq: 7, payload: resultOf("REAL OUTPUT") }),
    row({ kind: "context_event", coversEntrySeq: 3, payload: { event: "compaction", text: "S" } }),
  ];
  const folded = foldTape(rows) as Msg[];
  const result = folded.find((m) => m.role === "toolResult");
  assert.equal(result?.content[0]?.text, "REAL OUTPUT", "the summary through entry 3 never saw the real result");
  assert.ok(lintFold(folded).ok);
});

for (const narrationSeq of [undefined, 3]) {
  test(`narration persisted after its tool result survives a cut at the result (${narrationSeq === undefined ? "unstamped" : "stamped 3"})`, () => {
    const row = tapeRows();
    const rows = [
      row({ kind: "message", entrySeq: 0, payload: { role: "user", content: [{ type: "text", text: "go" }] } }),
      row({
        kind: "message",
        payload: call("NARRATION"),
        ...(narrationSeq !== undefined ? { entrySeq: narrationSeq } : {}),
      }),
      row({ kind: "message", entrySeq: 2, payload: resultOf("out") }),
      row({ kind: "context_event", coversEntrySeq: 2, payload: { event: "compaction", text: "S" } }),
    ];
    const folded = foldTape(rows) as Msg[];
    assert.ok(
      folded.some((m) => m.content.some((b) => b.text === "NARRATION")),
      "narration the summary did not cover stays",
    );
    assert.ok(lintFold(folded).ok);
  });
}
