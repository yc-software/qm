import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { scopeId, type Principal } from "../src/types.ts";

const alice: Principal = { id: "alice@example.com", type: "internal" };
const bob: Principal = { id: "bob@example.com", type: "internal" };

test("session search reuses indexed search with participant intersection, tenure windows and bounded references", async () => {
  const { app, sessions } = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-search-tool-")), publicWebUrl: "https://qm.example" }),
  );
  const scope = scopeId("group", "room");
  const current = await sessions.getOrCreateByThread("web:room", "group", scope);
  const source = await sessions.getOrCreateByThread("web:source", "group", scopeId("group", "source"));
  await sessions.addParticipant(source.id, alice.id, undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(source.id);
  assert.ok(lease);
  await sessions.append(lease, {
    type: "user",
    payload: { text: "memo before Bob joined" },
    scopeLabel: source.scopeId,
  });
  await sessions.addParticipant(source.id, bob.id);
  const shared = await sessions.append(lease, {
    type: "user",
    payload: { text: "memo shared" },
    scopeLabel: source.scopeId,
  });
  await sessions.releaseLease(lease);
  const { runs } = createMemoryRunStore();
  let members: Principal[] | undefined;
  const factory = createSessionSyscalls({
    sessions,
    runs,
    signals: createMemoryRunSignalStore(),
    mailbox: createSessionMailbox(createMemoryMap<SessionMessage>()),
    maxAttempts: 1,
    prepareRequest: async (request) => ({
      ...request,
      conversation: { ...request.conversation, publishMembers: members },
    }),
    conversations: {
      list: async () => [],
      start: async () => ({ error: "unused" }),
      search: ({ query, principals, limit }) => app.searchConversations(query, principals, limit),
    },
  });
  const tools = factory.forTurn({
    session: current,
    scopeId: scope,
    request: {
      surface: "web",
      actor: alice,
      conversation: { kind: "group", threadRef: current.threadRef, audience: [alice], publishMembers: [alice] },
    },
  });
  await assert.rejects(() => tools.search!({ query: "memo" }), /complete principal set/);
  members = [bob];
  const result = await tools.search!({ query: "memo" });
  assert.deepEqual(result.failedBackends, []);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(
    result.hits.map((h) => [h.metadata?.sessionId, h.metadata?.seq, h.snippet, h.url]),
    [[source.id, shared.seq, "memo shared", `https://qm.example/s/${source.id}`]],
  );
  assert.equal((await tools.search!({ query: "memo shared", limit: 1 })).hits.length, 1);
  members = [alice];
  assert.equal((await tools.search!({ query: "memo" })).hits.length, 2);
  assert.equal((await tools.search!({ query: "memo", limit: 1 })).hits.length, 1);
  members = [bob, { id: "outsider@example.com", type: "internal" }];
  assert.deepEqual((await tools.search!({ query: "memo" })).hits, []);
});
