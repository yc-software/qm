import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import {
  windowedTranscript,
  TAPE_RENDER_VERSION,
  type Lease,
  type SessionStore,
} from "../src/sessions/session-store.ts";
import { scopeId, type ScopeId, type SessionEntry, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-view-bounds-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("a tailTurns view is bounded yet reports the same earlierEntries as the full read", async () => {
  const { app, runtime } = freshApp();
  runtime.start();
  try {
    for (let i = 0; i < 45; i++) await app.turn(dm(`question number ${i}`, "web:U1:bounds"));
    const sid = (await app.turn(dm("final question", "web:U1:bounds"))).sessionId!;
    const full = (await app.getSessionForViewer(sid, "U1"))!;
    const expected = windowedTranscript(
      (await app.getSessionForViewer(sid, "U1", { tailTurns: 9999 }))!.entries as SessionEntry[],
      { tailTurns: 2 },
    );
    const bounded = (await app.getSessionForViewer(sid, "U1", { tailTurns: 2 }))!;
    assert.deepEqual(
      bounded.entries.map((e) => [e.seq, e.type]),
      expected.entries.map((e) => [e.seq, e.type]),
    );
    const fullCount = full.entries.length + (full.earlierEntries ?? 0);
    assert.equal(
      bounded.entries.length + (bounded.earlierEntries ?? 0),
      fullCount,
      "bounded earlierEntries accounts for exactly the renderable entries above the window",
    );
  } finally {
    await runtime.stop();
  }
});

function withoutCanonicalTranscript(sessions: SessionStore) {
  const getTape = sessions.getTape.bind(sessions);
  sessions.getTranscriptEntries = async () => [];
  sessions.getTape = async (sessionId, opts) => {
    const rows = (await getTape(sessionId)).filter(
      (row) => (row.payload as { event?: string }).event !== "transcript_entry" && row.seq > (opts?.sinceSeq ?? -1),
    );
    return opts?.limit === undefined ? rows : rows.slice(-opts.limit);
  };
}

async function coarseForeignSession(sessions: SessionStore, turns = 1) {
  const scope = scopeId("personal", "U1");
  const session = await sessions.getOrCreateByThread("web:U1:coarse-pins", "dm", scope, undefined, "web");
  await sessions.addParticipant(session.id, "U1", undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(session.id);
  const held = lease as Lease;
  const emit = (type: SessionEntry["type"], payload: unknown) =>
    sessions.append(held, { type, payload, scopeLabel: scope as ScopeId });
  let narration: SessionEntry | undefined;
  let reply: SessionEntry | undefined;
  for (let turn = 0; turn < turns; turn++) {
    const ask = `codex, tidy queue ${turn}`;
    const user = await emit("user", { text: ask });
    await sessions.appendTape(held, {
      kind: "message",
      harness: "codex",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: ask }] },
      scopeLabel: scope,
      entrySeq: user.seq,
      meta: { bareText: ask, entryCreatedAt: user.createdAt },
    });
    const turnNarration = await emit("text", { text: turn === 0 ? "queue narration detail" : `narration ${turn}` });
    narration ??= turnNarration;
    await emit("tool_call", { tool: "execute", callId: `c${turn}`, command: "tidy" });
    await emit("tool_result", { tool: "execute", callId: `c${turn}`, isError: false, result: "tidied" });
    reply = await emit("assistant", { text: `Queue ${turn} tidied.` });
    await sessions.appendTape(held, {
      kind: "annotation",
      payload: {
        subturnEnd: true,
        render: TAPE_RENDER_VERSION,
        entry: { type: "assistant", payload: { text: `Queue ${turn} tidied.` }, at: reply.createdAt },
      },
      scopeLabel: scope,
      entrySeq: reply.seq,
    });
    await sessions.appendTape(held, {
      kind: "annotation",
      payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
      scopeLabel: scope,
      entrySeq: reply.seq,
    });
  }
  await sessions.releaseLease(held);
  return { session, narration: narration!, reply: reply! };
}

test("bounded earlierEntries on a coarse foreign session counts renderable entries, not raw seqs", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    withoutCanonicalTranscript(built.sessions);
    const { session } = await coarseForeignSession(built.sessions, 30);
    const full = (await built.app.getSession(session.id))!;
    assert.equal(full.earlierEntries ?? 0, 0, "the unbounded read reports nothing earlier");
    assert.equal(full.entries.length, 60, "coarse render keeps only user + assistant per turn");
    const bounded = (await built.app.getSession(session.id, { tailTurns: 1 }))!;
    assert.deepEqual(
      bounded.entries.map((e) => [e.seq, e.type]),
      full.entries.slice(-bounded.entries.length).map((e) => [e.seq, e.type]),
    );
    assert.equal(
      bounded.entries.length + (bounded.earlierEntries ?? 0),
      full.entries.length,
      "earlierEntries counts exactly the renderable entries above the window, not projection-dropped seqs",
    );
    const fullViewer = (await built.app.getSessionForViewer(session.id, "U1"))!;
    const boundedViewer = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 1 }))!;
    assert.equal(
      boundedViewer.entries.length + (boundedViewer.earlierEntries ?? 0),
      fullViewer.entries.length + (fullViewer.earlierEntries ?? 0),
      "the viewer path reports the same renderable count",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("pins on entries a coarse projection drops still resolve through the targeted entries fallback", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    withoutCanonicalTranscript(built.sessions);
    const { session, narration } = await coarseForeignSession(built.sessions);
    const view = (await built.app.getSessionForViewer(session.id, "U1"))!;
    assert.deepEqual(
      view.entries.map((e) => e.type),
      ["user", "assistant"],
      "the transcript itself renders coarsely",
    );
    const pinned = await built.app.pinConversationItem("web:U1:coarse-pins", "U1", { entrySeq: narration.seq });
    assert.ok("pin" in pinned && pinned.pin, "pinning a projection-dropped entry is not bad_entry");
    assert.equal(pinned.pin!.preview, "queue narration detail");
    const listed = (await built.app.listConversationPins("web:U1:coarse-pins", "U1"))!;
    assert.equal(listed[0]!.preview, "queue narration detail");
    const fetched = await built.app.getSessionEntryForViewer(session.id, "U1", narration.seq);
    assert.equal((fetched?.entry.payload as { text?: string })?.text, "queue narration detail");
    const stranger = await built.app.getSessionEntryForViewer(session.id, "stranger", narration.seq);
    assert.equal(stranger, null, "the targeted fallback stays tenure-gated");
  } finally {
    await built.runtime.stop();
  }
});

test("canonical transcripts retain foreign harness tool detail and exact bounded counts", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const { session, narration } = await coarseForeignSession(built.sessions, 30);
    const full = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 9999 }))!;
    assert.deepEqual(full.entries, await built.sessions.getEntries(session.id));
    assert.equal(full.entries.length, 150);
    const bounded = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 1 }))!;
    assert.deepEqual(bounded.entries, full.entries.slice(-5));
    assert.equal(bounded.earlierEntries, 145);
    const pinned = await built.app.pinConversationItem("web:U1:coarse-pins", "U1", { entrySeq: narration.seq });
    assert.ok("pin" in pinned && pinned.pin);
    assert.equal(pinned.pin.preview, "queue narration detail");
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages bound canonical reads, widen for dense turns, and match full-read windows", async () => {
  const built = freshApp();
  try {
    const { session } = await coarseForeignSession(built.sessions, 100);
    const canonical = built.sessions.getTranscriptEntries.bind(built.sessions);
    const calls: Array<{ limit?: number; beforeSeq?: number } | undefined> = [];
    built.sessions.getTranscriptEntries = async (id, opts) => {
      calls.push(opts);
      return canonical(id, opts);
    };
    for (const beforeSeq of [1, 50, 251, 499, 900]) {
      const full = (await built.app.getSessionForViewer(session.id, "U1"))!;
      calls.length = 0;
      const window = { beforeSeq, tailTurns: 2 };
      const expected = windowedTranscript(full.entries as SessionEntry[], window);
      for (const page of [
        await built.app.getSessionForViewer(session.id, "U1", window),
        await built.app.getSession(session.id, window),
      ]) {
        assert.deepEqual(page!.entries, expected.entries);
        assert.equal(page!.earlierEntries ?? 0, expected.earlier);
      }
      assert.ok(calls.every((opts) => opts?.beforeSeq === beforeSeq && opts.limit === 80));
    }
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 180; i++)
      await built.sessions.append(lease!, {
        type: "text",
        payload: { text: `detail ${i}` },
        scopeLabel: session.scopeId,
      });
    await built.sessions.releaseLease(lease!);
    calls.length = 0;
    const page = await built.app.getSessionForViewer(session.id, "U1", { beforeSeq: 680, tailTurns: 1 });
    assert.equal(page!.entries[0]!.seq, 495);
    assert.deepEqual(
      calls.map((opts) => opts?.limit),
      [40, 80, 160, 320],
    );
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages retain tape fallback and viewer tenure boundaries", async () => {
  const built = freshApp();
  try {
    const { session } = await coarseForeignSession(built.sessions, 30);
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, {
        type: "user",
        payload: { text: `late question ${i}` },
        scopeLabel: session.scopeId,
      });
      await built.sessions.append(lease!, {
        type: "assistant",
        payload: { text: `late reply ${i}` },
        scopeLabel: session.scopeId,
      });
    }
    await built.sessions.releaseLease(lease!);
    for (const viewer of ["late", "U1", "stranger"]) {
      const full = await built.app.getSessionForViewer(session.id, viewer);
      for (const beforeSeq of [100, 155, 170]) {
        const page = await built.app.getSessionForViewer(session.id, viewer, { beforeSeq, tailTurns: 2 });
        if (!full) {
          assert.equal(page, null);
          continue;
        }
        const expected = windowedTranscript(full.entries as SessionEntry[], { beforeSeq, tailTurns: 2 });
        assert.deepEqual(page!.entries, expected.entries);
        assert.equal(page!.earlierEntries ?? 0, expected.earlier);
      }
    }
    withoutCanonicalTranscript(built.sessions);
    const full = (await built.app.getSession(session.id))!;
    const expected = windowedTranscript(full.entries as SessionEntry[], { beforeSeq: 101, tailTurns: 2 });
    const page = (await built.app.getSessionForViewer(session.id, "U1", { beforeSeq: 101, tailTurns: 2 }))!;
    assert.deepEqual(page.entries, expected.entries);
    assert.equal(page.earlierEntries ?? 0, expected.earlier);
  } finally {
    await built.runtime.stop();
  }
});

test("incremental transcript reads bound canonical storage and preserve windows and pins", async () => {
  const built = freshApp();
  try {
    const { session, narration } = await coarseForeignSession(built.sessions, 100);
    await built.app.pinConversationItem(session.threadRef, "U1", { entrySeq: narration.seq });
    const canonical = built.sessions.getTranscriptEntries.bind(built.sessions);
    const calls: Array<{ sinceSeq?: number; beforeSeq?: number } | undefined> = [];
    let loadedRows = 0;
    built.sessions.getTranscriptEntries = async (id, opts) => {
      calls.push(opts);
      const rows = await canonical(id, opts);
      loadedRows += rows.length;
      return rows;
    };
    for (const read of [
      () => built.app.getSession(session.id, { sinceSeq: 490 }),
      () => built.app.getSessionForViewer(session.id, "U1", { sinceSeq: 490 }),
    ]) {
      calls.length = 0;
      loadedRows = 0;
      const page = (await read())!;
      assert.equal(page.entries.length, 10);
      assert.equal(page.earlierEntries, 490);
      assert.equal(loadedRows, 10);
      assert.ok(calls.every((opts) => opts?.sinceSeq === 490));
    }
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    await built.sessions.append(lease!, {
      type: "soul",
      payload: { text: "legacy instructions" },
      scopeLabel: session.scopeId,
    });
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, {
        type: "user",
        payload: { text: `new question ${i}` },
        scopeLabel: session.scopeId,
      });
      await built.sessions.append(lease!, {
        type: "assistant",
        payload: { text: `new reply ${i}` },
        scopeLabel: session.scopeId,
      });
    }
    await built.sessions.removeParticipant(session.id, "U1");
    await built.sessions.append(lease!, {
      type: "user",
      payload: { text: "after departure" },
      scopeLabel: session.scopeId,
    });
    await built.sessions.releaseLease(lease!);
    for (const viewer of [undefined, "U1", "late", "stranger"]) {
      const read = (window?: { sinceSeq?: number; beforeSeq?: number }) =>
        viewer === undefined
          ? built.app.getSession(session.id, window)
          : built.app.getSessionForViewer(session.id, viewer, window);
      const full = await read();
      for (const window of [
        { sinceSeq: 490 },
        { sinceSeq: 500, beforeSeq: 515 },
        { sinceSeq: 515, beforeSeq: 500 },
        { sinceSeq: 900 },
      ]) {
        calls.length = 0;
        const page = await read(window);
        if (!full) {
          assert.equal(page, null);
          continue;
        }
        const expected = windowedTranscript(full.entries as SessionEntry[], window);
        assert.deepEqual(page!.entries, expected.entries);
        assert.equal(page!.earlierEntries ?? 0, expected.earlier);
        assert.deepEqual(page!.pins, full.pins);
        assert.ok(calls.length > 0);
        assert.ok(calls.some((opts) => opts?.sinceSeq === window.sinceSeq));
      }
    }
    withoutCanonicalTranscript(built.sessions);
    for (const viewer of [undefined, "U1", "late"]) {
      const read = (window?: { sinceSeq?: number; beforeSeq?: number }) =>
        viewer === undefined
          ? built.app.getSession(session.id, window)
          : built.app.getSessionForViewer(session.id, viewer, window);
      const full = (await read())!;
      for (const window of [
        { sinceSeq: 490, beforeSeq: 516 },
        { sinceSeq: 515, beforeSeq: 520 },
      ]) {
        const expected = windowedTranscript(full.entries as SessionEntry[], window);
        const page = (await read(window))!;
        assert.deepEqual(page.entries, expected.entries);
        assert.equal(page.earlierEntries ?? 0, expected.earlier);
      }
    }
  } finally {
    await built.runtime.stop();
  }
});

test("incremental reads retain coarse tape fallback when a canonical prefix is missing", async () => {
  const built = freshApp();
  try {
    const { session } = await coarseForeignSession(built.sessions, 100);
    const canonical = built.sessions.getTranscriptEntries.bind(built.sessions);
    built.sessions.getTranscriptEntries = async (id, opts) =>
      (await canonical(id, opts)).filter((entry) => entry.seq >= 450);
    built.sessions.canReadTranscriptSuffix = async () => false;
    const full = (await built.app.getSession(session.id))!;
    assert.equal(full.entries.length, 200);
    const window = { sinceSeq: 490 };
    const expected = windowedTranscript(full.entries as SessionEntry[], window);
    for (const page of [
      await built.app.getSession(session.id, window),
      await built.app.getSessionForViewer(session.id, "U1", window),
    ]) {
      assert.deepEqual(page!.entries, expected.entries);
      assert.equal(page!.earlierEntries ?? 0, expected.earlier);
    }
  } finally {
    await built.runtime.stop();
  }
});
