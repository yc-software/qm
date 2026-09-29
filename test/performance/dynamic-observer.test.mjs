import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observe, requiredResponsesComplete, validateSidebarEvidence } from "./run.mjs";
import { sha256 } from "./verify.mjs";

function model(transport = "navigation-post") {
  const row = {
    id: "known",
    scopeId: "personal:actor",
    threadRef: "web:actor:known",
    type: "dm",
    createdAt: 10,
    lastActivityAt: 100,
    title: "Known chat",
  };
  const compact = {
    ...row,
    at: 100,
    title: "Known chat",
    groupedTitle: "Known chat",
    legacyRank: 0,
    parentSessionId: null,
    channelName: null,
    surface: "web",
    pinned: false,
    archived: false,
  };
  delete compact.lastActivityAt;
  const identity = { scopeId: row.scopeId, kind: "personal", name: null, project: null };
  const context = { scopeId: row.scopeId, kind: "personal", name: null, sessionCount: 1, lastActivityAt: 100 };
  const evidence = Object.fromEntries(
    [
      ["me", "/me"],
      ["sessions", "/api/sessions"],
      ["contexts", "/api/contexts"],
    ].map(([key, path]) => [key, { path, principalId: "actor", status: 200, sha256: sha256(path) }]),
  );
  const startup = { hasSessions: true, hasNonCronSessions: true, oldestPersonalThreadRef: row.threadRef };
  const sidebar = {
    profile: { sourceRevision: "a".repeat(40), transport },
    principalId: "actor",
    surface: "web",
    commonActor: { evidence, preparedWeb: [compact], preparedOffPageWeb: [], contexts: [identity], startup },
    dynamicActor: {
      evidence,
      preparedNonWeb: [],
      allowedOffPageRows: [],
      contexts: [{ ...identity, fallbackActivity: 100 }],
      recurring: [],
      scopePolicy: [{ scopeId: row.scopeId, mode: "static-disjoint", writeEvidence: [] }],
    },
    retention: { identities: new Map(), bytes: 0 },
  };
  const page = (items) => ({ items, total: items.length, nextCursor: null });
  const navigation = {
    recent: page([row]),
    pinned: page([]),
    groups: page([{ scopeId: row.scopeId, kind: "personal", name: "Personal", count: 1, lastActivityAt: 100 }]),
    archivedCount: 0,
    contexts: [context],
    statusTotals: { active: 1, waiting: 0, archived: 0 },
    references: [],
    startup: { ...startup, latest: row },
  };
  return { sidebar, navigation, sessions: { sessions: [row] }, contexts: { contexts: [context] } };
}

function harness(transport) {
  const value = model(transport);
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:9876";
  const requirements =
    transport === "legacy-get"
      ? ["/api/sessions", "/api/contexts"].map((path) => ({ path, captureSidebar: true }))
      : [{ path: "/api/session-navigation", method: "POST", captureNavigation: true, captureSidebar: true }];
  const observer = observe(page, origin, requirements, value.sidebar);
  observer.start();
  const send = (path, data, { body, raw, responseBody, status = 200, sameOrigin = true } = {}) => {
    const buffer = raw ?? Buffer.from(JSON.stringify(data));
    let reads = 0;
    const request = {
      url: () => (sameOrigin ? origin : "http://other.invalid") + path,
      method: () => (body ? "POST" : "GET"),
      postData: () => (body ? JSON.stringify(body) : null),
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: buffer.length }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => status,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
      body: async () => {
        reads++;
        return responseBody ? responseBody : buffer;
      },
      json: async () => JSON.parse(buffer),
    });
    page.emit("requestfinished", request);
    return { reads: () => reads };
  };
  return { ...value, observer, requirements, send };
}

test("real projector and compact ledger share the exact one-read navigation body", async () => {
  const h = harness("navigation-post");
  const sent = h.send("/api/session-navigation", h.navigation, { body: { surface: "web" } });
  await h.observer.waitResponses(500);
  const snapshot = h.observer.sidebarSnapshot();
  assert.equal(snapshot.lastSidebar.projection.sections.recent.rows[0].id, "known");
  const result = await h.observer.finish();
  assert.deepEqual(result.errors, []);
  validateSidebarEvidence({ ...result, identity: h.sidebar.principalId }, { dynamic: true, ...h.sidebar.profile });
  assert.equal(sent.reads(), 1);
  const entry = result.requests[0];
  assert.equal(entry.responseBodySha256, sha256(Buffer.from(JSON.stringify(h.navigation))));
  assert.equal(entry.sidebarProjection.responseBodySha256, entry.responseBodySha256);
  assert.equal(entry.sidebarProjection.sections.recent.count, 1);
  assert.equal(entry.sidebarProjection.sections.recent.rows, undefined);
  assert.equal(entry.sidebarProjection.qualified, false);
  assert.equal(requiredResponsesComplete(result.requests, h.requirements), true);
});

test("legacy response waits for the observed contexts in either completion order", async () => {
  for (const order of ["sessions-first", "contexts-first"]) {
    const h = harness("legacy-get");
    const firstPath = order === "sessions-first" ? "/api/sessions" : "/api/contexts";
    const secondPath = order === "sessions-first" ? "/api/contexts" : "/api/sessions";
    const values = { "/api/sessions": h.sessions, "/api/contexts": h.contexts };
    const first = h.send(firstPath, values[firstPath]);
    await assert.rejects(h.observer.waitResponses(5));
    const second = h.send(secondPath, values[secondPath]);
    await h.observer.waitResponses(500);
    const result = await h.observer.finish();
    assert.deepEqual(result.errors, []);
    const sessions = result.requests.find((row) => row.path === "/api/sessions");
    const contexts = result.requests.find((row) => row.path === "/api/contexts");
    assert.equal(sessions.sidebarProjection.contextResponseSha256, contexts.responseBodySha256);
    assert.equal(first.reads(), 1);
    assert.equal(second.reads(), 1);
  }
});

test("a prior valid sidebar body cannot satisfy a later invalid or unfinished projection", async () => {
  for (const invalid of [
    { raw: Buffer.from("{") },
    { raw: Buffer.from([0xff]) },
    { raw: Buffer.alloc(4194305) },
    { status: 403 },
    {
      data: (data) => {
        data.recent.items[0].title = "Wrong title";
      },
    },
  ]) {
    const h = harness("navigation-post");
    h.send("/api/session-navigation", h.navigation, { body: { surface: "web" } });
    await h.observer.waitResponses(500);
    const changed = structuredClone(h.navigation);
    invalid.data?.(changed);
    const sent = h.send("/api/session-navigation", changed, { ...invalid, body: { surface: "web" } });
    await assert.rejects(h.observer.waitResponses(10));
    const result = await h.observer.finish();
    assert.ok(result.errors.length);
    assert.equal(result.requests[1].sidebarProjection, undefined);
    assert.equal(sent.reads(), 1);
    assert.equal(requiredResponsesComplete(result.requests, h.requirements), false);
  }
});

test("old body completion and old legacy contexts cannot cross a measurement generation", async () => {
  const h = harness("navigation-post");
  const deferred = Promise.withResolvers();
  const old = h.send("/api/session-navigation", h.navigation, {
    body: { surface: "web" },
    responseBody: deferred.promise,
  });
  h.observer.start();
  deferred.resolve(Buffer.from(JSON.stringify(h.navigation)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.sidebar.retention.bytes, 0);
  assert.equal(h.observer.sidebarSnapshot().lastSidebar, undefined);
  const sent = h.send("/api/session-navigation", h.navigation, { body: { surface: "web" } });
  await h.observer.waitResponses(500);
  const result = await h.observer.finish();
  assert.deepEqual(result.errors, []);
  assert.equal(result.requests.length, 1);
  assert.equal(old.reads(), 1);
  assert.equal(sent.reads(), 1);
  const legacy = harness("legacy-get");
  legacy.send("/api/contexts", legacy.contexts);
  await new Promise((resolve) => setTimeout(resolve, 5));
  legacy.observer.start();
  legacy.send("/api/sessions", legacy.sessions);
  await assert.rejects(legacy.observer.waitResponses(10));
  const unfinished = await legacy.observer.finish(0);
  assert.ok(unfinished.errors.some((row) => row.type === "observer-timeout"));
  assert.equal(unfinished.requests[0].sidebarProjection, undefined);
});

test("late body observation validates its own response without replacing a newer sidebar or contexts snapshot", async () => {
  const h = harness("navigation-post");
  const oldBody = Promise.withResolvers();
  h.send("/api/session-navigation", h.navigation, { body: { surface: "web" }, responseBody: oldBody.promise });
  h.send("/api/session-navigation", h.navigation, { body: { surface: "all" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.observer.sidebarSnapshot().lastSidebar.request.body.surface, "all");
  oldBody.resolve(Buffer.from(JSON.stringify(h.navigation)));
  await h.observer.waitResponses(500);
  assert.equal(h.observer.sidebarSnapshot().lastSidebar.request.body.surface, "all");
  const result = await h.observer.finish();
  assert.deepEqual(result.errors, []);
  assert.ok(result.requests.every((entry) => entry.sidebarProjection));
  const legacy = harness("legacy-get");
  const oldContexts = Promise.withResolvers();
  legacy.send("/api/contexts", legacy.contexts, { responseBody: oldContexts.promise });
  const current = structuredClone(legacy.contexts);
  current.contexts[0].sessionCount = 2;
  legacy.send("/api/contexts", current);
  legacy.send("/api/sessions", legacy.sessions);
  await new Promise((resolve) => setTimeout(resolve, 5));
  oldContexts.resolve(Buffer.from(JSON.stringify(legacy.contexts)));
  await legacy.observer.waitResponses(500);
  assert.equal(
    legacy.observer.sidebarSnapshot().contextProjection.responseBodySha256,
    sha256(Buffer.from(JSON.stringify(current))),
  );
  assert.deepEqual((await legacy.observer.finish()).errors, []);
});

test("actionable envelope and independent identity/ancestry share one body and both must pass", async () => {
  for (const depth of [1, 2]) {
    const h = harness("navigation-post");
    const child = {
      ...h.sessions.sessions[0],
      id: "child",
      threadRef: "agent:main:subagent:child",
      parentSessionId: "known",
      surface: "web",
      working: true,
    };
    h.sidebar.commonActor.preparedWeb.push({
      ...h.sidebar.commonActor.preparedWeb[0],
      id: child.id,
      threadRef: child.threadRef,
      parentSessionId: child.parentSessionId,
      legacyRank: 1,
    });
    const required = [
      { path: "/api/session-navigation/page", method: "POST", captureActionable: true, captureSidebar: true },
    ];
    h.observer.start(required);
    const body = {
      items: [child],
      total: 1,
      nextCursor: null,
      contexts: h.contexts.contexts,
      statusTotals: { active: 1, waiting: 0, archived: 0 },
      actionable: { parentSessionId: "known", depths: [depth], parentSubagents: { running: 1, waiting: 0 } },
    };
    const sent = h.send("/api/session-navigation/page", body, {
      body: { parentSessionId: "known", children: true, actionable: true },
    });
    if (depth === 1) await h.observer.waitResponses(500);
    else await assert.rejects(h.observer.waitResponses(10));
    const result = await h.observer.finish();
    assert.equal(sent.reads(), 1);
    assert.ok(result.requests[0].actionablePage);
    assert.equal(requiredResponsesComplete(result.requests, required), depth === 1);
    if (depth === 1) {
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.requests[0].sidebarProjection.actionable.ancestry, [
        {
          id: "child",
          depth: 1,
          pathSha256: sha256(JSON.stringify(["child", "known"])),
          status: "observed-chain",
        },
      ]);
    } else assert.match(result.requests[0].envelopeError, /Actionable depth/);
  }
});
