import { test } from "node:test";
import assert from "node:assert/strict";
import { ideaThreadRef, isWelcomeConversation, welcomeLayout } from "../src/welcome-session.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const first: CoreSession = {
  id: "first",
  type: "dm",
  scopeId: "personal:alex",
  threadRef: "web:alex:first",
  createdAt: 1,
};
const later = { ...first, id: "later", threadRef: "web:alex:later", createdAt: 2 };

test("welcome remains in the first conversation after saving, reordering, and archiving", () => {
  assert.equal(isWelcomeConversation([], "alex", first.threadRef, null), true);
  assert.equal(isWelcomeConversation([{ ...first, id: "" }], "alex", first.threadRef, null), true);
  assert.equal(
    isWelcomeConversation([later, { ...first, archived: true }], "alex", first.threadRef, first.scopeId),
    true,
  );
  assert.equal(isWelcomeConversation([later, first], "alex", later.threadRef, later.scopeId), false);
  assert.equal(isWelcomeConversation([first], "alex", "web:alex:new", null), false);
});

test("shared, Slack, and other people's conversations do not get the welcome", () => {
  assert.equal(isWelcomeConversation([], "alex", "web:sam:first", null), false);
  assert.equal(isWelcomeConversation([], "alex", first.threadRef, "group:team"), false);
  assert.equal(isWelcomeConversation([], "alex", "slack:first", first.scopeId), false);
  const shared = { ...first, scopeId: "group:team", threadRef: "web:sam:first", createdAt: 0 };
  assert.equal(isWelcomeConversation([shared, first], "alex", first.threadRef, first.scopeId), true);
});

test("ideas chats never show the welcome or take the first welcome slot", () => {
  const ideas = { ...first, threadRef: "web:alex:ideas:12345678-1234-4123-8123-123456789abc", createdAt: 0 };
  assert.equal(isWelcomeConversation([], "alex", ideas.threadRef, null), false);
  assert.equal(isWelcomeConversation([ideas], "alex", first.threadRef, null), true);
  assert.equal(isWelcomeConversation([ideas, first], "alex", first.threadRef, null), true);
});

test("a chat opened from a welcome idea is an ordinary chat without the welcome", () => {
  const idea = { ...first, threadRef: ideaThreadRef("alex"), createdAt: 0 };
  assert.match(idea.threadRef, /^web:alex:idea:[0-9a-f-]{36}$/);
  assert.equal(isWelcomeConversation([], "alex", idea.threadRef, null), false);
  assert.equal(isWelcomeConversation([idea, first], "alex", first.threadRef, null), true);
  const me = { user: "alex", welcome: { company: "StyleUp" } } as unknown as Parameters<typeof welcomeLayout>[0]["me"];
  const view = { me, sessions: [], scopeId: null, isNewUser: true, empty: true, draft: true };
  assert.equal(welcomeLayout({ ...view, threadRef: "web:alex:first" }).show, true);
  const layout = welcomeLayout({ ...view, threadRef: idea.threadRef });
  assert.equal(layout.show, false);
  assert.equal(layout.hideComposer, false);
  const plain = { ...view, me: { user: "alex" } as typeof me };
  assert.equal(welcomeLayout({ ...plain, threadRef: "web:alex:new" }).show, true);
  assert.equal(welcomeLayout({ ...plain, threadRef: idea.threadRef }).show, false);
});
