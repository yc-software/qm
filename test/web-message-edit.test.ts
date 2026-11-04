import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { holdThread } from "./support/live-run.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import { messageRevision, renderMessageRevision } from "../src/slack/message-revisions.ts";
import type { TurnRequest } from "../src/types.ts";

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "web-edit-")) }));
}

function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef: thread }, text };
}

async function firstUserSeq(built: ReturnType<typeof freshApp>, sessionId: string): Promise<number> {
  const items = await built.sessions.getItems(sessionId);
  return items.find((e) => e.kind === "UserMessage")!.seq;
}

test("the author edits their web message; the model sees the edit and the original stays in history", async () => {
  const built = freshApp();
  const { sessionId } = await built.app.turn(dm("Summarize the Q3 deck", "web:U1:e1"));
  const seq = await firstUserSeq(built, sessionId!);

  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", seq, "Summarize the Q4 deck"), {
    edited: true,
  });
  const items = await built.sessions.getItems(sessionId!);
  const original = items.find((e) => e.seq === seq)!;
  assert.equal(original.text, "Summarize the Q3 deck", "the original item is kept, not rewritten");
  const revision = messageRevision(items.at(-1)!);
  assert.deepEqual(
    { ...revision, sentAt: undefined },
    { action: "edited", seq, sentAt: undefined, original: "Summarize the Q3 deck", text: "Summarize the Q4 deck" },
  );
  assert.equal(revision?.sentAt, new Date(original.createdAt).toISOString());
  assert.match(
    JSON.stringify(reconstructMessagesFromHistory(items)),
    /message-edited sent-at=\\"[^"\\]+\\" original=\\"Summarize the Q3 deck\\">Summarize the Q4 deck</,
  );

  assert.deepEqual(
    await built.app.editSessionMessage(sessionId!, "U1", seq, "Summarize the Q4 deck"),
    { edited: true },
    "saving unchanged text is a no-op success",
  );
  assert.equal((await built.sessions.getItems(sessionId!)).length, items.length, "no duplicate revision");
});

test("only the author may edit, only user messages, never empty, and not while a reply is running", async () => {
  const built = freshApp();
  const { sessionId } = await built.app.turn(dm("hello there", "web:U1:e2"));
  const seq = await firstUserSeq(built, sessionId!);
  const reply = (await built.sessions.getItems(sessionId!)).find((e) => e.kind === "AgentMessage")!;

  assert.equal(await built.app.editSessionMessage(sessionId!, "U2", seq, "x"), null, "a stranger cannot see it");
  await built.sessions.addParticipant(sessionId!, "U2");
  assert.equal(
    await built.app.editSessionMessage(sessionId!, "U2", seq, "x"),
    null,
    "a participant without write access to the owner's personal scope cannot edit",
  );
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", reply.seq, "x"), {
    edited: false,
    reason: "not_editable",
  });
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", seq, "  "), {
    edited: false,
    reason: "empty_text",
  });

  const release = await holdThread(built.runs, "web:U1:e2");
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", seq, "hello again"), {
    edited: false,
    reason: "busy",
  });
  await release();
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", seq, "hello again"), { edited: true });
});

test("messages in Slack-backed conversations are edited in Slack, not here", async () => {
  const built = freshApp();
  const { sessionId } = await built.app.turn(dm("hi from slack", "slack:D1:1.0"));
  const seq = await firstUserSeq(built, sessionId!);
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", seq, "edited"), {
    edited: false,
    reason: "not_editable",
  });
});

test("a fork re-points web edits at the copied message", async () => {
  const built = freshApp();
  const first = await built.app.turn(dm("first", "web:U1:e3"));
  // A duplicate reply receipt stays out of the fork, so the fork's seqs shift and the remap is observable.
  await built.sessions.appendMany({ sessionId: first.sessionId! }, [
    { kind: "UserMessage", text: "posted", externalId: "1.1", body: {} },
    { kind: "UserMessage", text: "posted", externalId: "1.1", body: { slackReplyReceipt: true } },
  ]);
  const { sessionId } = await built.app.turn(dm("second", "web:U1:e3"));
  const items = await built.sessions.getItems(sessionId!);
  const second = items.find((e) => e.kind === "UserMessage" && e.text === "second")!;
  assert.deepEqual(await built.app.editSessionMessage(sessionId!, "U1", second.seq, "second, edited"), {
    edited: true,
  });
  const fork = await built.app.forkSession(sessionId!, "U1");
  assert.ok(fork);
  const forkItems = await built.sessions.getItems(fork.session.id);
  const edit = forkItems.map(messageRevision).find(Boolean)!;
  const target = forkItems.find((e) => e.seq === edit.seq)!;
  assert.equal(target.kind, "UserMessage");
  assert.equal(target.text, "second");
  assert.notEqual(edit.seq, second.seq, "the fork renumbered the message");
});

test("Slack revisions render as before", () => {
  assert.equal(
    renderMessageRevision({ action: "edited", ts: "1700000000.000100", text: "new", name: "Alex" }),
    '<message-edited id="1700000000.000100" author="Alex" sent-at="2023-11-14T22:13:20.000Z">new</message-edited>',
  );
});
