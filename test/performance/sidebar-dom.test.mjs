import assert from "node:assert/strict";
import test from "node:test";
import { validateSidebarDom } from "./verify.mjs";
import { setup, tick } from "./sidebar-test-support.mjs";
import { nav, page as pageOf } from "./sidebar-test-model.mjs";

const fakePage = (inspect = () => {}) => ({
  async waitForFunction(_fn, expected) {
    await inspect(expected);
    return {
      jsonValue: async () =>
        Object.fromEntries(
          ["recent", "pinned", "archived", "groups", "top"].map((key) => [key, structuredClone(expected[key])]),
        ),
      dispose: async () => {},
    };
  },
});
const wait = (s, inspect, options) => s.observer.waitSidebar(fakePage(inspect), { timeoutMs: 1000, ...options });
const first = async (s, input = { surface: "web", references: [] }) => {
  s.send("/me", { user: "actor" });
  s.send("/api/session-navigation", nav(s.m, input), input);
  await tick();
};
const scopePage = (m, input) => {
  const rows = m.rows.filter(
    (r) =>
      r.scopeId === input.scopeId &&
      !r.parentSessionId &&
      !r.archived &&
      !r.pinned &&
      (input.surface !== "web" || m.formatter.isWeb(r)),
  );
  const key = JSON.stringify([input.surface ?? "all", null, input.scopeId, "", null, false, null, false, false, null]);
  return {
    ...pageOf(rows, key, input.cursor),
    contexts: m.contexts.filter((c) => c.scopeId === input.scopeId),
    statusTotals: nav(m).statusTotals,
  };
};

test("initial bounded DOM sources name exact applied pages and retained references", async () => {
  const s = setup();
  const input = { surface: "web", references: [{ kind: "id", value: "web-114" }] };
  await first(s, input);
  const proof = await wait(
    s,
    (e) => {
      assert.equal(e.pinned.length, 50);
      assert.equal(e.groups.length, 50);
      assert.equal(e.recent.length, 51);
      assert.ok(e.recent.some((r) => r.id === "web-114"));
      assert.equal(e.more.recent, true);
    },
    { retainedIds: ["web-114"] },
  );
  const result = await s.observer.finish();
  const entry = result.requests.find((r) => r.sidebarProjection);
  assert.equal(proof.sectionSources.recent[0].projectionSha256, entry.sidebarProjection.projectionSha256);
  assert.equal(proof.referenceSources[0].sequence, entry.sidebarCapture.sequence);
  assert.equal(proof.qualified, false);
  assert.ok(proof.missing.length);
  assert.ok(!JSON.stringify(proof).includes("Title web"));
});

test("section continuation applies only its owned section and retains current first-page sources", async () => {
  const s = setup();
  await first(s);
  const response = nav(s.m);
  const input = { surface: "web", section: "recent", cursor: response.recent.nextCursor };
  s.send("/api/session-navigation", nav(s.m, input), input);
  await tick();
  const proof = await wait(
    s,
    (e) => {
      assert.equal(e.loaded.recent, 100);
      assert.equal(e.loaded.pinned, 50);
      assert.equal(e.loaded.groups, 50);
    },
    { limit: 100 },
  );
  assert.equal(proof.sectionSources.recent.length, 2);
  assert.equal(proof.sectionSources.pinned.length, 1);
  assert.equal(proof.referenceSources.length, 0);
  const result = await s.observer.finish();
  const selection = { ...s.sidebar, finishedAt: Date.now() };
  validateSidebarDom(proof, result.requests, selection);
  for (const mutate of [
    (value) => value.sectionSources.recent.pop(),
    (value) => value.sectionSources.recent.shift(),
    (value) => value.sectionSources.recent.reverse(),
    (value) => value.sectionSources.recent.push(value.sectionSources.recent[0]),
    (value) => (value.dom.loaded.recent = 0),
    (value) => (value.dom.loaded.recent = 101),
    (value) => (value.dom.recent.count = 1000000),
    (value) => value.dom.totals.recent++,
    (value) => (value.dom.more.recent = false),
    (value) => value.missing.push("Unsupported added reason"),
  ]) {
    const changed = structuredClone(proof);
    mutate(changed);
    assert.throws(() => validateSidebarDom(changed, result.requests, selection));
  }
});

test("all final surface cannot settle on intermediate web and refresh suppresses the old chain", async () => {
  const s = setup();
  s.sidebar.surface = "all";
  await first(s);
  let settled = false;
  const pending = wait(s, (e) => {
    assert.ok(e.recent.some((r) => r.id === "slack"));
  }).then((p) => {
    settled = true;
    return p;
  });
  await tick();
  assert.equal(settled, false);
  const input = { surface: "all", references: [{ kind: "id", value: "slack" }] };
  s.send("/api/session-navigation", nav(s.m, input), input);
  await tick();
  const proof = await pending;
  assert.equal(proof.surface, "all");
  assert.equal(proof.sectionSources.recent.length, 1);
  await s.observer.finish();
});

test("full refresh clears older scoped group-page application while section reads do not", async () => {
  const s = setup();
  await first(s);
  const input = { surface: "web", scopeId: "project:061", archived: false, pinned: false };
  s.send("/api/session-navigation/page", scopePage(s.m, input), input);
  await tick();
  const before = await wait(s);
  assert.equal(before.groupPageSources.length, 1);
  const pins = { surface: "web", section: "pinned", cursor: nav(s.m).pinned.nextCursor };
  s.send("/api/session-navigation", nav(s.m, pins), pins);
  await tick();
  assert.equal((await wait(s)).groupPageSources.length, 1);
  await first(s);
  assert.equal((await wait(s)).groupPageSources.length, 0);
  await s.observer.finish();
});

test("archived full refresh and archived section application are distinct", async () => {
  const s = setup();
  await first(s);
  const archive = { surface: "web", section: "archived" };
  s.send("/api/session-navigation", nav(s.m, archive), archive);
  await tick();
  const proof = await wait(
    s,
    (e) => {
      assert.equal(e.archived.length, 50);
      assert.equal(e.more.archived, true);
    },
    { archived: true },
  );
  assert.equal(proof.sectionSources.archived[0].role, "navigation-section");
  assert.equal(proof.sectionSources.recent[0].sequence, 2);
  const full = { surface: "web", section: "archived", references: [] };
  s.send("/api/session-navigation", nav(s.m, full), full);
  await tick();
  const newer = await wait(s, undefined, { archived: true });
  assert.equal(newer.sectionSources.archived[0].role, "navigation-refresh");
  assert.equal(newer.sectionSources.archived[0].sequence, newer.sectionSources.recent[0].sequence);
  await s.observer.finish();
});

test("reset drops current DOM state and explicit preparation reuse preserves captured sources", async () => {
  const s = setup();
  await first(s);
  const initial = await wait(s);
  await s.observer.finish();
  s.observer.start(s.requirements, { reuseIdentity: true });
  const reused = await wait(s);
  assert.deepEqual(reused.sectionSources, initial.sectionSources);
  await s.observer.finish();
  s.observer.start();
  await assert.rejects(s.observer.waitSidebar(fakePage(), { timeoutMs: 30 }), /did not settle/);
  await s.observer.finish();
});

test("DOM comparison cannot return an obsolete version when a refresh starts during the browser check", async () => {
  const s = setup();
  await first(s);
  let request;
  let checks = 0;
  let done = false;
  const pending = wait(s, () => {
    if (checks++ === 0) request = s.request("/api/session-navigation", { surface: "web", references: [] });
  }).then((p) => {
    done = true;
    return p;
  });
  await tick();
  await tick();
  assert.equal(done, false);
  request.respond(nav(s.m, { surface: "web", references: [] }));
  request.finish();
  await tick();
  const proof = await pending;
  assert.ok(checks >= 2);
  assert.equal(proof.sectionSources.recent[0].sequence, 3);
  await s.observer.finish();
});

test("legacy DOM uses actual current contexts and retains the two temporal source descriptors", async () => {
  const s = setup("legacy-get");
  s.send("/me", { user: "actor" });
  s.send("/api/contexts", { contexts: s.m.contexts });
  s.send("/api/sessions", { sessions: s.m.rows });
  await tick();
  const proof = await wait(s, (e) => {
    assert.equal(e.pinned.length, 55);
    assert.equal(e.recent.length, 50);
    assert.equal(e.more.groups, false);
  });
  assert.ok(proof.contextSource);
  assert.match(proof.legacyProjectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.sectionSources.recent.length, 1);
  const again = { contexts: structuredClone(s.m.contexts) };
  s.send("/api/contexts", again);
  await tick();
  const next = await wait(s);
  assert.notEqual(next.contextSource.sequence, proof.contextSource.sequence);
  assert.equal(next.sectionSources.recent[0].sequence, proof.sectionSources.recent[0].sequence);
  await s.observer.finish();
});

test("unobserved mutable retained row is refused rather than filled from allowed-reference metadata", async () => {
  const s = setup();
  await first(s);
  await assert.rejects(wait(s, undefined, { retainedIds: ["unwritten"] }), /Unobserved retained/);
  await s.observer.finish();
});

test("observed resolver values update page entities without changing page membership", async () => {
  const s = setup();
  s.sidebar.surface = "all";
  await first(s, { surface: "all", references: [] });
  const input = { references: [{ kind: "id", value: "slack" }] };
  const changed = { ...s.m.rows.find((r) => r.id === "slack"), title: "Exact later written title" };
  s.send(
    "/api/session-navigation/resolve",
    { references: [{ reference: input.references[0], session: changed }] },
    input,
  );
  await tick();
  const proof = await wait(s, (e) =>
    assert.equal(e.recent.find((r) => r.id === "slack").title, "Exact later written title"),
  );
  assert.equal(proof.sectionSources.recent.length, 1);
  assert.equal(proof.referenceSources.at(-1).role, "resolve");
  await s.observer.finish();
});

test("observed scoped-page values update existing entities and retain their separate source", async () => {
  const s = setup();
  s.sidebar.surface = "all";
  await first(s, { surface: "all", references: [] });
  s.m.rows.find((r) => r.id === "slack").title = "Exact page title";
  const input = { surface: "all", scopeId: "personal:actor", archived: false, pinned: false };
  s.send("/api/session-navigation/page", scopePage(s.m, input), input);
  await tick();
  const proof = await wait(s, (e) => assert.equal(e.recent.find((r) => r.id === "slack").title, "Exact page title"));
  assert.equal(proof.entitySources.length, 1);
  assert.equal(proof.sectionSources.recent.length, 1);
  await s.observer.finish();
});

test("missing or different observed viewer cannot satisfy dynamic DOM readiness", async () => {
  const s = setup();
  const input = { surface: "web", references: [] };
  s.send("/api/session-navigation", nav(s.m, input), input);
  await tick();
  await assert.rejects(s.observer.waitSidebar(fakePage(), { timeoutMs: 30 }), /did not settle/);
  s.send("/me", { user: "different-viewer" });
  await tick();
  await assert.rejects(wait(s), /Sidebar viewer differs/);
  await s.observer.finish();
});

test("failed body and unsupported status selectors never become DOM-ready", async () => {
  for (const input of [
    { surface: "web", references: [] },
    { surface: "web", status: "active" },
  ]) {
    const s = setup();
    s.send("/me", { user: "actor" });
    if (input.status)
      s.send(
        "/api/session-navigation/page",
        { items: [], total: 0, nextCursor: null, contexts: [], statusTotals: nav(s.m).statusTotals },
        input,
      );
    else s.send("/api/session-navigation", { error: "denied" }, input, { status: 403 });
    await tick();
    await assert.rejects(wait(s), /Sidebar readiness observed a request error/);
    await s.observer.finish();
  }
});

test("post-finish capture preserves phase identity and detects a later body or incomplete request", async () => {
  const s = setup();
  await first(s);
  const proof = await wait(s);
  await s.observer.finish();
  const stable = s.observer.sidebarSnapshot().capture;
  assert.deepEqual(stable, { generation: proof.generation, version: proof.version, ready: true, errors: [] });
  s.observer.start(s.requirements, { reuseIdentity: true });
  const next = await wait(s);
  const input = { surface: "web", references: [] };
  const pending = s.request("/api/session-navigation", input);
  assert.equal(s.observer.sidebarSnapshot().capture.ready, false);
  pending.respond(nav(s.m, input));
  pending.finish();
  await s.observer.finish();
  const changed = s.observer.sidebarSnapshot().capture;
  assert.equal(changed.generation, next.generation);
  assert.notEqual(changed.version, next.version);
  assert.equal(changed.ready, true);
});

test("a valid late old-chain body is retained as evidence without replacing current DOM values", async () => {
  const s = setup();
  s.sidebar.surface = "all";
  await first(s, { surface: "all", references: [] });
  const prior = nav(s.m, { surface: "all", references: [] });
  const input = { surface: "all", section: "recent", cursor: prior.recent.nextCursor };
  const old = s.request("/api/session-navigation", input);
  const oldData = nav(s.m, input);
  s.m.rows.find((r) => r.id === "slack").title = "New refresh title";
  await first(s, { surface: "all", references: [] });
  old.respond(oldData);
  old.finish();
  await tick();
  const proof = await wait(s, (e) => assert.equal(e.recent.find((r) => r.id === "slack").title, "New refresh title"));
  const result = await s.observer.finish();
  assert.deepEqual(result.errors, []);
  assert.equal(result.requests.filter((r) => r.sidebarProjection).length, 3);
  assert.equal(proof.sectionSources.recent.length, 1);
  assert.equal(proof.sectionSources.recent[0].sequence, 5);
});
