import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalNote, refusalDelivery, postThenAckRunDelivery, isBoundaryRefusal } from "../src/slack/lib.ts";
import { SESSION_BUSY_USER_TEXT } from "../src/core/failure-copy.ts";

const ADMIN_URL = "https://portal.example.com/admin/?view=history&session=s-1";

test("refusalNote: a failure renders the core-supplied admin link and drops the misleading DM/internal steer", () => {
  const note = refusalNote({ reason: "An unknown error occurred", adminUrl: ADMIN_URL }, "channel");
  assert.match(note, /An unknown error occurred/);
  assert.match(note, /Full error: https:\/\/portal\.example\.com\/admin\/\?view=history&session=s-1/);
  assert.doesNotMatch(note, /fully-internal/, "a turn error is not a boundary refusal — no internal-channel advice");
});

test("refusalNote: a boundary (internal-only) refusal keeps the DM/internal steer and never links", () => {
  const note = refusalNote(
    { reason: "internal-only: shared audience includes a non-internal participant", adminUrl: ADMIN_URL },
    "channel",
  );
  assert.match(note, /fully-internal channel/);
  assert.doesNotMatch(note, /Full error/, "boundary refusals have nothing to debug in admin");
});

test("refusalNote: no adminUrl ⇒ reason only, no dangling link", () => {
  const note = refusalNote({ reason: "approval denied for git push" }, "dm");
  assert.match(note, /approval denied for git push/);
  assert.doesNotMatch(note, /Full error/);
});

test("refusalNote: a busy session reads as a human note, with no error framing and no link", () => {
  const note = refusalNote(
    { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_USER_TEXT, adminUrl: ADMIN_URL },
    "channel",
  );
  assert.equal(note, SESSION_BUSY_USER_TEXT);
  assert.doesNotMatch(note, /session busy/);
  assert.doesNotMatch(note, /error/i);
});

test("refusalNote: a failed turn hides the internal reason but keeps the admin link", () => {
  const note = refusalNote(
    { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42", adminUrl: ADMIN_URL },
    "dm",
  );
  assert.doesNotMatch(note, /TypeError|sandbox\.ts/);
  assert.match(note, /something went wrong on my end/);
  assert.match(note, /Full error: https:/);
});

test("refusalNote: a security quarantine is human-safe and hides the internal reason", () => {
  const note = refusalNote(
    {
      refusalKind: "security_quarantine",
      reason: "Auto quarantined suspicious or unscreenable external input before the agent ran.",
      adminUrl: ADMIN_URL,
    },
    "channel",
  );

  assert.equal(
    note,
    "I couldn't act because my security screen flagged part of this message or its conversation context. Please retry without the flagged context, or ask an admin to review the quarantine.",
  );
  assert.doesNotMatch(note, /Auto quarantined|unscreenable|Full error/);
});

test("refusalDelivery: quarantine posts in-thread only when addressed; every unprompted refusal stays silent", () => {
  assert.equal(refusalDelivery({ refusalKind: "security_quarantine" }, false), "thread");
  assert.equal(refusalDelivery({ refusalKind: "security_quarantine" }, true), "silent");
  assert.equal(refusalDelivery({}, true), "silent");
  assert.equal(refusalDelivery({}, false), "requester");
});

test("postThenAckRunDelivery: acknowledges only after the Slack post succeeds", async () => {
  const calls: string[] = [];
  let finishPost!: () => void;
  const posting = postThenAckRunDelivery({
    post: () =>
      new Promise<void>((resolve) => {
        calls.push("post");
        finishPost = resolve;
      }),
    ack: () => calls.push("ack"),
    release: () => calls.push("release"),
  });

  assert.deepEqual(calls, ["post"]);
  finishPost();
  await posting;
  assert.deepEqual(calls, ["post", "ack"]);
});

test("postThenAckRunDelivery: releases recovery when the Slack post fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    postThenAckRunDelivery({
      post: async () => {
        calls.push("post");
        throw new Error("Slack unavailable");
      },
      ack: () => calls.push("ack"),
      release: () => calls.push("release"),
    }),
    /Slack unavailable/,
  );
  assert.deepEqual(calls, ["post", "release"]);
});

test("isBoundaryRefusal: only internal-only reasons are boundary refusals", () => {
  assert.ok(isBoundaryRefusal("internal-only: non-internal principals cannot interact"));
  assert.equal(isBoundaryRefusal("An unknown error occurred"), false);
  assert.equal(isBoundaryRefusal(undefined), false);
});
