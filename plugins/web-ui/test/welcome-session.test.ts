import { test } from "node:test";
import assert from "node:assert/strict";
import { isWelcomeConversation } from "../src/welcome-session.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const ALEX = { user: "alex", personalScope: "personal:alex" };

const first: CoreSession = {
  id: "first",
  type: "dm",
  scopeId: "personal:alex",
  threadRef: "web:alex:first",
  createdAt: 1,
};
const later = { ...first, id: "later", threadRef: "web:alex:later", createdAt: 2 };

test("welcome remains in the first conversation after saving, reordering, and archiving", () => {
  assert.equal(isWelcomeConversation([], ALEX, first.threadRef, null), true);
  assert.equal(isWelcomeConversation([{ ...first, id: "" }], ALEX, first.threadRef, null), true);
  assert.equal(
    isWelcomeConversation([later, { ...first, archived: true }], ALEX, first.threadRef, first.scopeId),
    true,
  );
  assert.equal(isWelcomeConversation([later, first], ALEX, later.threadRef, later.scopeId), false);
  assert.equal(isWelcomeConversation([first], ALEX, "web:alex:new", null), false);
});

test("shared, Slack, and other people's conversations do not get the welcome", () => {
  assert.equal(isWelcomeConversation([], ALEX, "web:sam:first", null), false);
  assert.equal(isWelcomeConversation([], ALEX, first.threadRef, "group:team"), false);
  assert.equal(isWelcomeConversation([], ALEX, "slack:first", first.scopeId), false);
  const shared = { ...first, scopeId: "group:team", threadRef: "web:sam:first", createdAt: 0 };
  assert.equal(isWelcomeConversation([shared, first], ALEX, first.threadRef, first.scopeId), true);
});

test("ideas chats never show the welcome or take the first welcome slot", () => {
  const ideas = { ...first, threadRef: "web:alex:ideas:12345678-1234-4123-8123-123456789abc", createdAt: 0 };
  assert.equal(isWelcomeConversation([], ALEX, ideas.threadRef, null), false);
  assert.equal(isWelcomeConversation([ideas], ALEX, first.threadRef, null), true);
  assert.equal(isWelcomeConversation([ideas, first], ALEX, first.threadRef, null), true);
});
