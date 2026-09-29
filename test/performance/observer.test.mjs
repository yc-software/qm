import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  actionableRequirements,
  actionableTargets,
  navigationIntent,
  observe,
  requiredResponsesComplete,
  run,
  sidebarRequirements,
  validateSidebarEvidence,
  waitSidebarReady,
} from "./run.mjs";
import { sha256 } from "./verify.mjs";

test("sidebar page evidence matches independent contents and the exact predecessor cursor across phases", () => {
  const path = "/api/session-navigation";
  const allRows = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}` }));
  const spec = {
    transport: "navigation-post",
    surface: "web",
    recent: { total: 51, allRows },
    pinned: { total: 0, rows: [] },
    groups: { total: 1, items: [{ scopeId: "personal" }] },
    allowedOffPageRows: [{ id: "s50", threadRef: "web:actor:known" }],
  };
  const page = (rows, total, nextCursorSha256 = null) => ({
    idsSha256: sha256(JSON.stringify(rows)),
    count: rows.length,
    total,
    nextCursorSha256,
  });
  const first = {
    path,
    sameOrigin: true,
    method: "POST",
    completed: true,
    status: 200,
    navigation: navigationIntent(path, JSON.stringify({ surface: "web" })),
    navigationPages: {
      recent: page(
        allRows.slice(0, 50).map((row) => row.id),
        51,
        sha256("continuation"),
      ),
      pinned: page([], 0),
      groups: page(["personal"], 1),
    },
  };
  const second = {
    ...first,
    navigation: navigationIntent(path, JSON.stringify({ surface: "web", section: "recent", cursor: "continuation" })),
    navigationPages: { ...first.navigationPages, recent: page(["s50"], 51) },
  };
  const evidence = (requests) => ({ errors: [], requests });
  assert.doesNotThrow(() => validateSidebarEvidence(evidence([first]), spec));
  assert.doesNotThrow(() => validateSidebarEvidence(evidence([second]), spec, [first]));
  const requirements = sidebarRequirements(spec, { optional: true, cursorSha256: sha256("continuation") });
  assert.equal(requiredResponsesComplete([second], requirements), true);
  assert.equal(requiredResponsesComplete([first], requirements), false);
  assert.equal(requiredResponsesComplete([], requirements), false);
  assert.equal(requiredResponsesComplete([], sidebarRequirements(spec, { optional: true })), true);
  assert.equal(requiredResponsesComplete([], sidebarRequirements(spec)), false);
  for (const mutate of [
    (row) => {
      row.navigation.cursorSha256 = sha256("unseen");
    },
    (row) => {
      row.navigationPages.recent.idsSha256 = sha256(JSON.stringify(["s49"]));
    },
    (row) => {
      row.navigationPages.recent.total = 50;
    },
    (row) => {
      row.navigationPages.recent.nextCursorSha256 = sha256("stale");
    },
    (row) => {
      row.navigationPages.groups.idsSha256 = sha256(JSON.stringify(["foreign"]));
    },
    (row) => {
      row.navigation.references = [{ kind: "id", valueSha256: sha256("foreign") }];
    },
    (row) => {
      row.navigation.surface = "all";
    },
    (row) => {
      delete row.navigationPages;
    },
  ]) {
    const wrong = structuredClone(second);
    mutate(wrong);
    assert.throws(() => validateSidebarEvidence(evidence([wrong]), spec, [first]));
  }
  assert.throws(() => validateSidebarEvidence(evidence([second]), spec), /predecessor/);
  assert.throws(
    () => validateSidebarEvidence(evidence([first, { path: "/api/sessions", sameOrigin: true }]), spec),
    /fell back/,
  );
  assert.deepEqual(sidebarRequirements({ transport: "legacy-get" }), [
    { path: "/api/sessions", optional: false },
    { path: "/api/contexts", optional: false },
  ]);
  assert.doesNotThrow(() =>
    validateSidebarEvidence(evidence([{ path: "/api/sessions", sameOrigin: true }]), { transport: "legacy-get" }),
  );
});

test("navigation evidence hashes continuation identity and rejects malformed successful page envelopes", async () => {
  const origin = "http://127.0.0.1:8129",
    path = "/api/session-navigation";
  const body = JSON.stringify({ surface: "web" });
  const requirement = { path, method: "POST", navigation: navigationIntent(path, body), captureNavigation: true };
  const valid = {
    recent: { items: [{ id: "private-session" }], total: 2, nextCursor: "private-cursor" },
    pinned: { items: [], total: 0, nextCursor: null },
    groups: { items: [{ scopeId: "private-group" }], total: 1, nextCursor: null },
  };
  const validBytes = Buffer.from(JSON.stringify(valid));
  const limit = 4194304;
  const cases = [
    { bytes: validBytes, valid: true },
    { bytes: Buffer.concat([validBytes, Buffer.alloc(limit - validBytes.length, 32)]), valid: true },
    { bytes: Buffer.concat([validBytes, Buffer.alloc(limit + 1 - validBytes.length, 32)]), valid: false },
    { bytes: Buffer.from(JSON.stringify({ ...valid, groups: { ...valid.groups, total: false } })), valid: false },
    { bytes: Buffer.from("{"), valid: false },
    { bytes: Buffer.alloc(0), valid: false },
    {
      bytes: Buffer.concat([
        validBytes.subarray(0, -1),
        Buffer.from(',"extra":"'),
        Buffer.from([255]),
        Buffer.from('"}'),
      ]),
      valid: false,
    },
  ];
  for (const item of cases) {
    const page = new EventEmitter();
    const observer = observe(page, origin, [requirement]);
    observer.start();
    const send = (raw) => {
      const request = {
        url: () => origin + path,
        method: () => "POST",
        postData: () => body,
        resourceType: () => "fetch",
        timing: () => ({}),
        sizes: async () => ({ responseBodySize: 2 }),
      };
      page.emit("request", request);
      page.emit("response", {
        request: () => request,
        status: () => 200,
        fromServiceWorker: () => false,
        allHeaders: async () => ({}),
        body: async () => raw,
        json: async () => JSON.parse(new TextDecoder().decode(await raw)),
      });
      page.emit("requestfinished", request);
    };
    send(validBytes);
    await observer.waitResponses(100);
    const held = Promise.withResolvers();
    send(held.promise);
    await assert.rejects(observer.waitResponses(10), /Required page requests/);
    held.resolve(item.bytes);
    if (item.valid) await observer.waitResponses(100);
    else await assert.rejects(observer.waitResponses(10), /Required page requests/);
    const evidence = await observer.finish();
    if (!item.valid)
      assert.deepEqual(evidence.errors, [{ type: "contract", path, message: "Invalid navigation page envelope" }]);
    else {
      assert.deepEqual(evidence.errors, []);
      const entry = evidence.requests[1];
      assert.match(entry.navigationPages.recent.nextCursorSha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.navigationPages.groups.nextCursorSha256, null);
      assert.equal(entry.responseBodyBytes, item.bytes.length);
      assert.equal(entry.responseBodySha256, sha256(item.bytes));
    }
    assert.equal(JSON.stringify(evidence).includes("private-"), false);
  }
});

test("an aborted navigation body needs an identical successful successor and explicit permission to supersede", async () => {
  const origin = "http://127.0.0.1:8129",
    path = "/api/session-navigation";
  const data = Buffer.from(
    JSON.stringify(
      Object.fromEntries(["recent", "pinned", "groups"].map((key) => [key, { items: [], total: 0, nextCursor: null }])),
    ),
  );
  for (const mode of ["absent", "wrong-intent", "disallowed", "before", "after"]) {
    const page = new EventEmitter();
    const body = JSON.stringify({ surface: "web" });
    const requirement = {
      path,
      method: "POST",
      navigation: navigationIntent(path, body),
      captureNavigation: true,
      allowSupersededAbort: mode !== "disallowed",
    };
    const observer = observe(page, origin, [requirement]);
    observer.start();
    const send = (raw, postData = body, finish = true) => {
      const request = {
        url: () => origin + path,
        method: () => "POST",
        postData: () => postData,
        resourceType: () => "fetch",
        timing: () => ({}),
        sizes: async () => ({}),
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", request);
      page.emit("response", {
        request: () => request,
        status: () => 200,
        fromServiceWorker: () => false,
        allHeaders: async () => ({}),
        body: async () => raw,
      });
      if (finish) page.emit("requestfinished", request);
      return request;
    };
    const held = Promise.withResolvers();
    const aborted = send(held.promise, body, false);
    if (mode !== "after") held.reject(new Error("Modeled aborted navigation body"));
    await new Promise((resolve) => setImmediate(resolve));
    page.emit("requestfailed", aborted);
    if (mode !== "absent") send(data, mode === "wrong-intent" ? JSON.stringify({ surface: "all" }) : body);
    if (mode === "after") {
      await new Promise((resolve) => setImmediate(resolve));
      held.reject(new Error("Modeled late aborted navigation body"));
    }
    const succeeds = ["before", "after"].includes(mode);
    if (succeeds) await observer.waitResponses(100);
    else await assert.rejects(observer.waitResponses(10));
    const evidence = await observer.finish();
    assert.equal(requiredResponsesComplete(evidence.requests, [requirement]), succeeds);
    assert.equal(evidence.errors.length, ["absent", "wrong-intent"].includes(mode) ? 1 : 0);
  }
});

test("sidebar readiness checks populated grouped content, continuations and retained rows in a real browser", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(100);
    const allRows = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      title: `Chat ${i}`,
      groupedTitle: `Chat ${i}`,
      scopeId: i % 2 ? "standalone" : "personal",
    }));
    const groups = [
      { scopeId: "personal", name: "Personal", count: 26 },
      { scopeId: "empty", name: "Empty project", count: 0 },
    ];
    const spec = {
      schemaVersion: 1,
      surface: "web",
      transport: "navigation-post",
      sourceRevision: "a".repeat(40),
      recent: { total: 51, allRows },
      pinned: { total: 1, rows: [{ id: "pin", title: "Pinned chat" }], hasMore: false },
      groups: { total: 2, items: groups, hasMore: false },
      archivedCount: 3,
      allowedOffPageRows: [allRows[50]],
    };
    const row = (item) =>
      `<div class="session-row" data-session-id="${item.id}"><a class="session" aria-busy="false"><span class="tl">${item.title}</span></a></div>`;
    const html = ({ limit = 50, retained = false, legacy = false } = {}) => {
      const rows = allRows.filter((_, i) => i < limit || (retained && i === 50));
      return `<div id="sidebar-body" data-session-navigation="ready" data-session-navigation-mode="bounded" data-session-navigation-pending="" aria-busy="false"
        data-session-recent-loaded="${Math.min(limit, 51)}" data-session-recent-total="51" data-session-pinned-loaded="1" data-session-pinned-total="1" data-session-groups-loaded="2" data-session-groups-total="2">
        <div class="pinned-children">${row({ id: "pin", title: "Pinned chat" })}</div>
        ${groups
          .map(
            (group) =>
              `<section class="recent-project" ${legacy ? "" : `data-scope-id="${group.scopeId}"`}><span class="recent-project-name">${group.name}</span><span class="recent-project-count">${group.count}</span><div class="recent-project-menu"><button data-menu-id="project:${group.scopeId}">Options</button></div>${rows
                .filter((item) => item.scopeId === group.scopeId)
                .map(row)
                .join("")}</section>`,
          )
          .join("")}
        ${rows
          .filter((item) => item.scopeId === "standalone")
          .map(row)
          .join("")}
        ${limit < 51 ? '<button data-session-page="recent">Show more conversations</button>' : ""}<span class="archived-count">3</span></div>`;
    };
    await page.setContent(html());
    assert.equal((await waitSidebarReady(page, spec)).recent.length, 50);
    for (const mutation of [
      () => globalThis.document.querySelector('[data-session-id="s0"]').remove(),
      () => {
        globalThis.document.querySelector('[data-session-id="s0"] .tl').textContent = "Stale title";
      },
      () => {
        globalThis.document.querySelector(".recent-project-count").textContent = "25";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionNavigation = "loading";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionNavigationMode = "legacy";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionRecentLoaded = "51";
      },
      () => {
        globalThis.document.querySelector('[data-session-page="recent"]').disabled = true;
      },
      () => {
        globalThis.document
          .querySelector('[data-session-id="s2"]')
          .before(globalThis.document.querySelector('[data-session-id="s4"]'));
      },
    ]) {
      await page.setContent(html());
      await page.evaluate(mutation);
      await assert.rejects(waitSidebarReady(page, spec), /Timeout/);
    }
    await page.setContent(html({ retained: true }));
    await assert.rejects(waitSidebarReady(page, spec), /Timeout/);
    assert.equal((await waitSidebarReady(page, spec, { retainedIds: ["s50"] })).recent.length, 51);
    await assert.rejects(waitSidebarReady(page, spec, { retainedIds: ["foreign"] }), /Unobserved retained/);
    await page.setContent(html({ limit: 100 }));
    assert.equal((await waitSidebarReady(page, spec, { limit: 100 })).recent.length, 51);
    await page.setContent(html({ legacy: true }));
    await page.locator("#sidebar-body").evaluate((root) => {
      for (const key of Object.keys(root.dataset)) delete root.dataset[key];
    });
    assert.equal((await waitSidebarReady(page, { ...spec, transport: "legacy-get" })).recent.length, 50);
    spec.pinned.rows[0].title = "2 alice,\u00a0bob";
    for (const transport of ["legacy-get", "navigation-post"]) {
      await page.setContent(
        html({ legacy: transport === "legacy-get" }).replace(
          "Pinned chat",
          "<span>2</span>\n    <span>alice,\u00a0bob</span>",
        ),
      );
      assert.equal((await waitSidebarReady(page, { ...spec, transport })).pinned[0].title, "2 alice,\u00a0bob");
      await page.locator(".pinned-children .tl").evaluate((element) => {
        element.textContent = "2 alice, bob";
      });
      await assert.rejects(waitSidebarReady(page, { ...spec, transport }), /Timeout/);
    }
  } finally {
    await browser.close();
  }
});

test("only a later successful identical navigation can supersede an explicitly admitted abort", () => {
  const path = "/api/session-navigation";
  const navigation = navigationIntent(path, JSON.stringify({ surface: "web", section: "recent" }));
  const requirement = { path, method: "POST", navigation, allowSupersededAbort: true };
  const done = { path, method: "POST", navigation, completed: true, status: 200 };
  const aborted = { ...done, completed: false, status: undefined, phase: "failed", failure: "net::ERR_ABORTED" };
  assert.equal(requiredResponsesComplete([aborted, done], [requirement]), true);
  for (const requests of [
    [done, aborted],
    [aborted],
    [aborted, { ...done, completed: false }],
    [aborted, { ...done, status: 403 }],
    [{ ...aborted, status: 500 }, done],
    [{ ...aborted, failure: "net::ERR_CONNECTION_RESET" }, done],
    [{ ...aborted, phase: "started" }, done],
    [aborted, { ...done, navigation: { ...navigation, cursorSha256: "different-page" } }],
  ])
    assert.equal(requiredResponsesComplete(requests, [requirement]), false);
  assert.equal(requiredResponsesComplete([aborted, done], [{ ...requirement, allowSupersededAbort: false }]), false);
  assert.equal(
    requiredResponsesComplete([aborted, done], [{ path, method: "POST", allowSupersededAbort: true }]),
    false,
  );
  const partial = { ...requirement, navigation: { surface: "web" } };
  assert.equal(
    requiredResponsesComplete(
      [aborted, { ...done, navigation: { ...navigation, cursorSha256: "different-page" } }],
      [partial],
    ),
    false,
  );
});

test("preparation evidence survives changing the measured request requirements", async () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:8129";
  const observer = observe(page, origin, [{ path: "/prepared" }]);
  const emit = (path) => {
    const request = {
      url: () => origin + path,
      method: () => "GET",
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => 200,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
    });
    page.emit("requestfinished", request);
  };
  observer.start();
  emit("/prepared");
  await observer.waitResponses(100);
  const prepared = await observer.finish();
  observer.start([{ path: "/action" }]);
  await assert.rejects(observer.waitResponses(10), /\/action/);
  emit("/action");
  await observer.waitResponses(100);
  const measured = await observer.finish();
  assert.deepEqual(
    prepared.requests.map((entry) => entry.path),
    ["/prepared"],
  );
  assert.deepEqual(
    measured.requests.map((entry) => entry.path),
    ["/action"],
  );
  assert.ok(prepared.requests[0].completed && measured.requests[0].completed);
});

test("identity belongs to its phase and malformed current responses cannot inherit a prepared identity", async () => {
  const origin = "http://127.0.0.1:8129";
  const page = new EventEmitter();
  const observer = observe(page, origin, [{ path: "/me" }]);
  const send = (json = async () => ({ principal: "actor" }), path = "/me", status = 200) => {
    const request = {
      url: () => origin + path,
      method: () => "GET",
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => status,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
      json,
    });
    page.emit("requestfinished", request);
  };
  const prepare = async () => {
    observer.start([{ path: "/me" }]);
    send();
    await observer.waitResponses(100);
    const evidence = await observer.finish();
    assert.equal(evidence.identity, "actor");
    assert.deepEqual(evidence.errors, []);
  };
  await prepare();
  observer.start([], { reuseIdentity: true });
  assert.equal((await observer.finish()).identity, "actor");
  observer.start([]);
  assert.equal((await observer.finish()).identity, undefined);
  assert.throws(() => observer.start([], { reuseIdentity: true }), /No verified identity/);
  for (const json of [
    async () => null,
    async () => ({}),
    async () => ({ user: "  " }),
    async () => ({ principal: { id: "actor" } }),
    async () => ({ principal: false, user: "actor" }),
    async () => {
      throw new SyntaxError("Private malformed response");
    },
  ]) {
    await prepare();
    observer.start([{ path: "/me" }], { reuseIdentity: true });
    send(json);
    await observer.waitResponses(100);
    const evidence = await observer.finish();
    assert.equal(evidence.identity, undefined);
    assert.deepEqual(evidence.errors, [{ type: "contract", path: "/me", message: "Invalid identity response" }]);
  }
  await prepare();
  observer.start([{ path: "/admin/api/me" }]);
  send(async () => ({ user: "wrong-actor" }), "/admin/api/me");
  await observer.waitResponses(100);
  assert.equal((await observer.finish()).identity, "wrong-actor");
  await prepare();
  observer.start([], { reuseIdentity: true });
  send(undefined, "/me", 401);
  const denied = await observer.finish();
  assert.equal(denied.identity, undefined);
  assert.deepEqual(denied.errors, [{ type: "http", path: "/me", status: 401 }]);
  for (const nextPhase of [false, true]) {
    observer.start([]);
    const delayed = Promise.withResolvers();
    send(() => delayed.promise);
    if (nextPhase) observer.start([]);
    send(async () => ({ user: "latest-actor" }));
    delayed.resolve({ user: "old-actor" });
    const evidence = await observer.finish();
    assert.equal(evidence.identity, "latest-actor");
    assert.deepEqual(evidence.errors, []);
  }
  observer.start([]);
  const old = Promise.withResolvers();
  send(() => old.promise);
  observer.start([]);
  send();
  old.reject(new SyntaxError("Old phase"));
  const evidence = await observer.finish();
  assert.equal(evidence.identity, "actor");
  assert.deepEqual(evidence.errors, []);
});

test("observer retains pending and failed starts without mixing measurement generations", async () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:8129";
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const request = (path, options = {}) => ({
    url: () => origin + path,
    method: () => "GET",
    resourceType: () => "fetch",
    timing: () => ({ startTime: 1000 }),
    sizes: async () => ({ responseBodySize: 2 }),
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    ...options,
  });
  const response = (req, options = {}) => ({
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    json: async () => ({ principal: "current@example.invalid" }),
    allHeaders: async () => ({ "content-type": "application/json" }),
    ...options,
  });
  const observer = observe(
    page,
    origin,
    ["/done", "/pending", "/missing", "/failed"].map((path) => ({ path })),
  );
  observer.start();
  const oldIdentity = deferred();
  const oldHeaders = deferred();
  const oldSizes = deferred();
  const previousMe = request("/me");
  const previousDone = request("/done", { sizes: () => oldSizes.promise });
  const previousMissing = request("/missing");
  for (const req of [previousMe, previousDone, previousMissing]) page.emit("request", req);
  page.emit("response", response(previousMe, { json: () => oldIdentity.promise }));
  page.emit("response", response(previousDone, { allHeaders: () => oldHeaders.promise }));
  page.emit("requestfinished", previousDone);

  observer.start();
  const done = request("/done?private=secret-query");
  const completedDuplicate = request("/pending");
  const pending = request("/pending");
  const failed = request("/failed");
  const me = request("/me");
  for (const req of [done, completedDuplicate, pending, failed, me]) page.emit("request", req);
  for (const req of [done, completedDuplicate, me]) {
    page.emit("response", response(req));
    page.emit("requestfinished", req);
  }
  page.emit("requestfailed", failed);
  page.emit("response", response(previousMissing));
  page.emit("requestfinished", previousMissing);
  oldIdentity.resolve({ principal: "previous@example.invalid" });
  oldHeaders.reject(new Error("Previous measurement headers failed"));
  oldSizes.resolve({ responseBodySize: 999 });

  await assert.rejects(observer.waitResponses(10), {
    message: "Required page requests did not finish: /pending, /missing, /failed",
  });
  const evidence = await observer.finish();
  assert.equal(evidence.identity, "current@example.invalid");
  assert.equal(evidence.requests.length, 5);
  assert.equal(
    evidence.requests.some((entry) => entry.path === "/missing"),
    false,
  );
  const duplicates = evidence.requests.filter((entry) => entry.path === "/pending");
  assert.equal(duplicates[0].completed, true);
  assert.equal(duplicates[0].phase, "finished");
  assert.equal(duplicates[1].completed, false);
  assert.equal(duplicates[1].phase, "started");
  assert.equal(duplicates[1].status, undefined);
  assert.ok(duplicates[1].pendingForMs >= 0);
  const failedEntry = evidence.requests.find((entry) => entry.path === "/failed");
  assert.equal(failedEntry.phase, "failed");
  assert.equal(failedEntry.failure, "net::ERR_CONNECTION_RESET");
  assert.equal(failedEntry.completed, false);
  assert.deepEqual(evidence.errors, [{ type: "requestfailed", path: "/failed", message: "net::ERR_CONNECTION_RESET" }]);
  assert.equal(JSON.stringify(evidence).includes("secret-query"), false);
});

test("navigation completion binds method, section, cursor, filters and ordered references without storing their text", async () => {
  const path = "/api/session-navigation/page";
  const body = {
    children: true,
    parentSessionId: "private-parent",
    query: "private-query",
    title: "private-title",
    cursor: "private-cursor",
  };
  const intent = navigationIntent(path, JSON.stringify(body));
  assert.deepEqual(intent, navigationIntent(path, JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))));
  assert.equal(JSON.stringify(intent).includes("private-"), false);
  const referencePath = "/api/session-navigation/resolve";
  const refs = [
    { kind: "id", value: "private-a" },
    { kind: "thread", value: "private-b" },
  ];
  assert.notDeepEqual(
    navigationIntent(referencePath, JSON.stringify({ references: refs })),
    navigationIntent(referencePath, JSON.stringify({ references: [...refs].reverse() })),
  );
  for (const invalid of [
    null,
    [],
    { ...body, principalId: "forged" },
    { ...body, children: "true" },
    { ...body, cursor: "x".repeat(4097) },
  ])
    assert.throws(() => navigationIntent(path, JSON.stringify(invalid)));
  assert.throws(() => navigationIntent(referencePath, JSON.stringify({ references: Array(13).fill(refs[0]) })));
  const requirement = { path, method: "POST", navigation: intent };
  const entry = { path, method: "POST", navigation: intent, completed: true, status: 200 };
  assert.equal(requiredResponsesComplete([entry], [requirement]), true);
  for (const change of [
    { method: "GET" },
    { sameOrigin: false },
    { completed: false },
    { status: 500 },
    { navigation: { ...intent, cursorSha256: null } },
    { navigation: { ...intent, parentSessionIdSha256: null } },
  ])
    assert.equal(requiredResponsesComplete([{ ...entry, ...change }], [requirement]), false);
  assert.equal(requiredResponsesComplete([entry], [{ path }]), false);
  assert.equal(requiredResponsesComplete([entry, { ...entry, completed: false }], [requirement]), false);
  const initial = navigationIntent("/api/session-navigation", JSON.stringify({ surface: "web" }));
  assert.notDeepEqual(
    initial,
    navigationIntent("/api/session-navigation", JSON.stringify({ surface: "web", section: "pinned" })),
  );

  const page = new EventEmitter();
  const observer = observe(page, "http://127.0.0.1:8129", [requirement]);
  observer.start();
  const request = {
    url: () => "http://127.0.0.1:8129" + path,
    method: () => "POST",
    postData: () => JSON.stringify(body),
    resourceType: () => "fetch",
    timing: () => ({}),
    sizes: async () => ({ responseBodySize: 2 }),
  };
  page.emit("request", request);
  page.emit("response", {
    request: () => request,
    status: () => 200,
    fromServiceWorker: () => false,
    allHeaders: async () => ({}),
  });
  await assert.rejects(observer.waitResponses(5));
  page.emit("requestfinished", request);
  await observer.waitResponses(100);
  const evidence = await observer.finish();
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.requests[0].navigation, intent);
  assert.equal(JSON.stringify(evidence).includes("private-"), false);
});

function actionablePage(parent = "private-parent", waiting = false, count = 0) {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: `private-child-${i}`,
      scopeId: "scope",
      threadRef: `thread-${i}`,
      createdAt: 1,
      type: "dm",
      working: !waiting,
      awaitingInput: waiting,
    })),
    total: count,
    nextCursor: null,
    contexts: [],
    statusTotals: { active: count, waiting: waiting ? count : 0, archived: 0 },
    actionable: {
      parentSessionId: parent,
      parentSubagents: { running: waiting ? 0 : count, waiting: waiting ? count : 0 },
      depths: Array(count).fill(1),
    },
  };
}

function actionableObserver() {
  const origin = "http://127.0.0.1:8129";
  const page = new EventEmitter();
  const requirements = actionableRequirements([{ parent: "private-parent", root: ".custom-chat" }]);
  const observer = observe(page, origin, requirements);
  observer.start();
  const send = (
    data,
    {
      parent = "private-parent",
      path = "/api/session-navigation/page",
      status = 200,
      json,
      finish = true,
      cursor,
    } = {},
  ) => {
    const request = {
      url: () => origin + path,
      method: () => (path.endsWith("/approvals") ? "GET" : "POST"),
      postData: () =>
        JSON.stringify({ parentSessionId: parent, children: true, actionable: true, ...(cursor ? { cursor } : {}) }),
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => status,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
      body: async () => Buffer.from(JSON.stringify(json ? await json() : data)),
    });
    if (finish) page.emit("requestfinished", request);
    return request;
  };
  return { page, observer, requirements, send };
}

test("actionable requirements follow the measured parent and visible panes without imposing a baseline endpoint", () => {
  const sidebarReadiness = { transport: "navigation-post" };
  const scenario = { kind: "sidebar-switch", path: "/s/long%20id", session: { sessionId: "short" }, sidebarReadiness };
  assert.deepEqual(actionableTargets(scenario), [{ parent: "short", root: ".custom-chat" }]);
  assert.equal(actionableTargets(scenario, true)[0].parent, "long id");
  for (const path of ["/", "/settings", "/admin/history"])
    assert.deepEqual(actionableTargets({ ...scenario, path }), []);
  assert.deepEqual(actionableTargets({ ...scenario, admin: true }), []);
  assert.deepEqual(actionableTargets({ ...scenario, sidebarReadiness: { transport: "legacy-get" } }), []);
  const multi = {
    kind: "hidden-tab",
    sidebarReadiness,
    sessions: Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}` })),
    visibleIndices: [2, 5, 8, 11],
  };
  assert.deepEqual(
    actionableTargets(multi, true).map((row) => row.parent),
    ["s2", "s5", "s8", "s11"],
  );
  assert.deepEqual(
    actionableTargets(multi).map((row) => row.parent),
    ["s0", "s5", "s8", "s11"],
  );
  assert.equal(actionableTargets(multi)[0].root, '[data-pane-id="perf-pane-0"]');
  assert.deepEqual(actionableTargets({ ...multi, kind: "multiview" }), actionableTargets(multi, true));
});

test("actionable completion requires bounded well-formed initial parent data even for an absent empty strip", async () => {
  for (const mutate of [
    (data) => {
      data.extra = "x".repeat(4194304);
    },
    (data) => {
      data.actionable.parentSessionId = "wrong";
    },
    (data) => {
      delete data.actionable;
    },
    (data) => {
      data.actionable.depths = [1];
    },
    (data) => {
      data.total = false;
    },
    (data) => {
      data.total = 1;
    },
    (data) => {
      data.nextCursor = "cursor";
    },
    (data) => {
      data.actionable.parentSubagents.waiting = -1;
    },
    (data) => {
      delete data.contexts;
    },
    (data) => {
      data.statusTotals.active = false;
    },
    (data) => {
      Object.assign(data, actionablePage("private-parent", false, 51));
    },
    (data) => {
      Object.assign(data, actionablePage("private-parent", false, 1));
      data.items[0].working = "true";
    },
    (data) => {
      Object.assign(data, actionablePage("private-parent", false, 1));
      data.items[0].working = false;
    },
    (data) => {
      Object.assign(data, actionablePage("private-parent", false, 1));
      data.actionable.depths[0] = 0;
    },
    (data) => {
      Object.assign(data, actionablePage("private-parent", false, 1));
      data.actionable.parentSubagents = null;
    },
  ]) {
    const { observer, send } = actionableObserver();
    const data = actionablePage();
    mutate(data);
    send(data);
    await assert.rejects(observer.waitResponses(8));
    assert.equal(
      (await observer.finish()).errors.some((row) => row.type === "contract"),
      true,
    );
  }
  for (const mode of ["empty", "null", "more"]) {
    const { observer, send } = actionableObserver();
    const data = actionablePage("private-parent", false, ["more", "missing-more"].includes(mode) ? 50 : 0);
    if (mode === "null") data.actionable.parentSubagents = null;
    if (mode === "more") {
      data.total = 51;
      data.nextCursor = "private-cursor";
    }
    send(data);
    await observer.waitResponses(100);
    const evidence = await observer.finish();
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.requests[0].actionablePage.count, data.items.length);
    assert.equal(JSON.stringify(evidence).includes("private-"), false);
  }
  for (const mode of ["omitted", "wrong-parent", "failed", "continuation-only"]) {
    const { observer, send } = actionableObserver();
    if (mode === "wrong-parent") send(actionablePage("other"), { parent: "other" });
    if (mode === "failed") send(actionablePage(), { status: 500 });
    if (mode === "continuation-only") send(actionablePage(), { cursor: "continuation" });
    await assert.rejects(observer.waitResponses(8));
    await observer.finish();
  }
});

test("waiting actionable children require completed approval data and cannot borrow an older phase or parent", async () => {
  const { page, observer, requirements, send } = actionableObserver();
  send(actionablePage("private-parent", true, 1));
  await assert.rejects(observer.waitResponses(8));
  const late = Promise.withResolvers();
  send(undefined, { path: "/api/sessions/private-child-0/approvals", json: () => late.promise });
  await assert.rejects(observer.waitResponses(8));
  late.resolve({ approvals: [{ requestId: "approval", command: "modeled command" }] });
  await observer.waitResponses(100);
  const prepared = await observer.finish();
  assert.equal(prepared.requests[1].approvalCount, 1);
  observer.start();
  await observer.waitResponses(100, requirements, prepared.requests);
  const aborted = send(actionablePage(), { finish: false });
  page.emit("requestfailed", aborted);
  await assert.rejects(observer.waitResponses(8, requirements, prepared.requests));
  send(actionablePage());
  await observer.waitResponses(100, requirements, prepared.requests);
  const measured = await observer.finish();
  assert.equal(requiredResponsesComplete(measured.requests, actionableRequirements([{ parent: "other" }])), false);
  observer.start();
  const old = Promise.withResolvers();
  send(undefined, { json: () => old.promise });
  observer.start();
  old.resolve(actionablePage());
  await assert.rejects(observer.waitResponses(8));
  assert.equal((await observer.finish()).requests.length, 0);
  for (const data of [
    {},
    { approvals: [{}] },
    { approvals: [{ requestId: "ok", command: false }] },
    { approvals: [{ requestId: "ok", command: "x".repeat(4194304) }] },
  ]) {
    observer.start();
    send(actionablePage("private-parent", true, 1));
    send(data, { path: "/api/sessions/private-child-0/approvals" });
    await assert.rejects(observer.waitResponses(8));
    assert.equal(
      (await observer.finish()).errors.some((row) => row.message === "Invalid approval envelope"),
      true,
    );
  }
});

test("an aborted actionable body needs a later identical completed successor regardless of body rejection order", async () => {
  for (const successor of [false, true]) {
    const { page, observer, send } = actionableObserver();
    const body = Promise.withResolvers();
    const request = send(undefined, { json: () => body.promise, finish: false });
    body.reject(new Error("Modeled aborted body"));
    await new Promise((resolve) => setImmediate(resolve));
    page.emit("requestfailed", request);
    if (successor) {
      send(actionablePage());
      await observer.waitResponses(100);
    } else await assert.rejects(observer.waitResponses(8));
    assert.equal((await observer.finish()).errors.length, successor ? 0 : 1);
  }
});

test("actionable response bodies cannot overwrite a newer request or satisfy a later incomplete request", async () => {
  const { observer, send } = actionableObserver();
  const old = Promise.withResolvers();
  send(undefined, { json: () => old.promise });
  send(actionablePage());
  await assert.rejects(observer.waitResponses(8));
  old.resolve(actionablePage("private-parent", false, 1));
  await observer.waitResponses(100);
  const evidence = await observer.finish();
  assert.deepEqual(
    evidence.requests.map((row) => row.actionablePage.count),
    [1, 0],
  );
  observer.start();
  send(actionablePage());
  send(actionablePage(), { finish: false });
  await assert.rejects(observer.waitResponses(8));
  await observer.finish();
});

test("observer finalization bounds pending bodies and preserves failure evidence against late completion", async () => {
  const { observer, send } = actionableObserver();
  const body = Promise.withResolvers();
  send(undefined, { json: () => body.promise, finish: false });
  const start = performance.now();
  const result = await observer.finish(10);
  assert.ok(performance.now() - start < 500);
  assert.deepEqual(result.errors, [
    { type: "observer-timeout", message: "Response observation did not finish", pendingObservations: 1 },
  ]);
  assert.equal(result.requests[0].completed, false);
  assert.equal(result.requests[0].status, 200);
  observer.start();
  body.resolve(actionablePage());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(observer.waitResponses(8));
  send(actionablePage());
  await observer.waitResponses(100);
  const next = await observer.finish(50);
  assert.deepEqual(next.errors, []);
  assert.equal(next.requests.length, 1);
  assert.equal(result.requests[0].actionablePage, undefined);
});

test(
  "modeled HTTP Chromium samples include actionable and approval completion, including empty initial pages",
  { timeout: 35000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const output = await mkdtemp(join(tmpdir(), "qm-actionable-observer-"));
    const actor = "modeled-actor",
      parent = "private-parent",
      sourceRevision = "a".repeat(40);
    const row = {
      id: parent,
      title: "Modeled chat",
      groupedTitle: "Modeled chat",
      scopeId: "personal",
      threadRef: "web:modeled:parent",
    };
    const group = { scopeId: "personal", name: "Personal", count: 1 };
    const sessions = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `pane-${i}`,
      principalId: actor,
      title: `Pane ${i}`,
      expectedVisibleText: `Transcript ${i}`,
      scopeId: "personal",
      threadRef: `web:modeled:${i}`,
    }));
    const hiddenPhases = [];
    const hungClosed = new Set();
    const waitingModes = [
      "waiting",
      "waiting-zero",
      "missing-approvals",
      "wrong-render",
      "hung-approvals",
      "hidden-approval",
      "no-controls",
      "aria-disabled",
      "hidden-controls",
      "missing-deny",
      "hidden-waiting",
    ];
    const hiddenMode = () => mode === "hidden" || mode === "hidden-omitted";
    const rows = () =>
      hiddenMode()
        ? sessions.map((session) => ({
            id: session.sessionId,
            title: session.title,
            groupedTitle: session.title,
            scopeId: session.scopeId,
            threadRef: session.threadRef,
          }))
        : [row];
    let mode,
      state = { value: { v: 2, active: false }, updatedAt: 0 };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const send = (value) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (req.url === "/me") return send({ user: actor });
      if (req.url.startsWith("/api/ui-state")) {
        if (req.method === "PUT") state = { value: body.value, updatedAt: body.updatedAt };
        return send({ ...state, ok: true });
      }
      if (req.url === "/api/session-navigation")
        return send({
          recent: { items: rows(), total: rows().length, nextCursor: null },
          pinned: { items: [], total: 0, nextCursor: null },
          groups: { items: [{ ...group, count: rows().length }], total: 1, nextCursor: null },
        });
      if (req.url === "/api/sessions") return send({ sessions: rows() });
      if (req.url === "/modeled-hidden-phase") {
        hiddenPhases.push(body);
        return send({ ok: true });
      }
      if (req.url === "/api/contexts") return send({ contexts: [] });
      if (req.url === "/api/session-navigation/page") {
        if (mode === "hung-page") {
          const heldMode = mode;
          res.on("close", () => hungClosed.add(heldMode));
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"items":');
          return;
        }
        const waiting = waitingModes.includes(mode);
        const count = ["more", "missing-more"].includes(mode) ? 50 : Number(waiting);
        const data = actionablePage(body.parentSessionId, waiting, count);
        if (["more", "missing-more"].includes(mode)) {
          data.total = 51;
          data.nextCursor = "next";
        }
        if (mode === "malformed") delete data.actionable;
        return setTimeout(() => send(data), 180);
      }
      if (req.url.endsWith("/approvals")) {
        if (mode === "hung-approvals") {
          const heldMode = mode;
          res.on("close", () => hungClosed.add(heldMode));
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"approvals":');
          return;
        }
        return setTimeout(
          () =>
            send({
              approvals: ["waiting-zero", "hidden-waiting"].includes(mode)
                ? []
                : [{ requestId: "a", command: "modeled only" }],
            }),
          220,
        );
      }
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><div class="custom-chat">Visible transcript<textarea></textarea><div id="activity"></div></div><div id="sidebar-body"></div><script>
      const mode=${JSON.stringify(mode)}, parent=${JSON.stringify(parent)}, sessions=${JSON.stringify(sessions)}, rows=${JSON.stringify(rows())};
      const hiddenMode=mode==='hidden'||mode==='hidden-omitted', waitingModes=${JSON.stringify(waitingModes)};
      const root=document.querySelector('#sidebar-body');
      (async()=>{
        await fetch('/me').then(r=>r.json());
        if(mode==='legacy') await Promise.all([fetch('/api/sessions'),fetch('/api/contexts')]);
        else await fetch('/api/session-navigation',{method:'POST',body:JSON.stringify({surface:'web'})}).then(r=>r.json());
        if(mode!=='legacy') Object.assign(root.dataset,{sessionNavigation:'ready',sessionNavigationMode:'bounded',sessionNavigationPending:'',sessionRecentLoaded:String(rows.length),sessionRecentTotal:String(rows.length),sessionPinnedLoaded:'0',sessionPinnedTotal:'0',sessionGroupsLoaded:'1',sessionGroupsTotal:'1'});
        root.setAttribute('aria-busy','false');
        root.innerHTML='<section class="recent-project" data-scope-id="personal"><span class="recent-project-name">Personal</span><span class="recent-project-count">'+rows.length+'</span><div class="recent-project-menu"><button data-menu-id="project:personal">Options</button></div>'+rows.map(row=>'<div class="session-row" data-session-id="'+row.id+'"><a class="session"><span class="tl">'+row.title+'</span></a></div>').join('')+'</section>';
        if(hiddenMode){
          const chat=document.querySelector('.custom-chat');
          chat.innerHTML=sessions.map((session,i)=>'<button role="tab" data-index="'+i+'">'+session.title+'</button><div data-pane-id="perf-pane-'+i+'" style="display:none">'+session.expectedVisibleText+'<textarea></textarea></div>').join('');
          const loaded=new Set(),controllers=new Map(),visible=new Set();
          const show=(i)=>{
            for(const old of [...visible]) if(Math.floor(old/2)===Math.floor(i/2)){
              void fetch('/modeled-hidden-phase',{method:'POST',body:JSON.stringify({hidden:old,loaded:loaded.has(old)})});
              controllers.get(old)?.abort();visible.delete(old);
              chat.querySelector('[data-pane-id="perf-pane-'+old+'"]').style.display='none';
            }
            visible.add(i);chat.querySelector('[data-pane-id="perf-pane-'+i+'"]').style.display='block';
            if(loaded.has(i)||mode==='hidden-omitted'&&i===0)return;
            const controller=new AbortController();controllers.set(i,controller);
            void fetch('/api/session-navigation/page',{method:'POST',signal:controller.signal,body:JSON.stringify({parentSessionId:sessions[i].sessionId,children:true,actionable:true})}).then(r=>r.json()).then(()=>loaded.add(i)).catch(()=>{});
          };
          for(const button of chat.querySelectorAll('[role="tab"]'))button.onclick=()=>show(Number(button.dataset.index));
          show(1);show(3);return;
        }
        if(mode==='legacy'||mode==='omitted')return;
        const data=await fetch('/api/session-navigation/page',{method:'POST',body:JSON.stringify({parentSessionId:mode==='stale'?'stale':parent,children:true,actionable:true})}).then(r=>r.json());
        if(!data.items.length)return;
        const activity=document.querySelector('#activity');
        activity.innerHTML='<section class="subagent-activity" data-parent-session-id="'+(mode==='wrong-render'?'old-parent':parent)+'" data-session-page-state="ready" data-loaded="'+data.items.length+'" data-total="'+data.total+'" aria-busy="false">'+(data.nextCursor?'<button data-session-page="subagents">Show more subagents</button>':'<div class="subagent-row waiting" data-session-id="private-child-0" data-depth="1"></div>')+'</section>';
        if(mode==='missing-more')activity.querySelector('[data-session-page]').remove();
        if(mode==='hidden-waiting')document.querySelector('.subagent-row').style.visibility='hidden';
        if(waitingModes.includes(mode)&&mode!=='missing-approvals'){
          const approvals=await fetch('/api/sessions/private-child-0/approvals').then(r=>r.json());
          await new Promise(r=>setTimeout(r,80));
          document.querySelector('.subagent-row').innerHTML=approvals.approvals.map(()=>'<div class="composer-approval">Modeled command<button class="approval-btn deny">Deny</button><button class="approval-btn">Allow once</button></div>').join('');
          const approval=document.querySelector('.composer-approval');

          if(mode==='hidden-approval')approval.style.display='none';
          if(mode==='no-controls')for(const button of approval.querySelectorAll('button'))button.remove();
          if(mode==='aria-disabled')for(const button of approval.querySelectorAll('button'))button.setAttribute('aria-disabled','true');
          if(mode==='hidden-controls')for(const button of approval.querySelectorAll('button'))button.style.visibility='hidden';
          if(mode==='missing-deny')approval.querySelector('.deny').remove();
        }
      })();
    </script>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.closeAllConnections());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const oldExitCode = process.exitCode;
    try {
      for (mode of [
        "waiting",
        "empty",
        "more",
        "legacy",
        "omitted",
        "malformed",
        "stale",
        "missing-approvals",
        "wrong-render",
        "missing-more",
        "hidden",
        "hidden-omitted",
        "waiting-zero",
        "hidden-approval",
        "no-controls",
        "aria-disabled",
        "hidden-controls",
        "missing-deny",
        "hidden-waiting",
        "hung-page",
        "hung-approvals",
      ]) {
        const directory = join(output, mode);
        hiddenPhases.length = 0;
        await mkdir(directory);
        const sidebarProfile = { transport: mode === "legacy" ? "legacy-get" : "navigation-post", sourceRevision };
        const fixture = {
          fixtureId: "modeled-actionable-only",
          profileSha256: sha256("[]"),
          cases: { short: { principalId: actor, sessionId: parent, expectedVisibleText: "Visible transcript" } },
          browser: {
            ...(hiddenMode() ? { multiview: sessions, maxPanels: 4, visibleGroups: 2 } : {}),
            sidebarReadiness: {
              schemaVersion: 1,
              ...sidebarProfile,
              actors: {
                [actor]: {
                  surface: "web",
                  recent: { total: rows().length, allRows: rows() },
                  pinned: { total: 0, rows: [], hasMore: false },
                  groups: {
                    total: 1,
                    items: [{ ...group, count: rows().length }],
                    hasMore: false,
                    dynamicOrderScopes: [],
                  },
                  archivedCount: 0,
                  allowedOffPageRows: rows(),
                },
              },
            },
          },
        };
        await writeFile(join(directory, "fixture.json"), JSON.stringify(fixture));
        await writeFile(join(directory, "profiles.json"), "[]");
        await writeFile(
          join(directory, "config.json"),
          JSON.stringify({
            baseUrl,
            isolated: true,
            mode: "diagnostic",
            loadCondition: "normal",
            samples: 1,
            sourceRevision,
            sidebarProfile,
            fixturePath: "fixture.json",
            profilePath: "profiles.json",
            outDir: "result",
            localAuthPrincipal: actor,
            filter: hiddenMode() ? "^web.multiview.hidden-return$" : "^web.chat.short$",
            cacheFilter: hiddenMode() ? "warm" : "cold",
            timeoutMs: 900,
            browser: {
              viewport: { width: 1000, height: 800 },
              cpuThrottleRate: 1,
              network: { latencyMs: 0, downloadBytesPerSecond: 10000000, uploadBytesPerSecond: 10000000 },
            },
          }),
        );
        const runStarted = performance.now();
        await run(join(directory, "config.json"));
        const runElapsedMs = performance.now() - runStarted;
        const sample = JSON.parse((await readFile(join(directory, "result/samples.jsonl"), "utf8")).trim());
        const summary = JSON.parse(await readFile(join(directory, "result/summary.json"), "utf8"));
        assert.equal(summary.qualified, false);
        const nativeRun = JSON.parse(await readFile(join(directory, "result/run.json"), "utf8"));
        t.diagnostic(
          JSON.stringify({
            kind: "modeled-actionable-browser",
            mode,
            browserVersion: nativeRun.browserVersion,
            status: sample.status,
            durationMs: sample.durationMs,
            actionable: sample.actionable,
            requests: sample.requests,
            errors: sample.errors,
            runElapsedMs,
            hungSocketClosed: hungClosed.has(mode),
            qualified: false,
          }),
        );
        const succeeds = ["waiting", "waiting-zero", "empty", "more", "legacy", "hidden"].includes(mode);
        assert.equal(
          sample.status,
          succeeds ? "pass" : "failed",
          `${mode}: ${sample.error?.stack ?? sample.error?.message}`,
        );
        if (mode === "hidden") {
          assert.ok(hiddenPhases.some((entry) => entry.hidden === 0 && entry.loaded));
          assert.ok(
            hiddenPhases.every((entry) => entry.loaded),
            JSON.stringify(hiddenPhases),
          );
          assert.equal(sample.preparation.requests.filter((entry) => entry.actionablePage).length, 3);
          assert.equal(sample.requests.filter((entry) => entry.actionablePage).length, 0);
          assert.deepEqual(
            sample.actionable.map((entry) => entry.parentSha256),
            [sha256("pane-0"), sha256("pane-3")],
          );
        }
        if (mode === "hidden-omitted")
          assert.equal(
            hiddenPhases.some((entry) => entry.hidden === 0),
            false,
          );
        if (mode === "hung-page" || mode === "hung-approvals") {
          assert.ok(runElapsedMs < 5000, `Hung response finalization took ${runElapsedMs}ms`);
          assert.ok(hungClosed.has(mode), "Owned context did not close held response");
          assert.ok(sample.errors.some((entry) => entry.type === "observer-timeout" && entry.pendingObservations > 0));
          assert.ok(sample.requests.some((entry) => entry.status === 200 && !entry.completed));
        }
        if (mode === "waiting-zero")
          assert.deepEqual(sample.actionable[0].waiting, [{ idSha256: sha256("private-child-0"), count: 0 }]);
        if (mode === "waiting") {
          assert.ok(sample.durationMs >= 470, `Approval response/render excluded: ${sample.durationMs}`);
          assert.deepEqual(sample.actionable[0].waiting, [{ idSha256: sha256("private-child-0"), count: 1 }]);
        }
        if (mode === "empty") {
          assert.ok(sample.durationMs >= 170);
          assert.equal(sample.actionable[0].loaded, 0);
        }
        if (mode === "more") assert.equal(sample.actionable[0].loaded, 50);
        if (mode === "legacy") {
          assert.deepEqual(sample.actionable, []);
          assert.equal(
            sample.requests.some((entry) => entry.path === "/api/session-navigation/page"),
            false,
          );
        }
      }
    } finally {
      process.exitCode = oldExitCode;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(output, { recursive: true, force: true });
    }
  },
);
