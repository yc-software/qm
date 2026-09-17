import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { foldTape } from "../src/harness/tape-fold.ts";
import { tapeTranscriptEntryRecord } from "../src/sessions/session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:canonical@example.com" as ScopeId;

async function scenario() {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("canonical-transcript", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease };
}

test("exact tape annotations retain tool fields without advancing model coverage", async () => {
  const { store, session, lease } = await scenario();
  const entry = await store.append(lease, {
    type: "tool_result",
    scopeLabel: scope,
    payload: {
      tool: "execute",
      callId: "failed",
      stdout: "",
      stderr: "denied",
      code: 1,
      isError: true,
      result: "denied",
    },
  });
  assert.deepEqual(await store.getEntries(session.id), [entry]);
  assert.equal(await store.tapeCoverage(session.id), -1);
  assert.deepEqual(foldTape(await store.getTape(session.id)), []);
  const source = createTranscriptSource(store);
  assert.deepEqual((await source.forRender(session.id)).entries, [entry]);
});

test("taint release supersedes the exact annotation without changing identity or native model history", async () => {
  const { store, session, lease } = await scenario();
  await store.append(lease, { type: "user", payload: { text: "reviewed", securityTainted: true }, scopeLabel: scope });
  const before = await store.getEntries(session.id);
  const beforeRows = await store.getTape(session.id);
  assert.equal(await store.clearSecurityTaint(session.id), true);
  assert.deepEqual(await store.getEntries(session.id), [{ ...before[0]!, payload: { text: "reviewed" } }]);
  assert.equal((await store.getTape(session.id)).length, beforeRows.length + 1);
  assert.equal(await store.tapeCoverage(session.id), -1);
  assert.deepEqual(foldTape(await store.getTape(session.id)), []);
  assert.equal(await store.clearSecurityTaint(session.id), true);
  assert.equal((await store.getTape(session.id)).length, beforeRows.length + 1);
});

test("canonical transcript reads preserve full histories, bounded tails and participant windows", async () => {
  const { store, session, lease } = await scenario();
  for (let i = 0; i < 620; i++) {
    if (i === 300) await store.addParticipant(session.id, "viewer");
    if (i === 550) await store.removeParticipant(session.id, "viewer");
    await store.append(lease, { type: "user", payload: { text: `message ${i}` }, scopeLabel: scope });
  }
  const entries = await store.getEntries(session.id);
  const visible = await store.visibleEntries(session.id, "viewer");
  const calls: Array<number | undefined> = [];
  const source = createTranscriptSource({
    ...store,
    getEntries: (id, opts) => {
      calls.push(opts?.limit);
      return store.getEntries(id, opts);
    },
  });
  assert.deepEqual((await source.forRender(session.id)).entries, entries);
  assert.deepEqual(await source.forRender(session.id, { limit: 6 }), { entries: entries.slice(-6), earlier: 614 });
  assert.equal(calls.at(-1), 6);
  assert.deepEqual((await source.forRender(session.id, { sinceSeq: 615 })).entries, entries.slice(615));
  assert.deepEqual((await source.forViewer(session.id, "viewer")).entries, visible);
  assert.deepEqual((await source.forViewer(session.id, "stranger")).entries, []);
});

test("transcript adapter reads the authoritative store once", async () => {
  const { store, session, lease } = await scenario();
  for (let i = 0; i < 3; i++) await store.append(lease, { type: "user", payload: { text: `${i}` }, scopeLabel: scope });
  const entries = await store.getEntries(session.id);
  let reads = 0;
  const source = createTranscriptSource({
    ...store,
    getEntries: async () => {
      reads++;
      return entries;
    },
  });
  assert.deepEqual((await source.forRender(session.id)).entries, entries);
  assert.equal(reads, 1);
});

test("historical canonical annotations preserve original parent, scope and timestamp", async () => {
  const { store, session, lease } = await scenario();
  const entry = await store.append(lease, { type: "user", payload: { text: "original" }, scopeLabel: scope });
  const historical = { ...entry, parentSeq: null, createdAt: 123, scopeLabel: "org:historic" as ScopeId };
  await store.appendTape(lease, tapeTranscriptEntryRecord(historical));
  assert.deepEqual(await store.getEntries(session.id), [historical]);
});
