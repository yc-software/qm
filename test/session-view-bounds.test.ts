import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { windowedTranscript, type Lease, type SessionStore } from "../src/sessions/session-store.ts";
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

async function foreignSession(sessions: SessionStore, turns = 1) {
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
        render: 1,
        entry: { type: "assistant", payload: { text: `Queue ${turn} tidied.` }, at: reply.createdAt },
      },
      scopeLabel: scope,
      entrySeq: reply.seq,
    });
    await sessions.appendTape(held, {
      kind: "annotation",
      payload: { turnEnd: true, render: 1 },
      scopeLabel: scope,
      entrySeq: reply.seq,
    });
  }
  await sessions.releaseLease(held);
  return { session, narration: narration!, reply: reply! };
}

test("bounded foreign-harness histories retain exact entries and counts", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const { session } = await foreignSession(built.sessions, 30);
    const full = (await built.app.getSession(session.id))!;
    assert.equal(full.earlierEntries ?? 0, 0, "the unbounded read reports nothing earlier");
    assert.equal(full.entries.length, 150, "canonical history retains narration and tools");
    const bounded = (await built.app.getSession(session.id, { tailTurns: 1 }))!;
    assert.deepEqual(
      bounded.entries.map((e) => [e.seq, e.type]),
      full.entries.slice(-bounded.entries.length).map((e) => [e.seq, e.type]),
    );
    assert.equal(
      bounded.entries.length + (bounded.earlierEntries ?? 0),
      full.entries.length,
      "earlierEntries counts exactly the entries above the window",
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

test("foreign-harness narration remains pinnable and participant-scoped", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const { session, narration } = await foreignSession(built.sessions);
    const view = (await built.app.getSessionForViewer(session.id, "U1"))!;
    assert.deepEqual(
      view.entries.map((e) => e.type),
      ["user", "text", "tool_call", "tool_result", "assistant"],
      "the transcript retains every original entry",
    );
    const pinned = await built.app.pinConversationItem("web:U1:coarse-pins", "U1", { entrySeq: narration.seq });
    assert.ok("pin" in pinned && pinned.pin, "pinning narration succeeds");
    assert.equal(pinned.pin!.preview, "queue narration detail");
    const listed = (await built.app.listConversationPins("web:U1:coarse-pins", "U1"))!;
    assert.equal(listed[0]!.preview, "queue narration detail");
    const fetched = await built.app.getSessionEntryForViewer(session.id, "U1", narration.seq);
    assert.equal((fetched?.entry.payload as { text?: string })?.text, "queue narration detail");
    const stranger = await built.app.getSessionEntryForViewer(session.id, "stranger", narration.seq);
    assert.equal(stranger, null, "the targeted read stays tenure-gated");
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages bound canonical reads, widen for dense turns, and match full-read windows", async () => {
  const built = freshApp();
  try {
    const { session } = await foreignSession(built.sessions, 100);
    const canonical = built.sessions.getEntries.bind(built.sessions);
    const calls: Array<{ limit?: number; beforeSeq?: number } | undefined> = [];
    built.sessions.getEntries = async (id, opts) => {
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

test("earlier pages retain viewer tenure boundaries", async () => {
  const built = freshApp();
  try {
    const { session } = await foreignSession(built.sessions, 30);
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
  } finally {
    await built.runtime.stop();
  }
});
