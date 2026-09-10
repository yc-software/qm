import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { stoppedPartialTapeMessage, stripImageBytes } from "../src/harness/pi-harness.ts";
import { foldTape } from "../src/harness/tape-fold.ts";
import { tapeCheckpointPayload, tapeEntryMirrorRecord } from "../src/sessions/session-store.ts";
import { appendEntryOutsideTurn } from "../src/harness/tape-import.ts";
import { createTranscriptSource, projectTapeEntries } from "../src/harness/tape-projection.ts";
import { scopeId } from "../src/types.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:test@example.com" as ScopeId;

async function sessionWithLease() {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:tape-test", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease: lease! };
}

test("tape appends preserve order and round-trip payloads verbatim", async () => {
  const { store, session, lease } = await sessionWithLease();
  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
  const assistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "…", thinkingSignature: "sig" },
      { type: "text", text: "hello" },
    ],
    timestamp: 2,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
  };
  await store.appendTape(lease, {
    kind: "message",
    harness: "pi",
    payload: user,
    scopeLabel: scope,
    entrySeq: 0,
    meta: { bareText: "hi", ts: "1720000000.000100" },
  });
  await store.appendTape(lease, { kind: "message", harness: "pi", payload: assistant, scopeLabel: scope });
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: true }, scopeLabel: scope, entrySeq: 1 });

  const rows = await store.getTape(session.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1, 2],
  );
  assert.deepEqual(rows[0]!.payload, user);
  assert.deepEqual(rows[1]!.payload, assistant);
  assert.equal(rows[0]!.meta?.bareText, "hi");
  assert.equal(rows[0]!.meta?.ts, "1720000000.000100");
  assert.equal(rows[1]!.harness, "pi");
});

test("tape append without a valid lease throws", async () => {
  const { store, session } = await sessionWithLease();
  await assert.rejects(
    store.appendTape({ sessionId: session.id, token: "stale" }, { kind: "message", payload: {}, scopeLabel: scope }),
    /tape append without a valid session lease/,
  );
});

test("getTape limit returns the newest N oldest-first, matching getEntries semantics", async () => {
  const { store, session, lease } = await sessionWithLease();
  for (let i = 0; i < 4; i++) await store.appendTape(lease, { kind: "message", payload: { i }, scopeLabel: scope });
  const rows = await store.getTape(session.id, { limit: 2 });
  assert.deepEqual(
    rows.map((r) => r.seq),
    [2, 3],
  );
});

test("tapeCoverage counts only watermarks and import covers — message mirrors can't launder a gap", async () => {
  const { store, session, lease } = await sessionWithLease();
  assert.equal(await store.tapeCoverage(session.id), -1);
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: [] },
    scopeLabel: scope,
    coversEntrySeq: 41,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, {
    kind: "message",
    payload: { role: "user", content: [] },
    scopeLabel: scope,
    entrySeq: 42,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { subturnEnd: true }, scopeLabel: scope, entrySeq: 99 });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: "true" }, scopeLabel: scope, entrySeq: 98 });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: "compaction", text: "summary" },
    scopeLabel: scope,
    coversEntrySeq: 100,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: true }, scopeLabel: scope, entrySeq: 42 });
  assert.equal(await store.tapeCoverage(session.id), 42);
});

test("deleteSession removes tape rows", async () => {
  const { store, session, lease } = await sessionWithLease();
  await store.appendTape(lease, { kind: "message", payload: {}, scopeLabel: scope });
  await store.deleteSession(session.id);
  assert.deepEqual(await store.getTape(session.id), []);
});

test("stripImageBytes swaps image data for artifact refs when attachments line up", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: 1,
  };
  const stripped = stripImageBytes(message, [{ artifactId: "art-1" }]) as { content: Array<Record<string, unknown>> };
  assert.deepEqual(stripped.content[0], { type: "text", text: "look" });
  assert.deepEqual(stripped.content[1], { type: "image", mimeType: "image/png", artifactRef: "art-1" });
  const orphan = stripImageBytes(message, []) as { content: Array<Record<string, unknown>> };
  assert.deepEqual(orphan.content[1], { type: "image", mimeType: "image/png", omitted: true });
  const plain = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  assert.deepEqual(stripImageBytes(plain, []), plain);
});

test("a stopped turn tapes its partial as a replay-visible message exactly when replay would drop it", () => {
  const aborted = {
    role: "assistant",
    content: [{ type: "text", text: "half a thought" }],
    stopReason: "aborted",
  };
  const completed = { role: "assistant", content: [{ type: "text", text: "narration before a tool" }] };

  const fromAborted = stoppedPartialTapeMessage([{ role: "user" }, aborted], "half a thought", 5);
  assert.ok(fromAborted, "an aborted partial is re-taped so the replay keeps it");
  assert.equal(fromAborted!.stopReason, "stop");
  assert.deepEqual(fromAborted!.content, [{ type: "text", text: "half a thought" }]);
  assert.equal(fromAborted!.timestamp, 5);

  assert.ok(stoppedPartialTapeMessage([{ role: "user" }], "(stopped)", 6), "a stop before any output tapes the marker");
  assert.ok(
    stoppedPartialTapeMessage([{ role: "user" }, completed, aborted], "half a thought", 7),
    "the live text before the aborted step does not stand in for the dropped partial",
  );
  assert.equal(
    stoppedPartialTapeMessage([{ role: "user" }, completed], "narration before a tool", 8),
    null,
    "a partial that already replays as a live message is not duplicated",
  );
  const toolStep = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] };
  assert.equal(
    stoppedPartialTapeMessage([{ role: "user" }, completed, toolStep], "narration before a tool", 9),
    null,
    "a reply lifted from an earlier visible step is not re-taped when the last step is tool-only",
  );
});

test("an expired lease refuses tape and entry appends — one validity rule with renewLease", async () => {
  const store = createMemorySessionStore({ leaseTtlMs: 20 });
  const session = await store.getOrCreateByThread("dm:tape-expired", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await store.renewLease(lease!), false);
  await assert.rejects(
    store.appendTape(lease!, { kind: "message", payload: {}, scopeLabel: scope }),
    /tape append without a valid session lease/,
  );
  await assert.rejects(
    store.append(lease!, { type: "user", payload: { text: "late" }, scopeLabel: scope }),
    /append without a valid session lease/,
  );
});

test("clearSecurityTaint clears tape meta and mirrored payloads, and the fold re-admits the rows", async () => {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:U1:taint", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  await store.appendTape(lease, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "quarantined overheard" }], timestamp: 1 },
    scopeLabel: scope,
    meta: { overheard: true, bareText: "quarantined overheard", ts: "1.1", securityTainted: true },
  });
  const tainted = await store.appendTape(
    lease,
    tapeEntryMirrorRecord({
      seq: 0,
      createdAt: 1,
      type: "user",
      payload: { text: "flagged input", securityTainted: true, hidden: true },
      scopeLabel: scope,
    }),
  );
  assert.equal(
    (tainted.payload as { entry: { payload: { securityTainted?: boolean } } }).entry.payload.securityTainted,
    true,
  );

  assert.deepEqual(foldTape(await store.getTape(session.id)), [], "tainted message rows never fold");

  assert.equal(await store.clearSecurityTaint(session.id), true);
  const rows = await store.getTape(session.id);
  assert.ok(
    rows.every((r) => r.meta?.securityTainted !== true),
    "the meta flag is gone",
  );
  const mirror = rows.find((r) => r.kind === "annotation")!;
  assert.equal(
    "securityTainted" in (mirror.payload as { entry: { payload: Record<string, unknown> } }).entry.payload,
    false,
    "the mirrored payload sheds the flag too",
  );
  assert.equal(foldTape(rows).length, 1, "the cleared row folds back into model context");
  await store.releaseLease(lease);
});

test("a stamped user entry counts one turn no matter how many rows carry it, in either order", async () => {
  const store = createMemorySessionStore();
  const scopeC = scopeId("channel", "C-turns");
  const mk = async (thread: string, first: "mirror" | "message") => {
    const session = await store.getOrCreateByThread(thread, "channel", scopeC);
    const { lease } = await store.acquireLease(session.id);
    const mirror = tapeEntryMirrorRecord({
      seq: 0,
      createdAt: 5,
      type: "user",
      payload: { text: "hi there" },
      scopeLabel: scopeC,
    });
    const message = {
      kind: "message" as const,
      payload: { role: "user", content: [{ type: "text", text: "hi there" }], timestamp: 5 },
      scopeLabel: scopeC,
      entrySeq: 0,
      meta: { bareText: "hi there", entryCreatedAt: 5 },
    };
    for (const rec of first === "mirror" ? [mirror, message] : [message, mirror]) {
      await store.appendTape(lease!, rec);
    }
    await store.releaseLease(lease!);
    return session.id;
  };
  const a = await mk("ch:C-turns:a", "mirror");
  const b = await mk("ch:C-turns:b", "message");
  const summaries = await store.scopeSessionSummaries(scopeC, false);
  assert.equal(summaries.find((s) => s.id === a)!.turns, 1);
  assert.equal(summaries.find((s) => s.id === b)!.turns, 1);
});

test("an out-of-turn append lands past a dead turn's unsettled tail instead of colliding", async () => {
  const store = createMemorySessionStore();
  const scopeD = scopeId("channel", "C-dead");
  const session = await store.getOrCreateByThread("ch:C-dead:1", "channel", scopeD);
  const { lease } = await store.acquireLease(session.id);
  await store.appendTape(lease!, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "crashed ask" }], timestamp: 1 },
    scopeLabel: scopeD,
    entrySeq: 0,
    meta: { bareText: "crashed ask", entryCreatedAt: 1 },
  });
  await store.appendTape(lease!, {
    kind: "message",
    harness: "pi",
    payload: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "execute", arguments: {} }],
      timestamp: 2,
      stopReason: "stop",
    },
    scopeLabel: scopeD,
  });
  const receipt = await appendEntryOutsideTurn(store, lease!, {
    type: "system",
    payload: { kind: "turn_failure", message: "died" },
    scopeLabel: scopeD,
  });
  assert.equal(receipt.seq, 2, "allocation continues past the dead turn's dense-filled tail");
  const projection = projectTapeEntries(session.id, await store.getTape(session.id), { openTail: true });
  assert.ok(projection, "the tape stays projectable after the out-of-turn append");
  assert.deepEqual(
    projection!.entries.map((e) => [e.seq, e.type]),
    [
      [0, "user"],
      [1, "tool_call"],
      [2, "system"],
    ],
  );
  await store.releaseLease(lease!);
});

test("the prior-turns seed import is fold-entitled and does not block rendering", async () => {
  const store = createMemorySessionStore();
  const scopeP = scopeId("channel", "C-seed");
  const session = await store.getOrCreateByThread("ch:C-seed:1", "channel", scopeP);
  const { lease } = await store.acquireLease(session.id);
  const seeded = [{ role: "user", content: [{ type: "text", text: "earlier thread chatter" }], timestamp: 1 }];
  const imported = await store.appendTape(lease!, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: seeded, scopes: [scopeP] },
    scopeLabel: scopeP,
  });
  await store.appendTape(lease!, {
    kind: "context_event",
    payload: { event: "render_import", firstTapeSeq: imported.seq + 1 },
    scopeLabel: scopeP,
  });
  await store.appendTape(lease!, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "first real ask" }], timestamp: 2 },
    scopeLabel: scopeP,
    entrySeq: 0,
    meta: { bareText: "first real ask", entryCreatedAt: 2 },
  });
  await store.appendTape(lease!, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", undefined, 0),
    scopeLabel: scopeP,
    entrySeq: 0,
  });
  const rows = await store.getTape(session.id);
  const projection = projectTapeEntries(session.id, rows);
  assert.ok(projection, "the anchored seed never blocks the projection");
  assert.deepEqual(
    projection!.entries.map((e) => e.type),
    ["user"],
  );
  assert.ok(JSON.stringify(foldTape(rows)).includes("earlier thread chatter"), "the seed still feeds the fold");
  await store.releaseLease(lease!);
});

test("a mid-turn read serves the settled prefix, never an empty archive fallback", async () => {
  const store = createMemorySessionStore();
  const scopeM = scopeId("channel", "C-midturn");
  const session = await store.getOrCreateByThread("ch:C-midturn:1", "channel", scopeM);
  const { lease } = await store.acquireLease(session.id);
  await store.appendTape(lease!, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "settled ask" }], timestamp: 1 },
    scopeLabel: scopeM,
    entrySeq: 0,
    meta: { bareText: "settled ask", entryCreatedAt: 1 },
  });
  await store.appendTape(lease!, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", undefined, 0),
    scopeLabel: scopeM,
    entrySeq: 0,
  });
  await store.appendTape(lease!, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "in-flight ask" }], timestamp: 2 },
    scopeLabel: scopeM,
    entrySeq: 1,
    meta: { bareText: "in-flight ask", entryCreatedAt: 2 },
  });
  const read = await createTranscriptSource(store).forRender(session.id);
  assert.deepEqual(
    read.entries.map((e) => (e.payload as { text?: string }).text),
    ["settled ask"],
    "the settled prefix serves while a turn is in flight",
  );
  await store.releaseLease(lease!);
});
