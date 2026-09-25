import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approvalBlocksComposer, type PendingApproval } from "../src/core-bridge.ts";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("only approvals that block input lock the composer", () => {
  const blocking = { requestId: "a", command: "rm x" } as PendingApproval;
  const explicit = { requestId: "b", command: "rm y", blocksInput: true } as PendingApproval;
  const nonBlocking = { requestId: "c", command: "send it?", blocksInput: false } as PendingApproval;
  assert.equal(approvalBlocksComposer(blocking), true);
  assert.equal(approvalBlocksComposer(explicit), true);
  assert.equal(approvalBlocksComposer(nonBlocking), false);
});

test("hasUnresolvedApproval ignores non-blocking approvals so sending stays possible", () => {
  assert.match(
    chat,
    /function hasUnresolvedApproval\(\): boolean \{\s*return activePendingApprovals\(\)\.some\(approvalBlocksComposer\);/,
  );
});

test("the composer locks input on blocking approvals only, while every approval still renders its card", () => {
  assert.match(composer, /const blockingPauses = approvalPauses\.filter\(approvalBlocksComposer\);/);
  assert.match(
    composer,
    /const inputBlocked = runtimePending \|\| ctx\.chat\.state\.resolvingApprovals\.size > 0 \|\| blockingPauses\.length > 0;/,
  );
  assert.match(composer, /\$\{approvalPauses\.length \? composerApprovalPanel\(approvalPauses\) : nothing\}/);
  assert.match(composer, /\$\{\s*blockingPauses\.length\s*\?\s*nothing\s*:\s*html`\s*<textarea/);
});

test("a send swallowed by a pending approval is restored to the composer with the reason", () => {
  assert.match(
    composer,
    /await agent\.prompt\(userSendMessage\(text, attachments\.length \? attachments : undefined\)\);\s*restoreBlockedSend\(agent, sentFromThread, text, attachments\);/,
  );
  const restore = composer.slice(
    composer.indexOf("function restoreBlockedSend"),
    composer.indexOf("const LARGE_PASTE_CHARS"),
  );
  assert.match(restore, /last\.sendBlocked !== "pending_approval"\) return;/);
  assert.match(restore, /\(agent\.state as \{ errorMessage\?: string \}\)\.errorMessage = undefined;/);
  assert.match(
    restore,
    /composerState\.draft = !typedSince \|\| typedSince === text \? text : `\$\{text\}\\n\$\{composerState\.draft\}`;/,
  );
  assert.match(
    restore,
    /const \{ kept, note \} = mergeStagedAttachments\(attachments, composerState\.attachments\);/,
    "restored files merge under the cap instead of overwriting concurrent edits",
  );
  assert.match(restore, /composerState\.error = combineNote\(last\.errorMessage \|\| PENDING_APPROVAL_REASON, note\);/);
  assert.match(restore, /persistDraft\(\);/);
});

test("a blocked send whose tab moved on still keeps the text as the origin thread's draft", () => {
  const restore = composer.slice(
    composer.indexOf("function restoreBlockedSend"),
    composer.indexOf("const LARGE_PASTE_CHARS"),
  );
  assert.match(
    restore,
    /if \(agent !== ctx\.chat\.state\.agent\) \{\s*if \(sentFromThread\) saveDraft\(sentFromThread, text\);\s*return;\s*\}/,
  );
});
