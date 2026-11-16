import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

async function seed(sessions: SessionStore, threadRef: string, principal: string, texts: string[]): Promise<string> {
  const s = await sessions.getOrCreateByThread(threadRef, "dm", scopeId("personal", principal));
  await sessions.addParticipant(s.id, principal);
  const writer = { sessionId: s.id };
  for (const [i, text] of texts.entries()) {
    await sessions.append(
      writer,
      i % 2 === 0 ? { kind: "UserMessage", text, body: { name: "josh" } } : { kind: "AgentMessage", text },
    );
  }
  return s.id;
}

test("session store: searchEntries matches user and assistant text, newest first", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const id = await seed(store, "web:U1:a", "U1", [
    "can you refresh the memo board?",
    "Done — the memo board refresh is pushed.",
    "unrelated chatter",
  ]);

  const hits = await store.searchEntries("U1", "memo board");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.sessionId, id);
  assert.equal(hits[0]!.type, "assistant", "assistant reply is found too");
  assert.equal(hits[1]!.author, "josh", "user hits carry the author");
  assert.ok(hits[0]!.createdAt >= hits[1]!.createdAt, "newest first");

  assert.deepEqual(await store.searchEntries("U1", "memo missing"), [], "every term must match");
  assert.deepEqual(await store.searchEntries("U1", "  "), [], "blank query matches nothing");
  assert.equal((await store.searchEntries("U1", "memo"))[0]!.text.includes("memo"), true);
});

test("session store: search follows current membership and identity", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s = await store.getOrCreateByThread("web:U1:w", "dm", scopeId("personal", "U1"));
  await store.addParticipant(s.id, "U1");
  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "UserMessage", text: "secret prelude" });
  await store.addParticipant(s.id, "U2");
  await store.append(writer, { kind: "UserMessage", text: "shared secret plans" });

  assert.equal((await store.searchEntries("U2", "secret")).length, 2, "a late joiner finds the earlier message too");
  assert.deepEqual(await store.searchEntries("U3", "secret"), [], "a non-participant sees nothing");
  await store.removeParticipant(s.id, "U2");
  assert.deepEqual(await store.searchEntries("U2", "secret"), [], "a removed participant sees nothing");
  assert.equal((await store.searchEntries("U1", "secret")).length, 2);
});

test("session store: search ignores non-conversational entry types", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s = await store.getOrCreateByThread("web:U1:t", "dm", scopeId("personal", "U1"));
  await store.addParticipant(s.id, "U1");
  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "ToolCall", tool: "execute", callId: "c1", body: { text: "grep zanzibar" } });
  await store.append(writer, { kind: "AgentMessage", variant: "narration", text: "zanzibar itinerary" });

  const hits = await store.searchEntries("U1", "zanzibar");
  assert.equal(hits.length, 1, "tool calls are not searched");
  assert.equal(hits[0]!.type, "text");
});

test("app.searchSessions decorates hits with session metadata and enforces visibility", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "search-"));
  const { app, sessions } = buildApp(testConfig({ dataDir }));

  const id = await seed(sessions, "web:U1:hit", "U1", [
    "let's plan the zanzibar trip",
    "Zanzibar it is — I drafted an itinerary.",
  ]);
  const writer = { sessionId: id };
  await sessions.append(writer, {
    kind: "ToolResult",
    tool: "execute",
    callId: "c1",
    text: "zanzibar weather outputonly",
  });
  await sessions.updateTitle(id, "Trip planning");
  await seed(sessions, "web:U2:other", "U2", ["zanzibar for U2 only"]);

  sessions.listByParticipant = async () => {
    throw new Error("search must not list every session");
  };
  sessions.getForParticipant = async () => {
    throw new Error("search must not read legacy message activity");
  };
  assert.deepEqual(await app.searchSessions({ actorId: "U1" }, "outputonly"), []);
  const hits = await app.searchSessions({ actorId: "U1" }, "zanzibar");
  assert.equal(hits.length, 2, "only U1's own conversation is searched");
  assert.ok(hits.every((h) => h.sessionId === id));
  assert.equal(hits[0]!.title, "Trip planning");
  assert.equal(typeof hits[0]!.seq, "number");
  assert.ok(hits[0]!.snippet.toLowerCase().includes("zanzibar"));
  assert.equal(hits[1]!.author, "josh");

  assert.deepEqual(await app.searchSessions({ actorId: "U1" }, ""), [], "empty query is empty, not an error");
});

test("app.searchSessions finds sessions by title", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "search-"));
  const { app, sessions } = buildApp(testConfig({ dataDir }));

  const id = await seed(sessions, "web:U1:titled", "U1", ["hello there"]);
  await sessions.updateTitle(id, "Quarterly roadmap review");
  await seed(sessions, "web:U2:other2", "U2", ["hello there"]);

  const byTitle = await app.searchSessions({ actorId: "U1" }, "roadmap");
  assert.ok(byTitle.some((h) => h.sessionId === id && h.entryType === "title"));

  assert.deepEqual(await app.searchSessions({ actorId: "U2" }, "roadmap"), [], "title matches respect participation");
});
