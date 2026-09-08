import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import {
  createTranscriptSource,
  projectTapeEntries,
  renderableTapeSlice,
  RENDER_IMPORT_EVENT,
} from "../src/harness/tape-projection.ts";
import { foldTape } from "../src/harness/tape-fold.ts";
import { TAPE_RENDER_VERSION, type Lease, type SessionStore, type TapeRecord } from "../src/sessions/session-store.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";
import {
  appendRenderImport,
  assertProjectionUnderstandsRenderImports,
  assessRenderImport,
  classifyDivergences,
  coarseTape,
  emptyBenignCounts,
  limitedSessionParity,
  RENDER_IMPORT_MAX_ENTRIES,
  sessionParity,
} from "../scripts/lib/tape-retirement.ts";

const scope = "personal:viewer@example.com" as ScopeId;

interface Sim {
  store: SessionStore;
  session: Session;
  lease: Lease;
}

async function simSession(): Promise<Sim> {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:retirement-test", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease: lease! };
}

interface SimCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
}

async function emitTurnEntries(
  sim: Sim,
  turn: { input: string; ts: string; calls?: SimCall[]; reply: string; tainted?: boolean },
): Promise<SessionEntry[]> {
  const emitted: SessionEntry[] = [];
  const emit = async (type: SessionEntry["type"], payload: unknown) => {
    emitted.push(await sim.store.append(sim.lease, { type, payload, scopeLabel: scope }));
  };
  await emit("user", { text: turn.input, ts: turn.ts, ...(turn.tainted ? { securityTainted: true } : {}) });
  for (const c of turn.calls ?? []) {
    await emit("tool_call", { ...c.args, tool: c.name, callId: c.id });
    await emit("tool_result", { tool: c.name, callId: c.id, isError: false, result: c.result });
  }
  await emit("assistant", { text: turn.reply });
  return emitted;
}

async function tapePreCutoverTurn(
  sim: Sim,
  turn: { input: string; ts: string; calls?: SimCall[]; reply: string },
  emitted: SessionEntry[],
): Promise<void> {
  const tape = (rec: Parameters<SessionStore["appendTape"]>[1]) => sim.store.appendTape(sim.lease, rec);
  await tape({
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: turn.input }], timestamp: Date.now() },
    scopeLabel: scope,
    entrySeq: emitted[0]!.seq,
    meta: { bareText: turn.input, ts: turn.ts, entryCreatedAt: emitted[0]!.createdAt },
  });
  for (const c of turn.calls ?? []) {
    await tape({
      kind: "message",
      harness: "pi",
      payload: {
        role: "assistant",
        content: [{ type: "toolCall", id: c.id, name: c.name, arguments: c.args }],
        stopReason: "stop",
        timestamp: Date.now(),
      },
      scopeLabel: scope,
    });
    await tape({
      kind: "message",
      harness: "pi",
      payload: {
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: c.result }],
        isError: false,
        timestamp: Date.now(),
      },
      scopeLabel: scope,
    });
  }
  await tape({
    kind: "message",
    harness: "pi",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: turn.reply }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
    scopeLabel: scope,
  });
  await tape({
    kind: "annotation",
    payload: { turnEnd: true },
    scopeLabel: scope,
    entrySeq: emitted[emitted.length - 1]!.seq,
  });
}

async function simLiveTurn(
  sim: Sim,
  turn: { input: string; ts: string; reply: string; harness?: string },
): Promise<void> {
  const harness = turn.harness ?? "pi";
  const userEntry = await sim.store.append(sim.lease, {
    type: "user",
    payload: { text: turn.input, ts: turn.ts },
    scopeLabel: scope,
  });
  await sim.store.appendTape(sim.lease, {
    kind: "message",
    harness,
    payload: { role: "user", content: [{ type: "text", text: turn.input }], timestamp: Date.now() },
    scopeLabel: scope,
    entrySeq: userEntry.seq,
    meta: { bareText: turn.input, ts: turn.ts, entryCreatedAt: userEntry.createdAt },
  });
  await sim.store.appendTape(sim.lease, {
    kind: "message",
    harness,
    payload: {
      role: "assistant",
      content: [{ type: "text", text: turn.reply }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
    scopeLabel: scope,
  });
  const replyEntry = await sim.store.append(sim.lease, {
    type: "assistant",
    payload: { text: turn.reply },
    scopeLabel: scope,
  });
  await sim.store.appendTape(sim.lease, {
    kind: "annotation",
    payload: {
      subturnEnd: true,
      render: TAPE_RENDER_VERSION,
      entry: { type: "assistant", payload: { text: turn.reply }, at: replyEntry.createdAt },
    },
    scopeLabel: scope,
    entrySeq: replyEntry.seq,
  });
  await sim.store.appendTape(sim.lease, {
    kind: "annotation",
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION, spanStart: userEntry.seq },
    scopeLabel: scope,
    entrySeq: replyEntry.seq,
  });
}

async function importSession(sim: Sim): Promise<void> {
  const plan = await assessRenderImport(sim.store, sim.session.id);
  assert.equal(plan.action, "import");
  assert.ok(plan.action === "import");
  const outcome = await appendRenderImport(sim.store, sim.lease, plan.entries, scope, plan.needsFoldImport);
  assert.equal(outcome, "imported");
}

const isAnchor = (r: TapeRecord): boolean =>
  r.kind === "context_event" && (r.payload as { event?: unknown }).event === RENDER_IMPORT_EVENT;
const isLegacyImport = (r: TapeRecord): boolean =>
  r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import";

const turnOne = {
  input: "check the deploy",
  ts: "1720000000.000100",
  calls: [{ id: "call_1", name: "execute", args: { command: "kubectl get pods" }, result: "3 pods running" }],
  reply: "All three pods are healthy.",
};

async function preCutoverSession(): Promise<Sim> {
  const sim = await simSession();
  const emitted = await emitTurnEntries(sim, turnOne);
  await tapePreCutoverTurn(sim, turnOne, emitted);
  return sim;
}

test("a reply whose text AND timing both differ stays a real mismatch", () => {
  const entry = entryAt(2, "assistant", { text: "done", workStartedAt: 5 });
  const projected = entryAt(2, "assistant", { text: "different" });
  const { real } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 1);
});

test("a projection that fabricates timing the entry lacks is a real mismatch", () => {
  const entry = entryAt(2, "assistant", { text: "done" });
  const projected = entryAt(2, "assistant", { text: "done", workStartedAt: 5, workFinishedAt: 9 });
  const { real } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 1);
});

test("a curated error flag the tape never carried is the tool-payload benign class", () => {
  const entry = entryAt(3, "tool_result", {
    tool: "read",
    found: false,
    callId: "c1",
    isError: true,
    result: "[no such file: x.md]",
  });
  const projected = entryAt(3, "tool_result", {
    tool: "read",
    callId: "c1",
    isError: false,
    result: "[no such file: x.md]",
  });
  const { real, benign } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 0);
  assert.equal(benign["tool-payload"], 1);
});

test("a projection inventing an error flag the entry lacks stays a real mismatch", () => {
  const entry = entryAt(3, "tool_result", { tool: "read", callId: "c1", isError: false, result: "ok" });
  const projected = entryAt(3, "tool_result", { tool: "read", callId: "c1", isError: true, result: "ok" });
  const { real } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 1);
});

test("an error-flag delta with differing result text stays a real mismatch", () => {
  const entry = entryAt(3, "tool_result", { tool: "read", callId: "c1", isError: true, result: "boom A" });
  const projected = entryAt(3, "tool_result", { tool: "read", callId: "c1", isError: false, result: "boom B" });
  const { real } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 1);
});

test("a reply differing only in work-timing fields is the timestamp benign class, not a real mismatch", () => {
  const entry = entryAt(2, "assistant", { text: "done", workStartedAt: 5, workFinishedAt: 9 });
  const projected = entryAt(2, "assistant", { text: "done" });
  const { real, benign } = classifyDivergences([entry], [projected], { coarse: false });
  assert.equal(real.length, 0);
  assert.equal(benign.timestamp, 1);
});

test("the projection self-check accepts this checkout", () => {
  assertProjectionUnderstandsRenderImports();
});

test("a pre-cutover tape is unservable before the render import and serves exactly after it", async () => {
  const sim = await preCutoverSession();
  const before = await sim.store.getTape(sim.session.id);
  assert.equal(projectTapeEntries(sim.session.id, before), null);

  await importSession(sim);

  const rows = await sim.store.getTape(sim.session.id);
  const entries = await sim.store.getEntries(sim.session.id);
  const projection = projectTapeEntries(sim.session.id, rows);
  assert.ok(projection);
  assert.deepEqual(projection!.entries, entries);
  assert.equal(projection!.coveredSeq, entries[entries.length - 1]!.seq);

  const slice = renderableTapeSlice(rows);
  assert.ok(slice.length < rows.length);
  assert.ok(slice.every((r) => r.kind !== "message"));
});

test("the anchor row lands last, after the mirrors and the bound", async () => {
  const sim = await preCutoverSession();
  await importSession(sim);
  const rows = await sim.store.getTape(sim.session.id);
  const anchorAt = rows.findIndex(isAnchor);
  assert.equal(anchorAt, rows.length - 1);
  const firstTapeSeq = (rows[anchorAt]!.payload as { firstTapeSeq?: unknown }).firstTapeSeq;
  assert.equal(typeof firstTapeSeq, "number");
  const bound = rows[anchorAt - 1]!;
  assert.equal((bound.payload as { turnEnd?: unknown }).turnEnd, true);
  assert.equal((bound.payload as { render?: unknown }).render, TAPE_RENDER_VERSION);
});

test("forRender serves a backfilled session from the tape without reading entries", async () => {
  const sim = await preCutoverSession();
  await importSession(sim);
  const entries = await sim.store.getEntries(sim.session.id);
  let entryReads = 0;
  const source = createTranscriptSource({
    getEntries: (id, opts) => {
      entryReads++;
      return sim.store.getEntries(id, opts);
    },
    visibleEntries: (id, principalId) => sim.store.visibleEntries(id, principalId),
    getTape: (id, opts) => sim.store.getTape(id, opts),
    latestEntrySeq: (id) => sim.store.latestEntrySeq(id),
    participantWindowsOf: (id) => sim.store.participantWindowsOf(id),
  });
  const served = await source.forRender(sim.session.id);
  assert.deepEqual(served.entries, entries);
  assert.equal(served.earlier, 0);
  assert.equal(entryReads, 0);
});

test("a crashed partial import is invisible and a re-run supersedes it", async () => {
  const sim = await preCutoverSession();
  const entries = await sim.store.getEntries(sim.session.id);
  for (const entry of entries.slice(0, 2)) {
    await sim.store.appendTape(sim.lease, {
      kind: "annotation",
      payload: { entry: { type: entry.type, payload: entry.payload, at: entry.createdAt } },
      scopeLabel: entry.scopeLabel,
      entrySeq: entry.seq,
    });
  }
  assert.equal(projectTapeEntries(sim.session.id, await sim.store.getTape(sim.session.id)), null);

  await importSession(sim);
  const rows = await sim.store.getTape(sim.session.id);
  const projection = projectTapeEntries(sim.session.id, rows);
  assert.ok(projection);
  assert.deepEqual(projection!.entries, entries);
});

test("the render import is idempotent and later live turns extend it densely", async () => {
  const sim = await preCutoverSession();
  await importSession(sim);
  const afterFirst = (await sim.store.getTape(sim.session.id)).length;

  assert.deepEqual(await assessRenderImport(sim.store, sim.session.id), { action: "skip", reason: "covered" });
  assert.equal((await sim.store.getTape(sim.session.id)).length, afterFirst);

  await simLiveTurn(sim, { input: "and staging?", ts: "1720000000.000200", reply: "Staging is green too." });
  assert.deepEqual(await assessRenderImport(sim.store, sim.session.id), { action: "skip", reason: "covered" });

  const rows = await sim.store.getTape(sim.session.id);
  const entries = await sim.store.getEntries(sim.session.id);
  const projection = projectTapeEntries(sim.session.id, rows);
  assert.ok(projection);
  assert.deepEqual(projection!.entries, entries);
});

test("an uncovered tape gets a fold import before the render stamp", async () => {
  const sim = await simSession();
  await emitTurnEntries(sim, turnOne);
  assert.equal(await sim.store.tapeCoverage(sim.session.id), -1);

  const plan = await assessRenderImport(sim.store, sim.session.id);
  assert.ok(plan.action === "import" && plan.needsFoldImport);
  await importSession(sim);

  const rows = await sim.store.getTape(sim.session.id);
  const entries = await sim.store.getEntries(sim.session.id);
  assert.equal(await sim.store.tapeCoverage(sim.session.id), entries[entries.length - 1]!.seq);

  const fold = foldTape(rows) as Array<{ role?: string }>;
  assert.ok(fold.length >= 2);
  assert.equal(fold[0]!.role, "user");

  const legacyAt = rows.findIndex(isLegacyImport);
  assert.ok(legacyAt >= 0);
  assert.ok(Array.isArray((rows[legacyAt]!.payload as { scopes?: unknown }).scopes));
  assert.ok(rows.findIndex(isAnchor) > legacyAt);

  const projection = projectTapeEntries(sim.session.id, rows);
  assert.ok(projection);
  assert.deepEqual(projection!.entries, entries);
});

test("search remains complete across a render import", async () => {
  const sim = await preCutoverSession();
  await importSession(sim);
  assert.equal(await sim.store.missingSearchEntries(sim.session.id), 0);
});

test("a tainted uncovered session is refused without a coverage claim", async () => {
  const sim = await simSession();
  await emitTurnEntries(sim, { ...turnOne, tainted: true });

  assert.deepEqual(await assessRenderImport(sim.store, sim.session.id), {
    action: "skip",
    reason: "unservable-fold",
  });

  const entries = await sim.store.getEntries(sim.session.id);
  const outcome = await appendRenderImport(sim.store, sim.lease, entries, scope, true);
  assert.equal(outcome, "unservable-fold");
  assert.equal((await sim.store.getTape(sim.session.id)).length, 0);
  assert.equal(await sim.store.tapeCoverage(sim.session.id), -1);
});

test("a tainted but coverage-latched session still gets render mirrors", async () => {
  const sim = await simSession();
  const emitted = await emitTurnEntries(sim, { ...turnOne, tainted: true });
  await sim.store.appendTape(sim.lease, {
    kind: "annotation",
    payload: { turnEnd: true },
    scopeLabel: scope,
    entrySeq: emitted[emitted.length - 1]!.seq,
  });

  const plan = await assessRenderImport(sim.store, sim.session.id);
  assert.ok(plan.action === "import" && !plan.needsFoldImport);
  await importSession(sim);

  const rows = await sim.store.getTape(sim.session.id);
  const entries = await sim.store.getEntries(sim.session.id);
  const projection = projectTapeEntries(sim.session.id, rows);
  assert.ok(projection);
  assert.deepEqual(projection!.entries, entries);
  assert.ok(!rows.some(isLegacyImport));
});

test("sessions over the shared import cap and gapped corpora are skipped", async () => {
  const sim = await simSession();
  for (let i = 0; i <= RENDER_IMPORT_MAX_ENTRIES; i++) {
    await sim.store.append(sim.lease, { type: "user", payload: { text: `m${i}` }, scopeLabel: scope });
  }
  assert.deepEqual(await assessRenderImport(sim.store, sim.session.id), { action: "skip", reason: "oversize" });

  const gapped = [entryAt(0, "user", { text: "a" }), { ...entryAt(1, "user", { text: "b" }), seq: 3 }];
  const fakeStore = {
    latestEntrySeq: () => Promise.resolve(3),
    tapeCoverage: () => Promise.resolve(3),
    getTape: () => Promise.resolve([]),
    getEntries: () => Promise.resolve(gapped),
  };
  assert.deepEqual(await assessRenderImport(fakeStore, "synthetic"), { action: "skip", reason: "gapped" });
});

test("force replans a covered session", async () => {
  const sim = await preCutoverSession();
  await importSession(sim);
  assert.deepEqual(await assessRenderImport(sim.store, sim.session.id), { action: "skip", reason: "covered" });
  const forced = await assessRenderImport(sim.store, sim.session.id, { force: true });
  assert.equal(forced.action, "import");
});

function entryAt(
  seq: number,
  type: SessionEntry["type"],
  payload: unknown,
  createdAt = 1_720_000_000_000,
): SessionEntry {
  return {
    sessionId: "synthetic",
    seq,
    parentSeq: seq === 0 ? null : seq - 1,
    type,
    payload,
    scopeLabel: scope,
    createdAt,
  };
}

test("classifier: identical transcripts report nothing", () => {
  const entries = [entryAt(0, "user", { text: "hi" }), entryAt(1, "assistant", { text: "hello" })];
  const report = classifyDivergences(entries, entries, { coarse: false });
  assert.deepEqual(report.real, []);
  assert.deepEqual(report.benign, emptyBenignCounts());
});

test("classifier: tool payload extras are benign; shared-field corruption is real", () => {
  const entries = [
    entryAt(0, "user", { text: "go" }),
    entryAt(1, "tool_call", { tool: "execute", callId: "c1", command: "ls", chars: 120, ok: true }),
    entryAt(2, "tool_result", { tool: "execute", callId: "c1", isError: false, result: "a.txt\nb.txt", files: 2 }),
    entryAt(3, "assistant", { text: "two files" }),
  ];
  const extras = [
    entries[0]!,
    { ...entries[1]!, payload: { command: "ls", tool: "execute", callId: "c1", text: "retained-arg" } },
    { ...entries[2]!, payload: { tool: "execute", callId: "c1", isError: false, result: "a.txt\nb.txt" } },
    entries[3]!,
  ];
  const benignReport = classifyDivergences(entries, extras, { coarse: false });
  assert.deepEqual(benignReport.real, []);
  assert.equal(benignReport.benign["tool-payload"], 2);

  const mangled = [
    entries[0]!,
    entries[1]!,
    { ...entries[2]!, payload: { tool: "execute", callId: "c1", isError: false, result: "MANGLED" } },
    entries[3]!,
  ];
  const realReport = classifyDivergences(entries, mangled, { coarse: false });
  assert.equal(realReport.real.length, 1);
  assert.equal(realReport.real[0]!.field, "tool-payload-content");
  assert.equal(realReport.benign["tool-payload"], 0);
});

test("classifier: createdAt drift on payload-equal rows is the timestamp class", () => {
  const entries = [entryAt(0, "user", { text: "hi" }), entryAt(1, "thinking", { thinking: "hm" })];
  const projected = [entries[0]!, { ...entries[1]!, createdAt: entries[1]!.createdAt + 4 }];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.deepEqual(report.real, []);
  assert.equal(report.benign.timestamp, 1);
});

test("classifier: dropped overheard mentions are benign", () => {
  const entries = [entryAt(0, "user", { overheard: true, ts: "1.1", text: "hey", mentions: { U1: "Alex" } })];
  const projected = [{ ...entries[0]!, payload: { overheard: true, ts: "1.1", text: "hey" } }];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.deepEqual(report.real, []);
  assert.equal(report.benign["overheard-mentions"], 1);
});

test("classifier: a taint cleared from entries but frozen in the mirror is its own benign class", () => {
  const entries = [entryAt(0, "user", { text: "hey", ts: "1.1" })];
  const projected = [{ ...entries[0]!, payload: { text: "hey", ts: "1.1", securityTainted: true } }];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.deepEqual(report.real, []);
  assert.equal(report.benign["taint-cleared"], 1);
});

test("classifier: an intra-turn type swap over the same rows is benign order drift", () => {
  const entries = [
    entryAt(0, "user", { text: "go" }),
    entryAt(1, "thinking", { thinking: "plan" }),
    entryAt(2, "tool_call", { tool: "execute", callId: "c1", command: "ls" }),
    entryAt(3, "assistant", { text: "done" }),
  ];
  const projected = [
    entries[0]!,
    { ...entries[1]!, type: "tool_call" as const, payload: { tool: "execute", callId: "c1", command: "ls" } },
    { ...entries[2]!, type: "thinking" as const, payload: { thinking: "plan" } },
    entries[3]!,
  ];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.deepEqual(report.real, []);
  assert.equal(report.benign["intra-turn-order"], 2);
});

test("classifier: a swap across turn segments is real", () => {
  const entries = [
    entryAt(0, "user", { text: "one" }),
    entryAt(1, "thinking", { thinking: "alpha" }),
    entryAt(2, "user", { text: "two" }),
    entryAt(3, "thinking", { thinking: "beta" }),
  ];
  const projected = [
    entries[0]!,
    { ...entries[1]!, payload: { thinking: "beta" } },
    entries[2]!,
    { ...entries[3]!, payload: { thinking: "alpha" } },
  ];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.equal(report.real.length, 2);
  assert.equal(report.benign["intra-turn-order"], 0);
});

test("classifier: a moved tool row with corrupted shared fields is real, not order drift", () => {
  const entries = [
    entryAt(0, "user", { text: "go" }),
    entryAt(1, "thinking", { thinking: "plan" }),
    entryAt(2, "tool_call", { tool: "execute", callId: "c1", command: "ls" }),
  ];
  const projected = [
    entries[0]!,
    { ...entries[1]!, type: "tool_call" as const, payload: { tool: "execute", callId: "c1", command: "rm -rf /" } },
    { ...entries[2]!, type: "thinking" as const, payload: { thinking: "plan" } },
  ];
  const report = classifyDivergences(entries, projected, { coarse: false });
  assert.equal(report.benign["intra-turn-order"], 1);
  assert.equal(report.real.length, 1);
});

test("classifier: changed text, missing rows, and extra rows are real", () => {
  const entries = [
    entryAt(0, "user", { text: "hi" }),
    entryAt(1, "assistant", { text: "hello" }),
    entryAt(2, "system", { kind: "goal" }),
  ];
  const projected = [
    entries[0]!,
    { ...entries[1]!, payload: { text: "goodbye" } },
    { ...entries[2]!, seq: 3, parentSeq: 2 },
  ];
  const report = classifyDivergences(entries, projected, { coarse: false });
  const fields = report.real.map((d) => d.field).sort();
  assert.deepEqual(fields, ["extra-row", "missing-row", "row"]);
});

test("classifier: missing tool detail is benign only for coarse foreign tapes", () => {
  const entries = [
    entryAt(0, "user", { text: "go" }),
    entryAt(1, "tool_call", { tool: "execute", callId: "c1" }),
    entryAt(2, "assistant", { text: "done" }),
  ];
  const projected = [entries[0]!, entries[2]!];
  const strict = classifyDivergences(entries, projected, { coarse: false });
  assert.equal(strict.real.length, 1);
  const coarse = classifyDivergences(entries, projected, { coarse: true });
  assert.deepEqual(coarse.real, []);
  assert.equal(coarse.benign["coarse-gap"], 1);
});

test("coarseTape considers only rows inside the render-import slice", async () => {
  const sim = await preCutoverSession();
  await sim.store.appendTape(sim.lease, {
    kind: "message",
    harness: "codex",
    payload: { role: "assistant", content: [{ type: "text", text: "foreign" }], stopReason: "stop", timestamp: 1 },
    scopeLabel: scope,
  });
  await importSession(sim);
  assert.equal(coarseTape(await sim.store.getTape(sim.session.id)), false);

  await simLiveTurn(sim, { input: "again", ts: "1720000000.000300", reply: "sure", harness: "codex" });
  assert.equal(coarseTape(await sim.store.getTape(sim.session.id)), true);
});

test("sessionParity: blocked before the import, exact after, uncovered when entries outrun the tape", async () => {
  const sim = await preCutoverSession();
  const entries = await sim.store.getEntries(sim.session.id);

  const before = sessionParity(sim.session.id, entries, await sim.store.getTape(sim.session.id));
  assert.deepEqual(before, { status: "unservable", reason: "blocked" });

  await importSession(sim);
  const after = sessionParity(
    sim.session.id,
    await sim.store.getEntries(sim.session.id),
    await sim.store.getTape(sim.session.id),
  );
  assert.equal(after.status, "compared");
  assert.ok(after.status === "compared");
  assert.deepEqual(after.report.real, []);
  assert.deepEqual(after.report.benign, emptyBenignCounts());

  await sim.store.append(sim.lease, { type: "assistant", payload: { text: "late" }, scopeLabel: scope });
  const outrun = sessionParity(
    sim.session.id,
    await sim.store.getEntries(sim.session.id),
    await sim.store.getTape(sim.session.id),
  );
  assert.deepEqual(outrun, { status: "unservable", reason: "uncovered" });
});

test("limitedSessionParity exercises the bounded read path and detects fallback", async () => {
  const preImport = await preCutoverSession();
  const fallback = await limitedSessionParity(
    preImport.store,
    preImport.session.id,
    await preImport.store.getEntries(preImport.session.id),
    await preImport.store.getTape(preImport.session.id),
    50,
  );
  assert.deepEqual(fallback, { status: "fallback" });

  const sim = await preCutoverSession();
  await importSession(sim);
  await simLiveTurn(sim, { input: "and staging?", ts: "1720000000.000200", reply: "Staging is green too." });
  const limited = await limitedSessionParity(
    sim.store,
    sim.session.id,
    await sim.store.getEntries(sim.session.id),
    await sim.store.getTape(sim.session.id),
    3,
  );
  assert.equal(limited.status, "projected");
  assert.ok(limited.status === "projected");
  assert.deepEqual(limited.report.real, []);

  const staleEntries = await sim.store.getEntries(sim.session.id);
  const staleRows = await sim.store.getTape(sim.session.id);
  await simLiveTurn(sim, { input: "one more thing", ts: "1720000000.000300", reply: "Done." });
  const raced = await limitedSessionParity(sim.store, sim.session.id, staleEntries, staleRows, 3);
  assert.equal(raced.status, "projected");
  assert.ok(raced.status === "projected");
  assert.deepEqual(raced.report.real, [], "a turn landing between the snapshot and the serving read is not a mismatch");
});
