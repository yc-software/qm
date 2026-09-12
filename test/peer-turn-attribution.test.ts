import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import type { TurnOrigin, TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const HUMAN = { externalId: "U1", displayName: "Alice Human" };
const THREAD = "dm:U1:t1";

function freshApp(): BuiltApp {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "peer-turn-")) }));
}

function peerOrigin(overrides: Partial<Extract<TurnOrigin, { kind: "peer" }>> = {}): TurnOrigin {
  return { kind: "peer", senderSessionId: "sender-session", senderAgentName: "scout", messageId: "m-1", ...overrides };
}

function environmentOf(reply: string): string {
  return reply.slice(reply.indexOf("<environment>"), reply.indexOf("</environment>"));
}

function frameOf(reply: string): string {
  const end = reply.indexOf("<environment>");
  return end === -1 ? reply : reply.slice(0, end);
}

function humanTurn(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "test",
    actor: HUMAN,
    conversation: { kind: "dm", threadRef: THREAD, audience: [HUMAN] },
    text,
    ...extra,
  };
}

function peerTurn(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "peer",
    actor: HUMAN,
    conversation: { kind: "dm", threadRef: THREAD, audience: [HUMAN] },
    text,
    origin: peerOrigin(),
    ...extra,
  };
}

test("a peer turn renders the sender agent, never the recipient's own human", async () => {
  const { app } = freshApp();
  assert.equal((await app.turn(humanTurn("hello"))).status, "ok");

  const res = await app.turn(peerTurn("!sysprompt"));
  assert.equal(res.status, "ok", res.reason);
  const environment = environmentOf(res.reply ?? "");
  assert.match(environment, /This message is from the peer agent @scout, not from a person\./);
  assert.doesNotMatch(environment, /This message is from @Alice Human\./);
  assert.doesNotMatch(frameOf(res.reply ?? ""), /live, private 1:1/);

  const session = await app.getSession(res.sessionId!);
  const peerEntry = session!.entries.filter((e) => e.type === "user").at(-1)!;
  assert.equal((peerEntry.payload as { name?: string }).name, "scout");
});

test("a human dm turn keeps mode-conversation and its own sender note", async () => {
  const { app } = freshApp();
  const res = await app.turn(humanTurn("!sysprompt"));
  assert.equal(res.status, "ok", res.reason);
  assert.match(frameOf(res.reply ?? ""), /live, private 1:1 with Alice Human/);
  assert.match(environmentOf(res.reply ?? ""), /This message is from @Alice Human\./);
  assert.doesNotMatch(res.reply ?? "", /peer agent @/);
});

test("an automation turn still lands in mode-fallback with no sender note", async () => {
  const { app } = freshApp();
  const res = await app.turn(humanTurn("!sysprompt", { origin: { kind: "automation" } }));
  assert.equal(res.status, "ok", res.reason);
  assert.doesNotMatch(frameOf(res.reply ?? ""), /live, private 1:1/);
  assert.doesNotMatch(environmentOf(res.reply ?? ""), /This message is from @/);
});

test("a peer turn never creates a session and never crosses into another context", async () => {
  const built = freshApp();
  const unknown = await built.app.turn(peerTurn("hello", { conversation: { kind: "dm", threadRef: "dm:U1:nope" } }));
  assert.equal(unknown.status, "refused");
  assert.match(unknown.reason ?? "", /doesn't exist/);
  assert.equal(await built.sessions.getByThread("dm:U1:nope"), null);

  assert.equal((await built.app.turn(humanTurn("hello"))).status, "ok");
  const mismatched = await built.app.turn(
    peerTurn("hello", { actor: { externalId: "U2" }, conversation: { kind: "dm", threadRef: THREAD } }),
  );
  assert.equal(mismatched.status, "refused");
  assert.match(mismatched.reason ?? "", /different context/);
});

test("a peer turn is refused into a session the execution actor archived, while a human web turn is not", async () => {
  const built = freshApp();
  const seeded = await built.app.turn(humanTurn("hello"));
  assert.equal(seeded.status, "ok");
  await built.sessions.updateParticipantView(seeded.sessionId!, "U1", { archived: true });

  const peer = await built.app.turn(peerTurn("hello again"));
  assert.equal(peer.status, "refused");
  assert.match(peer.reason ?? "", /archived/);

  const complement = freshApp();
  const otherSeeded = await complement.app.turn(humanTurn("hello"));
  await complement.sessions.updateParticipantView(otherSeeded.sessionId!, "U2", { archived: true });
  const other = await complement.app.turn(peerTurn("hello again", { origin: peerOrigin({ messageId: "m-2" }) }));
  assert.equal(other.status, "ok", "another participant's archived view does not stand the peer turn down");
});

test("a peer message steers a live human run with the sender's name and never the recipient's", async () => {
  const built = freshApp();
  const seeded = await built.app.turn(humanTurn("hello"));
  assert.equal(seeded.status, "ok");
  const live = await built.runs.enqueue({
    sessionId: THREAD,
    request: { ...humanTurn("working"), actor: { id: "U1", type: "internal", displayName: "Alice Human" } } as never,
    maxAttempts: 3,
  });

  const res = await built.app.turn(peerTurn("look at this", { async: true }));
  assert.equal(res.status, "queued");
  assert.equal(res.steered, true);
  const signals = await built.signals.takePending(live.run.id);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "scout: look at this");
  assert.equal(signals[0]!.request?.origin?.kind, "peer", "the stored signal keeps the peer origin for replay");
});

test("a peer message is deflected from a live automation run instead of steering it", async () => {
  const built = freshApp();
  const seeded = await built.app.turn(humanTurn("hello"));
  assert.equal(seeded.status, "ok");
  const live = await built.runs.enqueue({
    sessionId: THREAD,
    request: {
      ...humanTurn("working"),
      actor: { id: "U1", type: "internal" },
      origin: { kind: "automation", useOwnerKeychain: true },
    } as never,
    maxAttempts: 3,
  });

  const res = await built.app.turn(peerTurn("look at this", { async: true }));
  assert.equal(res.status, "queued");
  assert.notEqual(res.runId, live.run.id, "peer text must not execute inside the automation run");
  assert.equal(res.steered, undefined);
  assert.deepEqual(await built.signals.takePending(live.run.id), []);
});

test("a human halt still aborts a live automation run", async () => {
  const built = freshApp();
  assert.equal((await built.app.turn(humanTurn("hello"))).status, "ok");
  const live = await built.runs.enqueue({
    sessionId: THREAD,
    request: {
      ...humanTurn("working"),
      actor: { id: "U1", type: "internal" },
      origin: { kind: "automation" },
    } as never,
    maxAttempts: 3,
  });
  const res = await built.app.turn(humanTurn("stop", { origin: { kind: "human" }, async: true }));
  assert.equal(res.status, "queued");
  assert.equal(res.steered, true);
  const signals = await built.signals.takePending(live.run.id);
  assert.equal(signals[0]?.kind, "abort");
});

test("peer text reading like a halt does not abort the recipient's run", async () => {
  const built = freshApp();
  assert.equal((await built.app.turn(humanTurn("hello"))).status, "ok");
  const live = await built.runs.enqueue({
    sessionId: THREAD,
    request: { ...humanTurn("working"), actor: { id: "U1", type: "internal" }, origin: { kind: "human" } } as never,
    maxAttempts: 3,
  });
  const res = await built.app.turn(peerTurn("stop", { async: true }));
  assert.equal(res.status, "queued");
  const signals = await built.signals.takePending(live.run.id);
  assert.equal(signals[0]?.kind, "steer");
  assert.equal(signals[0]?.text, "scout: stop");
});

test("a redelivered peer message runs once and reports the duplicate as silent", async () => {
  const built = freshApp();
  assert.equal((await built.app.turn(humanTurn("hello"))).status, "ok");
  const redeliveryKey = "peer:m-1:recipient";
  const first = await built.app.turn(peerTurn("do the thing", { redeliveryKey, async: true }));
  assert.equal(first.status, "queued");
  const again = await built.app.turn(peerTurn("do the thing", { redeliveryKey, async: true }));
  assert.equal(again.status, "silent", "a repeat dispatch is positive proof the delivery already landed");
  assert.equal((await built.runs.getByDedupKey(redeliveryKey))!.id, first.runId);
});
