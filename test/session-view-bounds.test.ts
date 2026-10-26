import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { windowedTranscript, type Lease, type SessionStore } from "../src/sessions/session-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import type { Item, NewItem } from "../src/sessions/items.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-view-bounds-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("a tailTurns view is bounded yet reports the same earlierItems as the full read", async () => {
  const { app, runtime } = freshApp();
  runtime.start();
  try {
    for (let i = 0; i < 45; i++) await app.turn(dm(`question number ${i}`, "web:U1:bounds"));
    const sid = (await app.turn(dm("final question", "web:U1:bounds"))).sessionId!;
    const full = (await app.getSessionForViewer(sid, "U1"))!;
    const expected = windowedTranscript(
      (await app.getSessionForViewer(sid, "U1", { tailTurns: 9999 }))!.items as Item[],
      { tailTurns: 2 },
    );
    const bounded = (await app.getSessionForViewer(sid, "U1", { tailTurns: 2 }))!;
    assert.deepEqual(
      bounded.items.map((e) => [e.seq, e.kind]),
      expected.items.map((e) => [e.seq, e.kind]),
    );
    const fullCount = full.items.length + (full.earlierItems ?? 0);
    assert.equal(
      bounded.items.length + (bounded.earlierItems ?? 0),
      fullCount,
      "bounded earlierItems accounts for exactly the renderable entries above the window",
    );
  } finally {
    await runtime.stop();
  }
});

async function toolHeavySession(sessions: SessionStore, turns = 1) {
  const scope = scopeId("personal", "U1");
  const session = await sessions.getOrCreateByThread("web:U1:tool-pins", "dm", scope, undefined, "web");
  await sessions.addParticipant(session.id, "U1", undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(session.id);
  const held = lease as Lease;
  const emit = (item: NewItem) => sessions.append(held, item);
  let narration: Item | undefined;
  let reply: Item | undefined;
  for (let turn = 0; turn < turns; turn++) {
    const ask = `codex, tidy queue ${turn}`;
    await emit({ kind: "UserMessage", text: ask });
    const turnNarration = await emit({
      kind: "AgentMessage",
      variant: "narration",
      text: turn === 0 ? "queue narration detail" : `narration ${turn}`,
    });
    narration ??= turnNarration;
    await emit({ kind: "ToolCall", tool: "execute", callId: `c${turn}`, body: { command: "tidy" } });
    await emit({ kind: "ToolResult", tool: "execute", callId: `c${turn}`, isError: false, text: "tidied" });
    reply = await emit({ kind: "AgentMessage", text: `Queue ${turn} tidied.` });
  }
  await sessions.releaseLease(held);
  return { session, narration: narration!, reply: reply! };
}

test("transcripts retain tool detail and exact bounded counts", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const { session, narration } = await toolHeavySession(built.sessions, 30);
    const full = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 9999 }))!;
    assert.deepEqual(full.items, await built.sessions.getItems(session.id));
    assert.equal(full.items.length, 150);
    const bounded = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 1 }))!;
    assert.deepEqual(bounded.items, full.items.slice(-5));
    assert.equal(bounded.earlierItems, 145);
    const pinned = await built.app.pinConversationItem("web:U1:tool-pins", "U1", { entrySeq: narration.seq });
    assert.ok("pin" in pinned && pinned.pin);
    assert.equal(pinned.pin.preview, "queue narration detail");
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages bound entry reads, widen for dense turns, and match full-read windows", async () => {
  const built = freshApp();
  try {
    const { session } = await toolHeavySession(built.sessions, 100);
    const canonical = built.sessions.getItems.bind(built.sessions);
    const calls: Array<{ limit?: number; beforeSeq?: number } | undefined> = [];
    built.sessions.getItems = async (id, opts) => {
      calls.push(opts);
      return canonical(id, opts);
    };
    for (const beforeSeq of [1, 50, 251, 499, 900]) {
      const full = (await built.app.getSessionForViewer(session.id, "U1"))!;
      calls.length = 0;
      const window = { beforeSeq, tailTurns: 2 };
      const expected = windowedTranscript(full.items as Item[], window);
      for (const page of [
        await built.app.getSessionForViewer(session.id, "U1", window),
        await built.app.getSession(session.id, window),
      ]) {
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
      }
      assert.ok(calls.every((opts) => opts?.beforeSeq === beforeSeq && opts.limit === 80));
    }
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 180; i++)
      await built.sessions.append(lease!, { kind: "AgentMessage", variant: "narration", text: `detail ${i}` });
    await built.sessions.releaseLease(lease!);
    calls.length = 0;
    const page = await built.app.getSession(session.id, { beforeSeq: 680, tailTurns: 1 });
    assert.equal(page!.items[0]!.seq, 495);
    assert.deepEqual(
      calls.map((opts) => opts?.limit),
      [40, 80, 160, 320],
    );
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages respect viewer tenure boundaries", async () => {
  const built = freshApp();
  try {
    const { session } = await toolHeavySession(built.sessions, 30);
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, { kind: "UserMessage", text: `late question ${i}` });
      await built.sessions.append(lease!, { kind: "AgentMessage", text: `late reply ${i}` });
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
        const expected = windowedTranscript(full.items as Item[], { beforeSeq, tailTurns: 2 });
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
      }
    }
  } finally {
    await built.runtime.stop();
  }
});

test("incremental transcript reads bound entry storage and preserve windows and pins", async () => {
  const built = freshApp();
  try {
    const { session, narration } = await toolHeavySession(built.sessions, 100);
    await built.app.pinConversationItem(session.threadRef, "U1", { entrySeq: narration.seq });
    const canonical = built.sessions.getItems.bind(built.sessions);
    const calls: Array<{ sinceSeq?: number; beforeSeq?: number } | undefined> = [];
    let loadedRows = 0;
    built.sessions.getItems = async (id, opts) => {
      calls.push(opts);
      const rows = await canonical(id, opts);
      loadedRows += rows.length;
      return rows;
    };
    const page = (await built.app.getSession(session.id, { sinceSeq: 490 }))!;
    assert.equal(page.items.length, 10);
    assert.equal(page.earlierItems, 490);
    assert.equal(loadedRows, 10);
    assert.ok(calls.every((opts) => opts?.sinceSeq === 490));
    const viewerPage = (await built.app.getSessionForViewer(session.id, "U1", { sinceSeq: 490 }))!;
    assert.deepEqual(viewerPage.items, page.items);
    assert.equal(viewerPage.earlierItems, 490);
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, { kind: "UserMessage", text: `new question ${i}` });
      await built.sessions.append(lease!, { kind: "AgentMessage", text: `new reply ${i}` });
    }
    await built.sessions.removeParticipant(session.id, "U1");
    await built.sessions.append(lease!, { kind: "UserMessage", text: "after departure" });
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
        const expected = windowedTranscript(full.items as Item[], window);
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
        assert.deepEqual(page!.pins, full.pins);
        if (viewer === undefined) assert.ok(calls.some((opts) => opts?.sinceSeq === window.sinceSeq));
      }
    }
  } finally {
    await built.runtime.stop();
  }
});
