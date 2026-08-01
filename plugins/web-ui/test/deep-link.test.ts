import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLinkPath, parseDeepLink, sessionLink } from "../src/deep-link.ts";

test("chats view with an active session is addressed by /?session=", () => {
  assert.equal(deepLinkPath("", "chats", "abc-123"), "/?session=abc-123");
});

test("chats view with no session yields the bare root", () => {
  assert.equal(deepLinkPath("", "chats", null), "/");
});

test("non-chat views are path-addressed regardless of any session", () => {
  assert.equal(deepLinkPath("", "crons", null), "/crons");
  assert.equal(deepLinkPath("", "files", "abc"), "/files");
  assert.equal(deepLinkPath("", "keychain", null), "/keychain");
});

test("the contexts view carries its open scope", () => {
  assert.equal(deepLinkPath("", "contexts", null, "channel:C1"), "/contexts?scope=channel%3AC1");
});

test("a non-root base is prefixed, with or without its trailing slash", () => {
  assert.equal(deepLinkPath("/web-ui/", "crons", null), "/web-ui/crons");
  assert.equal(deepLinkPath("/web-ui", "chats", "s1"), "/web-ui/?session=s1");
});

test("session ids are URI-encoded", () => {
  assert.equal(deepLinkPath("", "chats", "a b&c"), "/?session=a%20b%26c");
});

test("parseDeepLink reads the view from the path", () => {
  assert.deepEqual(parseDeepLink("", "/crons", ""), { view: "crons", session: null, item: null });
  assert.deepEqual(parseDeepLink("/web-ui/", "/web-ui/crons", ""), { view: "crons", session: null, item: null });
  assert.deepEqual(parseDeepLink("", "/", "?session=s1"), { view: null, session: "s1", item: null });
});

test("project paths open the contexts view with a resolvable project identifier", () => {
  assert.deepEqual(parseDeepLink("", "/projects/atlas", ""), {
    view: "contexts",
    session: null,
    item: "atlas",
  });
  assert.deepEqual(parseDeepLink("/web-ui/", "/web-ui/projects/channel/C0123", ""), {
    view: "contexts",
    session: null,
    item: "channel:C0123",
  });
  assert.deepEqual(parseDeepLink("", "/projects/group/G9ABC", ""), {
    view: "contexts",
    session: null,
    item: "group:G9ABC",
  });
});

test("parseDeepLink degrades a malformed percent-escape to no view instead of throwing", () => {
  assert.deepEqual(parseDeepLink("", "/%E0%A4%A", ""), { view: null, session: null, item: null });
});

test("parseDeepLink still honors legacy ?view= links", () => {
  assert.deepEqual(parseDeepLink("", "/", "?view=crons"), { view: "crons", session: null, item: null });
  assert.deepEqual(parseDeepLink("/web-ui/", "/web-ui/", "?view=contexts&scope=channel:C1"), {
    view: "contexts",
    session: null,
    item: null,
  });
});

test("legacy connectors links resolve to the keychain view", () => {
  assert.deepEqual(parseDeepLink("", "/connectors", ""), { view: "keychain", session: null, item: null });
  assert.deepEqual(parseDeepLink("", "/", "?view=connectors"), { view: "keychain", session: null, item: null });
});

test("a cron is addressed by /crons/<id>", () => {
  assert.equal(deepLinkPath("", "crons", null, null, "abc 1"), "/crons/abc%201");
  assert.deepEqual(parseDeepLink("", "/crons/abc%201", ""), { view: "crons", session: null, item: "abc 1" });
  assert.deepEqual(parseDeepLink("/web-ui/", "/web-ui/crons/c1", ""), {
    view: "crons",
    session: null,
    item: "c1",
  });
});

test("an item id is rejected for views that are not addressed that way", () => {
  assert.throws(() => deepLinkPath("", "chats", "s1", null, "x"));
  assert.throws(() => deepLinkPath("", "contexts", null, "channel:C1", "x"));
});

test("only the first two path segments are addressed", () => {
  assert.deepEqual(parseDeepLink("", "/crons/a/b", ""), { view: "crons", session: null, item: "a" });
});

test("sessionLink builds an absolute link under the serving base", () => {
  assert.equal(sessionLink("https://portal.example", "/web-ui/", "s1"), "https://portal.example/web-ui/?session=s1");
  assert.equal(sessionLink("http://localhost:8096", "", "s1"), "http://localhost:8096/?session=s1");
});
