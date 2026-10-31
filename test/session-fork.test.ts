import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { SideChatAnchorError } from "../src/api/app-types.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-fork-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("forking copies the transcript into a fresh independent web session", async () => {
  const { app, sessions } = freshApp();
  await app.turn(dm("First question about deploys", "web:U1:f1"));
  const r2 = await app.turn(dm("Second question about rollbacks", "web:U1:f1"));
  const sid = r2.sessionId!;
  const source = (await app.getSession(sid))!;

  const fork = await app.forkSession(sid, "U1");
  assert.ok(fork, "participant can fork");
  assert.notEqual(fork.session.id, sid);
  assert.ok(fork.session.threadRef.startsWith("web:U1:"), "fork lives on a fresh web thread");
  assert.equal(fork.session.surface, "web");
  assert.notEqual(fork.session.threadRef, source.session.threadRef);
  assert.equal(fork.session.scopeId, source.session.scopeId);
  const stored = await Promise.all(
    source.entries.map(async (e) => (await app.getSessionEntryForViewer(sid, "U1", e.seq))!.entry),
  );
  assert.deepEqual(
    fork.entries.map((e) => [e.type, e.payload]),
    stored.map((e) => [e.type, e.payload]),
    "the fork copies whole stored entries, model context included, not the trimmed view",
  );
  assert.deepEqual(fork.session.forkedFrom, { sessionId: sid, title: source.session.title ?? null });
  assert.equal(fork.session.forkBoundarySeq, fork.entries.at(-1)?.seq);

  const mine = await app.listSessions("U1");
  assert.ok(mine.some((s) => s.id === fork.session.id));
  assert.deepEqual(await sessions.getEntries(fork.session.id), fork.entries);
});

test("upToSeq truncates the copy at the cut point", async () => {
  const { app } = freshApp();
  await app.turn(dm("Keep this turn", "web:U1:f2"));
  const r2 = await app.turn(dm("Drop this turn", "web:U1:f2"));
  const sid = r2.sessionId!;
  const entries = (await app.getSession(sid))!.entries;
  const secondUser = entries.filter((e) => e.type === "user")[1]!;

  const fork = await app.forkSession(sid, "U1", { upToSeq: secondUser.seq - 1 });
  assert.ok(fork);
  assert.ok(fork.entries.length > 0, "the first turn is kept");
  const copiedTexts = fork.entries
    .filter((e) => e.type === "user")
    .map((e) => (e.payload as { text?: string }).text ?? "");
  assert.ok(copiedTexts.some((t) => t.includes("Keep this turn")));
  assert.ok(!copiedTexts.some((t) => t.includes("Drop this turn")));
  assert.equal(fork.session.forkBoundarySeq, fork.entries.at(-1)?.seq);
});

test("a single-entry fork (boundary seq 0) still records provenance", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Only the opening message survives the cut", "web:U1:seq0"));
  const sid = r.sessionId!;
  const first = (await app.getSession(sid))!.entries[0]!;
  const fork = await app.forkSession(sid, "U1", { upToSeq: first.seq });
  assert.ok(fork);
  assert.equal(fork.entries.length, 1);
  assert.equal(fork.entries[0]!.seq, 0, "entry seqs are 0-based");
  assert.deepEqual(fork.session.forkedFrom, {
    sessionId: sid,
    title: (await app.getSession(sid))!.session.title ?? null,
  });
  assert.equal(fork.session.forkBoundarySeq, 0);
});

test("an empty fork has no provenance", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Nothing before zero", "web:U1:empty"));
  const fork = await app.forkSession(r.sessionId!, "U1", { upToSeq: -1 });
  assert.ok(fork);
  assert.equal(fork.entries.length, 0);
  assert.equal(fork.session.forkedFrom, undefined);
  assert.equal(fork.session.forkBoundarySeq, undefined);
});

test("the fork inherits a marked title and the original keeps its own history", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Plan the database migration", "web:U1:f3"));
  const sid = r.sessionId!;
  await app.updateSession(sid, "U1", { title: "Migration plan" });

  const fork = (await app.forkSession(sid, "U1"))!;
  const before = (await app.getSession(sid))!.entries.length;
  await app.turn(dm("A follow-up only in the fork", fork.session.threadRef));
  assert.equal((await app.getSession(sid))!.entries.length, before, "turns on the fork do not touch the source");
  const forkTitle = (await app.getSession(fork.session.id))!.session.title;
  assert.equal(forkTitle, "Chat: Plan the database migration (fork)");
});

test("a stranger cannot fork someone else's conversation", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Private planning", "web:U1:f4"));
  assert.equal(await app.forkSession(r.sessionId!, "intruder"), null);
  assert.equal(await app.forkSession("does-not-exist", "U1"), null);
});

test("side chats preserve their anchor, stay out of session pages, and expand in place", async () => {
  const { app, sessions } = freshApp();
  const result = await app.turn(dm("Explain shared queues", "web:U1:side-chat"));
  const source = (await app.getSession(result.sessionId!))!;
  const entry = source.entries[0]!;
  const fork = await app.forkSession(source.session.id, "U1", {
    upToSeq: source.entries.at(-1)!.seq,
    sideChat: { entrySeq: entry.seq, quote: "shared queues", occurrence: 0 },
  });
  assert.ok(fork);
  assert.deepEqual(fork.session.sideChat, {
    entrySeq: entry.seq,
    quote: "shared queues",
    occurrence: 0,
    expanded: false,
  });
  assert.deepEqual(await app.sideChats("U1", source.session.id), []);
  await app.turn(dm("Explain that passage", fork.session.threadRef));
  assert.equal((await app.sideChats("U1", source.session.id))![0]!.id, fork.session.id);
  assert.equal(await app.sideChats("stranger", source.session.id), null);
  assert.equal(await app.expandSideChat("stranger", fork.session.id), null);
  const page = await app.listSessionPage("U1", { limit: 50 });
  assert.ok(!page.sessions.some((session) => session.id === fork.session.id));
  const before = await sessions.getEntries(fork.session.id);
  const expanded = await app.expandSideChat("U1", fork.session.id);
  assert.equal(expanded?.id, fork.session.id);
  assert.equal(expanded?.sideChat?.expanded, true);
  assert.deepEqual(await sessions.getEntries(fork.session.id), before);
  assert.ok(
    (await app.listSessionPage("U1", { limit: 50 })).sessions.some((session) => session.id === fork.session.id),
  );
  assert.equal((await app.sideChats("U1", source.session.id))![0]!.sideChat?.expanded, true);
});

test("side chats reject missing anchors and anchors beyond the fork boundary", async () => {
  const { app } = freshApp();
  const result = await app.turn(dm("Explain shared queues", "web:U1:bad-side-chat"));
  const source = (await app.getSession(result.sessionId!))!;
  const last = source.entries.at(-1)!.seq;
  for (const occurrence of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      app.forkSession(source.session.id, "U1", {
        sideChat: { entrySeq: 0, quote: "shared queues", occurrence: occurrence as number },
      }),
      SideChatAnchorError,
    );
  }
  await assert.rejects(
    app.forkSession(source.session.id, "U1", {
      upToSeq: last,
      sideChat: { entrySeq: last + 1, quote: "not visible", occurrence: 0 },
    }),
    SideChatAnchorError,
  );
  await assert.rejects(
    app.forkSession(source.session.id, "U1", {
      upToSeq: last,
      sideChat: { entrySeq: 0, quote: " ", occurrence: 0 },
    }),
    SideChatAnchorError,
  );
});

test("side-chat reads bind the query principal to the authenticated portal identity", async () => {
  const { app } = freshApp();
  const result = await app.turn(dm("Explain shared queues", "web:U1:side-chat-auth"));
  const fork = await app.forkSession(result.sessionId!, "U1", {
    sideChat: { entrySeq: 0, quote: "shared queues", occurrence: 0 },
  });
  assert.ok(fork);
  await app.turn(dm("Explain that passage", fork.session.threadRef));
  const sourceSecret = "side-chat-source-secret-for-http-tests";
  const identitySecret = "side-chat-identity-secret-for-http-tests";
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    capabilitySecret: "side-chat-capability-secret-for-http-tests",
    portalIdentitySecret: identitySecret,
    production: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (principal: string, actor?: string) => {
    const path = `/v1/sessions/${result.sessionId}/side-chats?principalId=${principal}&nonce=${crypto.randomUUID()}`;
    return fetch(base + path, {
      headers: {
        ...signedRequestHeaders(sourceSecret, "GET", path),
        ...(actor
          ? { "x-portal-identity": await mintSignedPayload({ p: actor, exp: Date.now() + 60_000 }, identitySecret) }
          : {}),
      },
    });
  };
  try {
    const response = await read("U1", "U1");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      body.sessions.map((session) => session.id),
      [fork.session.id],
    );
    assert.equal((await read("U1", "U2")).status, 403);
    assert.equal((await read("U1")).status, 401);
    assert.equal((await read("U2", "U2")).status, 404);
    const forkPath = `/v1/sessions/${result.sessionId}/fork?nonce=${crypto.randomUUID()}`;
    const forkBody = JSON.stringify({
      principalId: "U1",
      sideChat: { entrySeq: 999, quote: "shared queues", occurrence: 0 },
    });
    const rejected = await fetch(base + forkPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedRequestHeaders(sourceSecret, "POST", forkPath, forkBody),
        "x-portal-identity": await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, identitySecret),
      },
      body: forkBody,
    });
    assert.equal(rejected.status, 400);
    assert.match(((await rejected.json()) as { message: string }).message, /forked range/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
