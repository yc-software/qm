import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turnAtSeq } from "../src/core/turn-resume.ts";
import type { SessionEntry } from "../src/types.ts";

const HARNESSES = ["claude-harness.ts", "codex-harness.ts", "opencode-harness.ts", "pi-harness.ts"];

function source(file: string): string {
  return readFileSync(new URL(`../src/harness/${file}`, import.meta.url), "utf8");
}

test("every harness still flags the mid-turn message it persists", () => {
  for (const file of HARNESSES) {
    assert.match(
      source(file),
      /steered: true/,
      `${file} no longer stamps steered:true — a requeued run will re-answer a turn this harness steered`,
    );
  }
});

test("an unflagged mid-turn message is what breaks the replay, which is why the flag matters", () => {
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
