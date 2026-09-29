import assert from "node:assert/strict";
import test from "node:test";
import { requiredResponsesComplete } from "./run.mjs";
import { sha256 } from "./verify.mjs";
import { setup, tick } from "./sidebar-test-support.mjs";
import { nav } from "./sidebar-test-model.mjs";
const path = "/api/session-navigation";
async function pair() {
  const h = setup();
  h.sidebar.surface = "all";
  h.send("/me", { user: "actor" });
  h.request(path, { surface: "web", references: [] }).fail();
  const input = { surface: "all", references: [] };
  h.send(path, nav(h.m, input), input);
  await tick();
  return (await h.observer.finish()).requests.filter((entry) => entry.path === path);
}
const requirements = [
  {
    path,
    method: "POST",
    captureSidebar: true,
    navigation: {},
    allowSupersededAbort: true,
  },
];

test("modeled web-to-all no-response abort is replaced by its completed full refresh", async () => {
  const captured = await pair();
  assert.equal(captured.length, 2);
  assert.equal(captured[0].failure, "net::ERR_ABORTED");
  assert.equal(captured[0].status, undefined);
  assert.equal(captured[1].status, 200);
  assert.equal(requiredResponsesComplete(captured, requirements), true);
  assert.equal(requiredResponsesComplete(captured, [{ ...requirements[0], navigation: { surface: "web" } }]), false);
});

test("surface supersession refuses nearby mismatched identities, roles, phases, chains and response prefixes", async () => {
  const captured = await pair();
  const cases = [
    ["different phase", (_, b) => b.sidebarCapture.generation++],
    ["nonincreasing sequence", (a, b) => (b.sidebarCapture.sequence = a.sidebarCapture.sequence)],
    ["missing capture", (a) => delete a.sidebarCapture],
    [
      "legacy observer",
      (a, b) => {
        delete a.sidebarCapture;
        delete b.sidebarCapture;
      },
    ],
    ["old response status", (a) => (a.status = 200)],
    ["old response timestamp", (a) => (a.responseAt = 1)],
    ["old body bytes", (a) => (a.responseBodyBytes = 1)],
    ["old body digest", (a) => (a.responseBodySha256 = "a".repeat(64))],
    ["old projection", (a) => (a.sidebarProjection = {})],
    ["new pending", (_, b) => (b.completed = false)],
    ["new partial phase", (_, b) => (b.phase = "response")],
    ["new error", (_, b) => (b.envelopeError = "bad body")],
    ["new failure", (_, b) => (b.failure = "net::ERR_ABORTED")],
    ["new non-200", (_, b) => (b.status = 204)],
    ["missing new projection", (_, b) => delete b.sidebarProjection],
    ["foreign origin", (_, b) => (b.origin = "https://other.invalid")],
    ["section changed", (_, b) => (b.navigation.section = "archived")],
    [
      "archived to recent",
      (a, b) => {
        a.navigation.section = "archived";
        b.navigation.section = "recent";
      },
    ],
    ["reference set changed", (_, b) => (b.navigation.references = [{ kind: "id", valueSha256: "a".repeat(64) }])],
    ["reference presence changed", (_, b) => (b.sidebarCapture.referencesPresent = false)],
    [
      "section-only",
      (a, b) => {
        a.sidebarCapture.role = "navigation-section";
        b.sidebarCapture.role = "navigation-section";
      },
    ],
    [
      "resolve",
      (a, b) => {
        a.path = "/api/session-navigation/resolve";
        b.path = a.path;
      },
    ],
    [
      "page",
      (a, b) => {
        a.path = "/api/session-navigation/page";
        b.path = a.path;
      },
    ],
    [
      "cursor",
      (a, b) => {
        a.navigation.cursorSha256 = "a".repeat(64);
        b.navigation.cursorSha256 = "a".repeat(64);
        a.sidebarCapture.cursorSha256 = "a".repeat(64);
        b.sidebarCapture.cursorSha256 = "a".repeat(64);
      },
    ],
    ["chain missing", (_, b) => b.sidebarCapture.chains.pop()],
    ["chain key changed", (_, b) => (b.sidebarCapture.chains[0].keySha256 = "a".repeat(64))],
    ["old chain reused", (_, b) => (b.sidebarCapture.chains[0].chainSequence = 1)],
    ["old chain wrong", (a) => (a.sidebarCapture.chains[0].keySha256 = "a".repeat(64))],
    [
      "reverse surface",
      (a, b) => {
        a.navigation.surface = "all";
        b.navigation.surface = "web";
      },
    ],
  ];
  for (const [name, change] of cases) {
    const [a, b] = structuredClone(captured);
    change(a, b);
    assert.equal(requiredResponsesComplete([a, b], requirements), false, name);
  }
});

test("archived full refresh may change only web to all with its own four fresh chains", async () => {
  const captured = await pair();
  const [a, b] = structuredClone(captured);
  a.navigation.section = "archived";
  b.navigation.section = "archived";
  assert.equal(requiredResponsesComplete([a, b], requirements), true);
});

test("actual observer becomes ready only after completed later full refresh, and finish preserves it", async () => {
  const h = setup();
  h.sidebar.surface = "all";
  h.send("/me", { user: "actor" });
  const old = h.request(path, { surface: "web", references: [] });
  old.fail();
  const input = { surface: "all", references: [] },
    next = h.request(path, input);
  await tick();
  assert.equal(h.observer.sidebarSnapshot().capture.ready, false);
  next.respond(nav(h.m, input));
  await tick();
  assert.equal(h.observer.sidebarSnapshot().capture.ready, false);
  next.finish();
  await h.observer.waitResponses(1000, requirements);
  await tick();
  const state = h.observer.sidebarSnapshot().capture;
  assert.equal(state.ready, true);
  assert.deepEqual(state.errors, []);
  const final = await h.observer.finish();
  assert.deepEqual(final.errors, []);
  assert.deepEqual(h.observer.sidebarSnapshot().capture, state);
});

test("unchanged same-intent retry and cursor ownership remain constrained", async () => {
  const captured = await pair();
  const [a, b] = structuredClone(captured);
  a.navigation = structuredClone(b.navigation);
  a.sidebarCapture.chains = b.sidebarCapture.chains.map((c) => ({
    ...c,
    chainSequence: a.sidebarCapture.sequence,
  }));
  assert.equal(requiredResponsesComplete([a, b], requirements), true);
  const token = sha256("cursor");
  a.navigation.cursorSha256 = token;
  b.navigation.cursorSha256 = token;
  a.sidebarCapture.cursorSha256 = token;
  b.sidebarCapture.cursorSha256 = token;
  assert.equal(requiredResponsesComplete([a, b], requirements), false);
});
