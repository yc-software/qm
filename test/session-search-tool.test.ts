import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { scopeId, type Principal } from "../src/types.ts";

const alice: Principal = { id: "alice@example.com", type: "internal" };
const bob: Principal = { id: "bob@example.com", type: "internal" };

test("session search reuses indexed search with audience intersection, tenure windows and bounded references", async () => {
  const { app, sessions } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-search-tool-")) }));
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
  await sessions.append(lease, {
    type: "assistant",
    payload: { text: "memo private-only" },
    scopeLabel: scopeId("personal", alice.id),
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
    result.hits.map((h) => [h.metadata?.sessionId, h.metadata?.seq, h.snippet]),
    [[source.id, shared.seq, "memo shared"]],
  );
  assert.equal((await tools.search!({ query: "memo shared", limit: 1 })).hits.length, 1);
  assert.deepEqual((await app.search("private-only", [bob])).hits, []);
  assert.deepEqual(await app.searchSessions(bob.id, "private-only"), []);
  members = [alice];
  assert.equal((await tools.search!({ query: "memo" })).hits.length, 3);
  assert.equal((await tools.search!({ query: "memo", limit: 1 })).hits.length, 1);
  members = [bob, { id: "outsider@example.com", type: "internal" }];
  assert.deepEqual((await tools.search!({ query: "memo" })).hits, []);
});

test("shared session search resolves team labels against current membership", async () => {
  const { createSessionMethods } = await import("../src/api/app-sessions.ts");
  const { createMemorySessionStore } = await import("../src/sessions/memory-session-store.ts");
  const { createIdentityService } = await import("../src/identity/identity-service.ts");
  const sessions = createMemorySessionStore();
  const source = await sessions.getOrCreateByThread("web:team-search", "group", scopeId("group", "team-search"));
  await sessions.addParticipant(source.id, alice.id, undefined, { includeHistory: true });
  await sessions.addParticipant(source.id, bob.id, undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(source.id);
  assert.ok(lease);
  await sessions.append(lease, {
    type: "assistant",
    payload: { text: "engineering memo" },
    scopeLabel: scopeId("team", "eng"),
  });
  await sessions.releaseLease(lease);
  let member = alice.id;
  const methods = createSessionMethods(
    {
      sessions,
      identity: createIdentityService(),
      teams: { isMember: async (id, team) => id === member && team === "eng" },
    } as import("../src/api/app-types.ts").AppDeps,
    { managedProjectMembership: async () => undefined } as unknown as import("../src/api/app-helpers.ts").AppHelpers,
  );
  assert.equal((await methods.searchSessions(alice.id, "engineering")).length, 1);
  assert.deepEqual(await methods.searchSessions(bob.id, "engineering"), []);
  member = bob.id;
  assert.deepEqual(await methods.searchSessions(alice.id, "engineering"), []);
  assert.equal((await methods.searchSessions(bob.id, "engineering")).length, 1);
});
