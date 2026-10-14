import { test } from "node:test";
import assert from "node:assert/strict";
import { turnAtSeq } from "../src/core/turn-resume.ts";
import type { SessionEntry } from "../src/types.ts";

test("a steered mid-turn message does not hide the turn's answer", () => {
  const ent = (type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry => ({
    sessionId: "s",
    seq,
    parentSeq: null,
    type,
    payload,
    scopeLabel: "org:default-org",
    createdAt: seq,
  });
  const flagged = [
    ent("user", { text: "deploy" }, 1),
    ent("user", { text: "also tag it", steered: true }, 2),
    ent("assistant", { text: "done" }, 3),
  ];
  const unflagged = [
    ent("user", { text: "deploy" }, 1),
    ent("user", { text: "also tag it" }, 2),
    ent("assistant", { text: "done" }, 3),
  ];
  assert.deepEqual(turnAtSeq(flagged, 1)?.answer, { seq: 3, text: "done" });
  assert.equal(turnAtSeq(unflagged, 1)?.answer, undefined, "without the flag the answered turn reads as unanswered");
});
