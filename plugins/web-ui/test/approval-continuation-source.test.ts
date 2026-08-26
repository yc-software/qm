import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("approval continuations attach to the visible run while sibling cards stay independent", () => {
  assert.match(chat, /await queueApprovalTurn[\s\S]{0,300}await resumeTrackedRun/);
  assert.match(chat, /!chatState\.resolvingApprovals\.has\(approval\.requestId\)/);
  assert.match(composer, /resolvingApprovals\.has\(a\.requestId\)/);
  assert.doesNotMatch(composer, /const busy = ctx\.chat\.state\.resolvingApprovals\.size > 0/);
});
