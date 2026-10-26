import { test } from "node:test";
import assert from "node:assert/strict";
import { turnAtSeq } from "../src/core/turn-resume.ts";
import { storedItem, type NewItem } from "../src/sessions/items.ts";

test("a steered mid-turn message does not hide the turn's answer", () => {
  const at = (item: NewItem, seq: number) => storedItem(item, { sessionId: "s", seq, createdAt: seq });
  const flagged = [
    at({ kind: "UserMessage", text: "deploy" }, 1),
    at({ kind: "SteeringMessage", text: "also tag it" }, 2),
    at({ kind: "AgentMessage", text: "done" }, 3),
  ];
  const unflagged = [
    at({ kind: "UserMessage", text: "deploy" }, 1),
    at({ kind: "UserMessage", text: "also tag it" }, 2),
    at({ kind: "AgentMessage", text: "done" }, 3),
  ];
  assert.deepEqual(turnAtSeq(flagged, 1)?.answer, { seq: 3, text: "done" });
  assert.equal(turnAtSeq(unflagged, 1)?.answer, undefined, "without the flag the answered turn reads as unanswered");
});
