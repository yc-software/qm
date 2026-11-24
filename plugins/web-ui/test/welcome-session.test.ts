import { test } from "node:test";
import assert from "node:assert/strict";
import { isWelcomeConversation, welcomeLayout, welcomeThreadRef } from "../src/welcome-session.ts";
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

test("everyone gets the welcome on /onboard and in their first chat, seeds or not", () => {
  const me = { user: "alex", org: "acme" };
  const busy = Array.from({ length: 30 }, (_, i) => ({
    ...first,
    id: `shared${i}`,
    scopeId: "channel:C1",
    threadRef: `slack:C1:${i}`,
  }));
  const view = { me, sessions: [...busy, first, later], scopeId: null, saved: false, empty: true, draft: false };
  const onboard = welcomeLayout({ ...view, threadRef: welcomeThreadRef("alex") });
  assert.deepEqual(onboard, { show: true, hideSuggestions: true, hideComposer: false });
  assert.equal(welcomeLayout({ ...view, threadRef: "web:alex:new" }).show, false);
  assert.equal(welcomeLayout({ ...view, threadRef: welcomeThreadRef("alex"), empty: false }).show, false);
  assert.equal(welcomeLayout({ ...view, sessions: busy, threadRef: "web:alex:new" }).show, true);
  assert.equal(welcomeLayout({ ...view, sessions: busy, threadRef: "web:alex:new", saved: true }).show, false);
  const seeds = { activities: [{ id: "a", title: "A", prompt: "A", icon: "yc" }], apps: {} };
  const seeded = welcomeLayout({ ...view, me: { ...me, welcome: seeds }, threadRef: welcomeThreadRef("alex") });
  assert.deepEqual(seeded, { show: true, hideSuggestions: true, hideComposer: true });
  assert.equal(welcomeLayout({ ...view, me: null, threadRef: welcomeThreadRef("alex") }).show, false);
});
