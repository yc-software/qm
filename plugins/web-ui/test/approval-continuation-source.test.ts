import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("approval continuations attach their exact run while sibling cards stay independent", () => {
  assert.match(chat, /const runId = await resolveApproval[\s\S]{0,300}await resumeRun/);
  assert.match(chat, /makeRunResumeStreamFn\(runId, initialRun/);
  assert.match(chat, /!chatState\.resolvingApprovals\.has\(approval\.requestId\)/);
  assert.match(chat, /await active\.waitForIdle\(\);[\s\S]{0,100}await syncPendingApprovals\(active\)/);
  assert.match(chat, /delete .*pendingApprovals;[\s\S]{0,100}attachPendingApprovals/);
  assert.match(composer, /resolvingApprovals\.has\(a\.requestId\)/);
  assert.doesNotMatch(composer, /const busy = ctx\.chat\.state\.resolvingApprovals\.size > 0/);
});
