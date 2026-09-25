import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("failed sends render Retry on the optimistic user message", () => {
  const userBranch = source.slice(source.indexOf('if (role === "user"'), source.indexOf('if (role === "assistant"'));
  assert.match(userBranch, /sendFailure/);
  assert.match(userBranch, /retryFailedSend\(message, index\)/);
  assert.match(userBranch, /Retry\s*<\/button>/);
});

test("the synthetic retryable assistant error stays out of the transcript", () => {
  const assistantBranch = source.slice(
    source.indexOf('if (role === "assistant"'),
    source.indexOf("function messageMeta"),
  );
  assert.match(assistantBranch, /if \(\(msg as AssistantWork\)\.retryableSend\) return nothing/);
  assert.doesNotMatch(assistantBranch, /retryFailedSend/);
});

test("retry clears the user failure and removes only its synthetic assistant error", () => {
  const retry = source.slice(
    source.indexOf("async function retryFailedSend"),
    source.indexOf("function visibleMessages"),
  );
  assert.match(retry, /delete .*sendFailure/);
  assert.match(retry, /current !== index \+ 1/);
  assert.match(retry, /await agent\.continue\(\)/);
  assert.doesNotMatch(retry, /agent\.prompt/);
});
