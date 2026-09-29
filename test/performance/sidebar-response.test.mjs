import assert from "node:assert/strict";
import test from "node:test";
import { sidebarFormatter, sidebarSurface } from "./sidebar-format.mjs";
import { model, nav, sha, page, addPrepared, actionable, profile, captured } from "./sidebar-test-model.mjs";
import { projectSidebarResponse } from "./sidebar-response.mjs";
const project = (m, data = nav(m), input = { surface: "web" }, extra = {}) =>
  projectSidebarResponse({
    ...m.facts,
    ...captured(data),
    request: { method: "POST", path: "/api/session-navigation", body: input },
    ...extra,
  });
const reject = (m, mutate, input = { surface: "web" }) => {
  const data = structuredClone(nav(m, input));
  mutate(data);
  assert.throws(() => project(m, data, input));
};
const legacy = (m, rows = m.rows, surface = "all", contextProjection) =>
  projectSidebarResponse({
    ...m.facts,
    ...captured({ sessions: rows }),
    request: { method: "GET", path: "/api/sessions" },
    legacySurface: surface,
    contextProjection:
      contextProjection ??
      projectSidebarResponse({
        ...m.facts,
        ...captured({ contexts: m.contexts }),
        request: { method: "GET", path: "/api/contexts" },
      }),
  });

test("candidate web/all pages, pins, archives, groups and historical child reference", () => {
  const m = model();
  for (const surface of ["web", "all"]) {
    const input = {
      surface,
      references: [
        { kind: "id", value: "child" },
        { kind: "thread", value: "unknown" },
      ],
    };
    const data = nav(m, input);
    const result = project(m, data, input);
    assert.equal(result.qualified, false);
    assert.equal(result.references[0].row.parentSessionId, "web-000");
    assert.equal(result.references[1].id, null);
    assert.equal(result.sections.pinned.rows.length, 50);
    assert.equal(result.sections.groups.rows.length, 50);
    for (const section of ["recent", "pinned", "groups"]) {
      const nextInput = { surface, section, cursor: data[section].nextCursor };
      const next = project(m, nav(m, nextInput), nextInput, { previous: result });
      assert.ok(next.sections[section].rows.length > 0);
    }
    const archives = project(m, nav(m, { surface, section: "archived" }), { surface, section: "archived" });
    assert.equal(archives.sections.archived.rows.length, 50);
    assert.equal(archives.archivedCount, 53);
    assert.ok(!archives.sections.recent.rows.some((row) => row.id === "child"));
  }
});
test("immutable web/static rows reject omissions, flags, labels, identity, order and totals", () => {
  const m = model();
  const mutations = [
    (d) => d.recent.items.pop(),
    (d) => d.recent.items.reverse(),
    (d) => d.recent.items.push(d.recent.items[0]),
    (d) => (d.recent.items[0].id = "fabricated"),
    (d) => (d.recent.items[0].title = "wrong"),
    (d) => (d.recent.items[0].scopeId = "channel:new"),
    (d) => d.recent.items[0].createdAt++,
    (d) => (d.recent.items[0].parentSessionId = "elsewhere"),
    (d) => (d.recent.items[0].pinned = true),
    (d) => d.recent.items[0].lastActivityAt++,
    (d) => (d.recent.items[0].threadRef += "x"),
    (d) => d.recent.total++,
    (d) => d.pinned.total++,
    (d) => d.archivedCount++,
    (d) => d.groups.total++,
    (d) => (d.recent.extra = "unknown"),
    (d) => (d.recent.items[0].newAuthority = true),
    (d) => (d.recent.nextCursor = null),
    (d) => d.groups.items[0].count++,
    (d) => (d.groups.items[0].name = "forged"),
    (d) => (d.startup.hasNonCronSessions = false),
    (d) => (d.startup.oldestPersonalThreadRef = null),
    (d) => (d.contexts[0].name = "forged"),
    (d) => d.statusTotals.archived++,
  ];
  for (const change of mutations) reject(m, change);
});
test("known unwritten same-scope nonweb cannot mutate despite coarse mutableFields", () => {
  const m = model();
  const input = { surface: "all", references: [{ kind: "id", value: "unwritten" }] };
  reject(m, (d) => (d.references[0].session.title = "changed"), input);
  reject(m, (d) => d.references[0].session.lastActivityAt++, input);
  const rows = structuredClone(m.rows);
  Object.assign(
    rows.find((row) => row.id === "slack"),
    { title: "New exact written title", lastActivityAt: 2000 },
  );
  const projected = project(m, nav(m, { surface: "all" }, rows), { surface: "all" });
  assert.equal(projected.sections.recent.rows[0].id, "slack");
});
test("new recurrence roots remain provisional; scope/prefix alone cannot admit unknown roots", () => {
  const m = model();
  const fresh = m.row("new", { threadRef: "cron:definition:fire:123456789abc", lastActivityAt: 2200 });
  const result = project(m, nav(m, { surface: "all" }, [...m.rows, fresh]), { surface: "all" });
  assert.equal(result.unresolved[0].identityMapping.kind, "unresolved-recurring");
  assert.equal(result.unresolved[0].pinned, false);
  assert.equal(result.qualified, false);
  for (const patch of [
    { threadRef: "cron:definition:item:any" },
    { threadRef: "cron:definition:fire:not-a-hash" },
    { threadRef: "web:actor:new" },
    { pinned: true },
    { archived: true },
    { scopeId: "project:001" },
  ])
    assert.throws(() =>
      project(m, nav(m, { surface: "all" }, [...m.rows, { ...fresh, ...patch }]), { surface: "all" }),
    );
});
test("new channel group is checked by admitted context, observed root and native missing gate", () => {
  const m = model();
  const fresh = m.row("channel-new", {
    threadRef: "cron:channel:fire:123456789abc",
    scopeId: "channel:new",
    lastActivityAt: 2200,
  });
  const result = project(m, nav(m, { surface: "all" }, [...m.rows, fresh]), { surface: "all" });
  assert.equal(result.sections.groups.rows[0].scopeId, "channel:new");
  assert.equal(result.sections.groups.rows[0].count, 1);
});
test("new descendants retain exact facts with ancestry or explicit unsupported gate", () => {
  const m = model();
  const fresh = m.row("new-root", { threadRef: "cron:definition:fire:123456789abc", lastActivityAt: 2000 });
  const child = m.row("new-child", {
    threadRef: "agent:main:subagent:new",
    parentSessionId: fresh.id,
    lastActivityAt: 2100,
  });
  const input = { surface: "all", references: [{ kind: "id", value: child.id }] };
  const result = project(m, nav(m, input, [...m.rows, fresh, child]), input);
  assert.equal(result.unresolved.find((row) => row.id === child.id).identityMapping.kind, "unresolved-descendant");
  assert.ok(!result.sections.recent.rows.some((row) => row.id === child.id));
  const unseen = { ...child, parentSessionId: "not-returned" };
  const unsupported = project(m, nav(m, input, [...m.rows, unseen]), input);
  assert.equal(unsupported.unresolved[0].parentSessionId, "not-returned");
  assert.ok(unsupported.missing.some((message) => message.includes("Unsupported")));
  assert.throws(() => project(m, nav(m, input, [...m.rows, { ...child, scopeId: "project:001" }]), input));
});
test("request/cursor/reference caps, chain hashes, filter identity and boundary are enforced", () => {
  const m = model();
  const first = nav(m);
  const proof = project(m, first);
  const input = { surface: "web", section: "recent", cursor: first.recent.nextCursor };
  assert.throws(() => project(m, nav(m, input), input));
  assert.throws(() =>
    project(m, nav(m, { ...input, surface: "all" }), { ...input, surface: "all" }, { previous: proof }),
  );
  assert.throws(() => project(m, nav(m, input), input, { previous: { ...proof, principalId: "other" } }));
  const wrong = structuredClone(proof);
  wrong.sections.recent.boundary.at++;
  assert.throws(() => project(m, nav(m, input), input, { previous: wrong }));
  reject(m, (d) =>
    d.references.push({ reference: { kind: "id", value: "child" }, session: m.rows.find((row) => row.id === "child") }),
  );
  assert.throws(() =>
    project(m, first, {
      surface: "web",
      references: Array.from({ length: 13 }, () => ({ kind: "id", value: "child" })),
    }),
  );
  reject(m, (d) => (d.references[0].session = null), { surface: "web", references: [{ kind: "id", value: "child" }] });
});
test("literal whitespace display hashes retain NBSP and exact formatter results", () => {
  const f = sidebarFormatter([{ scopeId: "project:p", project: { name: "Project" } }], profile());
  assert.equal(
    f.labeled({
      id: "x",
      scopeId: "personal:a",
      threadRef: "ch:x",
      type: "group",
      channelName: "mpdm-amy-smith--bob-2",
    }).title,
    "2 amy smith, bob",
  );
  assert.equal(f.labeled({ id: "x", scopeId: "project:p", threadRef: "web:a:x", type: "dm" }).title, "Project");
  const m = model();
  const row = m.rows[0];
  row.title = "A\t  B\u00a0C";
  const prepared = m.facts.commonActor.preparedWeb.find((value) => value.id === row.id);
  prepared.title = row.title;
  prepared.groupedTitle = row.title;
  assert.equal(project(m).sections.recent.rows[0].titleSha256, sha("A B\u00a0C"));
});
test("legacy full population stays complete beyond 50, roots exclude historical children and ties retain incoming rank", () => {
  const m = model("legacy-get");
  for (const surface of ["web", "all"]) {
    const result = legacy(m, m.rows, surface);
    assert.ok(result.sections.recent.rows.length > 50);
    assert.equal(result.sections.pinned.rows.length, 55);
    assert.equal(result.sections.archived.rows.length, 53);
    assert.ok(!result.sections.recent.rows.some((row) => row.id === "child"));
  }
  assert.throws(() =>
    legacy(
      m,
      m.rows.filter((row) => row.id !== "child"),
    ),
  );
  const swapped = [...m.rows];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(() => legacy(m, swapped));
  const mixed = [...m.rows];
  [mixed[0], mixed[8]] = [mixed[8], mixed[0]];
  assert.throws(() => legacy(m, mixed));
});
test("legacy contexts are actual joined data, with dynamic empty fallback and static refusal", () => {
  const m = model("legacy-get");
  const actual = structuredClone(m.contexts);
  actual.find((row) => row.scopeId === "channel:new").lastActivityAt = 8000;
  const proof = projectSidebarResponse({
    ...m.facts,
    ...captured({ contexts: actual }),
    request: { method: "GET", path: "/api/contexts" },
  });
  assert.equal(legacy(m, m.rows, "web", proof).contextResponseSha256, proof.responseBodySha256);
  actual.find((row) => row.scopeId === "project:001").lastActivityAt++;
  assert.throws(() =>
    projectSidebarResponse({
      ...m.facts,
      ...captured({ contexts: actual }),
      request: { method: "GET", path: "/api/contexts" },
    }),
  );
  assert.throws(() => legacy(m, m.rows, "web", { ...proof, principalId: "other" }));
});
test("generic bounded root/children page uses full filter key; unsupported independent filter evidence refuses", () => {
  const m = model();
  const input = { surface: "web", pinned: true, children: true };
  const key = JSON.stringify(["web", null, null, "", null, true, null, true, null]);
  const selected = page(
    m.rows.filter((row) => row.pinned && m.formatter.isWeb(row)),
    key,
  );
  const scopes = new Set(selected.items.map((row) => row.scopeId));
  const data = {
    ...selected,
    contexts: m.contexts.filter((row) => scopes.has(row.scopeId)),
    statusTotals: nav(m).statusTotals,
  };
  const options = {
    ...m.facts,
    ...captured(data),
    request: { method: "POST", path: "/api/session-navigation/page", body: input },
  };
  assert.equal(projectSidebarResponse(options).sections.page.rows.length, 50);
  for (const body of [
    { ...input, title: "x" },
    { ...input, query: "x" },
    { ...input, status: "active" },
    { ...input, parentSessionId: "web-000" },
  ])
    assert.throws(() => projectSidebarResponse({ ...options, request: { ...options.request, body } }));
});
test("single captured response descriptor refuses oversized/absent bytes, bad digest and unknown root properties", () => {
  const m = model();
  const options = {
    ...m.facts,
    ...captured(nav(m)),
    request: { method: "POST", path: "/api/session-navigation", body: { surface: "web" } },
  };
  for (const bytes of [0, -1, 4194305, NaN])
    assert.throws(() => projectSidebarResponse({ ...options, responseBody: { ...options.responseBody, bytes } }));
  assert.throws(() => projectSidebarResponse({ ...options, responseBody: { bytes: 2, sha256: "bad" } }));
  reject(m, (d) => (d.override = true));
  const emptyBody = Buffer.from([0xff]);
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(emptyBody));
});
test("empty web group can change fallback only in the admitted write closure", () => {
  const m = model();
  const remove = new Set(
    m.rows
      .filter((row) => !row.pinned && !row.archived && row.scopeId === "personal:actor" && m.formatter.isWeb(row))
      .map((row) => row.id),
  );
  m.rows = m.rows.filter((row) => !remove.has(row.id));
  m.facts.commonActor.preparedWeb = m.facts.commonActor.preparedWeb.filter((row) => !remove.has(row.id));
  m.facts.commonActor.preparedOffPageWeb = [];
  m.facts.dynamicActor.allowedOffPageRows = [];
  m.contexts.find((row) => row.scopeId === "personal:actor").lastActivityAt = 5000;
  const result = project(m);
  assert.equal(result.sections.groups.rows[0].scopeId, "personal:actor");
  assert.equal(result.sections.groups.rows[0].count, 0);
  assert.equal(result.sections.groups.rows[0].at, 5000);
  const data = nav(m);
  data.groups.items.find((row) => row.scopeId === "project:001").lastActivityAt++;
  assert.throws(() => project(m, data));
});
test("full legacy contexts accept actual ProjectView roster fields but omit them from retained data", () => {
  const m = model("legacy-get");
  const contexts = structuredClone(m.contexts);
  const project = contexts.find((row) => row.project).project;
  Object.assign(project, {
    orgId: "org",
    memberIds: ["actor"],
    members: [{ principalId: "actor", displayName: "Actor" }],
    scopeId: "project:001",
    channelMemberIds: [],
    slackChannel: { channelId: "C1", channelName: "shared" },
  });
  const result = projectSidebarResponse({
    ...m.facts,
    ...captured({ contexts }),
    request: { method: "GET", path: "/api/contexts" },
  });
  assert.ok(!JSON.stringify(result).includes("displayName"));
  assert.doesNotThrow(() => legacy(m, m.rows, "all", result));
});
test("modeled 2254-session full response stays bounded and is not silently truncated to a candidate page", () => {
  const m = model("legacy-get", 2143);
  assert.equal(m.rows.length, 2254);
  const result = legacy(m);
  assert.equal(
    result.sections.recent.rows.length + result.sections.pinned.rows.length + result.sections.archived.rows.length,
    2253,
  );
  assert.equal(result.sections.pinned.rows.length, 55);
  assert.ok(result.bodyBytes < 4194304 && Buffer.byteLength(JSON.stringify(result)) < 4194304);
  console.log(
    "MODELED_2254_SIZES",
    JSON.stringify({
      rawBodyBytes: result.bodyBytes,
      metadataBytes: Buffer.byteLength(JSON.stringify(m.facts)),
      projectionBytes: Buffer.byteLength(JSON.stringify(result)),
    }),
  );
});
test("one independent surface rule preserves historical explicit slack/cron/loop/default/web children", () => {
  const m = model("legacy-get");
  for (const surface of ["slack", "cron", "loop", "web", undefined, ""]) {
    const row = m.row(`child-${surface ?? "none"}`, {
      parentSessionId: "web-000",
      threadRef: `agent:main:subagent:${surface ?? "none"}`,
      ...(surface === undefined ? {} : { surface }),
    });
    const expected = surface || "core";
    assert.equal(sidebarSurface(row), expected);
    const value = {
      ...m.formatter.labeled(row),
      threadRef: row.threadRef,
      createdAt: row.createdAt,
      at: row.lastActivityAt,
      legacyRank: m.rows.length,
      archived: false,
      pinned: false,
      parentSessionId: "web-000",
      type: "dm",
      channelName: null,
      surface: expected,
    };
    m.rows.push(row);
    (expected === "web" ? m.facts.commonActor.preparedWeb : m.facts.dynamicActor.preparedNonWeb).push(value);
  }
  assert.doesNotThrow(() => legacy(m));
  const p = model();
  for (const [id, value] of [
    ["web-000", "Z"],
    ["web-001", "a"],
    ["web-002", "\uffff"],
  ]) {
    p.rows.find((row) => row.id === id).id = value;
    p.facts.commonActor.preparedWeb.find((row) => row.id === id).id = value;
  }
  assert.deepEqual(
    project(p)
      .sections.recent.rows.slice(0, 3)
      .map((row) => row.id),
    ["Z", "a", "\uffff"],
  );
});

function dropPrepared(m, ids) {
  m.rows = m.rows.filter((row) => !ids.has(row.id));
  for (const [owner, field] of [
    [m.facts.commonActor, "preparedWeb"],
    [m.facts.commonActor, "preparedOffPageWeb"],
    [m.facts.dynamicActor, "preparedNonWeb"],
    [m.facts.dynamicActor, "allowedOffPageRows"],
  ])
    owner[field] = owner[field].filter((row) => !ids.has(row.id));
}
test("historical family permission requires exact direct or approved-ask writes", async () => {
  const m = model();
  const source = m.rows.find((row) => row.id === "unwritten");
  source.threadRef = "cron:definition:fire:000000000000";
  const prepared = m.facts.dynamicActor.preparedNonWeb.find((row) => row.id === source.id);
  prepared.threadRef = source.threadRef;
  prepared.mutableFields = [];
  const input = { surface: "all", references: [{ kind: "id", value: source.id }] };
  for (const patch of [{ title: "Changed old title" }, { lastActivityAt: 2500 }]) {
    const rows = structuredClone(m.rows);
    Object.assign(
      rows.find((row) => row.id === source.id),
      patch,
    );
    const options = {
      ...m.facts,
      ...captured(nav(m, input, rows)),
      request: { method: "POST", path: "/api/session-navigation", body: input },
    };
    assert.throws(() => projectSidebarResponse(options), /Static/);
  }
  const rows = structuredClone(m.rows);
  Object.assign(
    rows.find((row) => row.id === source.id),
    { title: "Exact approved ask", lastActivityAt: 2500 },
  );
  m.facts.dynamicActor.scopePolicy
    .find((row) => row.scopeId === source.scopeId)
    .writeEvidence.push({ kind: "approved-ask", id: "ask", sessionId: source.id, threadRef: source.threadRef });
  assert.doesNotThrow(() => project(m, nav(m, input, rows), input));
});
test("immutable terminal cursors reject spurious recent, pinned and archived continuation at 50 and 100", async () => {
  for (const section of ["recent", "pinned", "archived"])
    for (const total of [50, 100]) {
      const m = model("navigation-post", section === "recent" ? total : 115);
      if (section !== "recent") {
        const selected = m.rows.filter((row) => (section === "pinned" ? row.pinned : row.archived));
        if (selected.length > total) dropPrepared(m, new Set(selected.slice(total).map((row) => row.id)));
        else
          for (let i = selected.length; i < total; i++)
            addPrepared(
              m,
              m.row(`zz-${section}-${i}`, {
                [section === "pinned" ? "pinned" : "archived"]: true,
                lastActivityAt: 400 - i,
              }),
            );
      }
      const firstInput = { surface: "web", ...(section === "archived" ? { section } : {}) };
      const first = nav(m, firstInput);
      const initial = project(m, first, firstInput);
      const input = total === 50 ? firstInput : { surface: "web", section, cursor: first[section].nextCursor };
      const data = total === 50 ? first : nav(m, input);
      const last = data[section].items.at(-1);
      assert.equal(data[section].items.length, 50);
      assert.equal(data[section].nextCursor, null);
      data[section].nextCursor = Buffer.from(
        JSON.stringify({ key: JSON.stringify([section, "web"]), at: last.lastActivityAt, id: last.id }),
      ).toString("base64url");
      const options = {
        ...m.facts,
        ...captured(data),
        request: { method: "POST", path: "/api/session-navigation", body: input },
        ...(total === 100 ? { previous: initial } : {}),
      };
      assert.throws(() => projectSidebarResponse(options), /Immutable page continuation/);
    }
});
test("exact immutable group exhaustion refuses spurious More, while dynamic all-surface exhaustion stays unproved", async () => {
  const m = model();
  const scopes = new Set(m.contexts.slice(0, 50).map((row) => row.scopeId));
  dropPrepared(m, new Set(m.rows.filter((row) => !scopes.has(row.scopeId)).map((row) => row.id)));
  m.contexts = m.contexts.filter((row) => scopes.has(row.scopeId));
  m.facts.commonActor.contexts = m.facts.commonActor.contexts.filter((row) => scopes.has(row.scopeId));
  m.facts.dynamicActor.contexts = m.facts.dynamicActor.contexts.filter((row) => scopes.has(row.scopeId));
  m.facts.dynamicActor.scopePolicy = m.facts.dynamicActor.scopePolicy.filter((row) => scopes.has(row.scopeId));
  m.facts.dynamicActor.recurring = m.facts.dynamicActor.recurring.filter((row) => scopes.has(row.scopeId));
  const data = nav(m);
  assert.equal(data.groups.total, 50);
  const last = data.groups.items.at(-1);
  data.groups.nextCursor = Buffer.from(
    JSON.stringify({ key: JSON.stringify(["groups", "web"]), at: last.lastActivityAt, id: last.scopeId }),
  ).toString("base64url");
  const options = {
    ...m.facts,
    ...captured(data),
    request: { method: "POST", path: "/api/session-navigation", body: { surface: "web" } },
  };
  assert.throws(() => projectSidebarResponse(options), /Immutable group continuation/);
  const dynamic = model("navigation-post", 98);
  const first = nav(dynamic, { surface: "all" });
  const previous = project(dynamic, first, { surface: "all" });
  const input = { surface: "all", section: "recent", cursor: first.recent.nextCursor };
  const second = nav(dynamic, input);
  const end = second.recent.items.at(-1);
  second.recent.nextCursor = Buffer.from(
    JSON.stringify({ key: JSON.stringify(["recent", "all"]), at: end.lastActivityAt, id: end.id }),
  ).toString("base64url");
  assert.equal(project(dynamic, second, input, { previous }).qualified, false);
});
test("actionable historical direct and deep children prove actual parent chains without requiring intermediate rows on page", () => {
  const m = model();
  const child = { ...m.rows.find((row) => row.id === "child"), lastTurnFailed: true };
  const middle = addPrepared(
    m,
    m.row("middle", {
      threadRef: "agent:main:subagent:middle",
      surface: "web",
      parentSessionId: "child",
      lastActivityAt: 600,
    }),
  );
  const deep = addPrepared(
    m,
    m.row("deep", {
      threadRef: "agent:main:subagent:deep",
      surface: "web",
      parentSessionId: middle.id,
      lastActivityAt: 500,
      awaitingInput: true,
    }),
  );
  const result = actionable(m, [child, deep], "web-000", { depths: { child: 1, deep: 3 } }).project();
  assert.deepEqual(
    result.actionable.ancestry.map((row) => [row.id, row.depth, row.status]),
    [
      ["child", 1, "observed-chain"],
      ["deep", 3, "observed-chain"],
    ],
  );
  assert.equal(result.actionable.parentIdentity.id, "web-000");
  assert.equal(result.actionable.parentSubagents.waiting, 1);
  assert.equal(result.qualified, false);
  const bad = actionable(m, [child, deep], "web-000", { depths: { child: 1, deep: 2 } });
  assert.throws(() => bad.project(), /depth/);
});
test("actionable parent proof rejects another valid family child and immutable parent forgery", () => {
  const m = model();
  const rootA = addPrepared(
    m,
    m.row("family-a", { threadRef: "cron:definition:fire:000000000000", lastActivityAt: 400 }),
  );
  const rootB = addPrepared(
    m,
    m.row("family-b", { threadRef: "cron:channel:fire:000000000000", scopeId: "channel:new", lastActivityAt: 400 }),
  );
  const childB = addPrepared(
    m,
    m.row("family-b-child", {
      threadRef: "agent:main:subagent:b",
      parentSessionId: rootB.id,
      scopeId: rootB.scopeId,
      lastActivityAt: 300,
      working: true,
    }),
  );
  assert.doesNotThrow(() => actionable(m, [childB], rootB.id).project());
  assert.throws(() => actionable(m, [childB], rootA.id).project(), /another root\/family/);
  assert.throws(() => actionable(m, [{ ...childB, parentSessionId: rootA.id }], rootA.id).project(), /identity\/flags/);
  const bodyMismatch = actionable(m, [childB], rootB.id);
  bodyMismatch.data.actionable.parentSessionId = rootA.id;
  assert.throws(() => bodyMismatch.project(), /parent differs/);
});
test("new actionable child identities retain mandatory native mapping, and unobserved intermediate ancestry stays unsupported", () => {
  const m = model();
  const parent = addPrepared(
    m,
    m.row("family-parent", { threadRef: "cron:definition:fire:000000000000", lastActivityAt: 400 }),
  );
  const direct = m.row("new-actionable", {
    threadRef: "agent:main:subagent:new-actionable",
    parentSessionId: parent.id,
    lastActivityAt: 500,
    working: true,
  });
  const actual = actionable(m, [direct], parent.id).project();
  assert.equal(actual.unresolved[0].identityMapping.kind, "unresolved-descendant");
  assert.equal(actual.unresolved[0].threadRef, direct.threadRef);
  assert.equal(actual.unresolved[0].pinned, false);
  const unknown = {
    ...direct,
    id: "new-deep",
    threadRef: "agent:main:subagent:new-deep",
    parentSessionId: "unobserved-middle",
  };
  const result = actionable(m, [unknown], parent.id, { depths: { "new-deep": 4 } }).project();
  assert.equal(result.actionable.ancestry[0].status, "unsupported-missing-ancestor");
  assert.equal(result.actionable.ancestry[0].missingParentSessionId, "unobserved-middle");
  assert.ok(result.missing.some((value) => value.includes("Unsupported actionable")));
  assert.equal(result.unresolved[0].identityMapping.kind, "unsupported-descendant");
  assert.throws(() => actionable(m, [unknown], parent.id).project(), /shallow/);
  assert.throws(() => actionable(m, [{ ...direct, scopeId: "project:001" }], parent.id).project(), /write closure/);
  const empty = actionable(m, [], "unknown-parent", { summary: null }).project();
  assert.equal(empty.actionable.parentIdentity, null);
  assert.ok(empty.missing.some((value) => value.includes("parent identity absent")));
});
test("actionable cap/cursor/parent/filter/state/summary gates preserve 50-row continuation and truthful null", () => {
  const m = model();
  const rows = Array.from({ length: 51 }, (_, i) =>
    addPrepared(
      m,
      m.row(`old-action-${String(i).padStart(3, "0")}`, {
        threadRef: `agent:main:subagent:old-action-${i}`,
        surface: "web",
        parentSessionId: "web-000",
        lastActivityAt: 300 - i,
        working: i % 2 === 0,
        awaitingInput: i % 2 !== 0,
      }),
    ),
  );
  const first = actionable(m, rows);
  const previous = first.project();
  assert.equal(previous.sections.page.rows.length, 50);
  const next = actionable(m, rows, "web-000", { input: { cursor: first.data.nextCursor }, previous });
  assert.equal(next.project().sections.page.rows.length, 1);
  assert.throws(
    () => actionable(m, rows, "web-001", { input: { cursor: first.data.nextCursor }, previous }).project(),
    /Cursor filter key/,
  );
  for (const patch of [
    { children: false },
    { parentSessionId: "" },
    { actionable: false },
    { query: "x" },
    { title: "x" },
    { status: "active" },
  ]) {
    const arm = actionable(m, rows);
    Object.assign(arm.input, patch);
    assert.throws(() => arm.project());
  }
  const badState = actionable(m, [{ ...rows[0], working: false }]);
  assert.throws(() => badState.project(), /Non-actionable/);
  assert.throws(() => actionable(m, [rows[0]], "web-000", { summary: { running: 0, waiting: 0 } }).project());
  assert.throws(() => actionable(m, [], "web-000", { summary: null }).project(), /authorized parent/);
  assert.doesNotThrow(() => actionable(m, [], "web-000", { summary: { running: 0, waiting: 0 } }).project());
});
test("immutable second group page at 100 refuses a terminal token and new wrong-family children cannot satisfy another parent", async () => {
  const m = model();
  for (let i = 0; i < 38; i++) {
    const context = {
      scopeId: `project:extra-${String(i).padStart(2, "0")}`,
      kind: "personal",
      name: null,
      sessionCount: 1,
      lastActivityAt: 20,
      project: { id: `extra-${i}`, name: `Extra ${i}`, ownerId: "actor", createdAt: 1, updatedAt: 2 },
    };
    m.contexts.push(context);
    const stable = {
      scopeId: context.scopeId,
      kind: context.kind,
      name: null,
      project: { id: context.project.id, name: context.project.name },
    };
    m.facts.commonActor.contexts.push(stable);
    m.facts.dynamicActor.contexts.push({ ...stable, fallbackActivity: 20 });
    m.facts.dynamicActor.scopePolicy.push({ scopeId: context.scopeId, mode: "static-disjoint", writeEvidence: [] });
    addPrepared(m, m.row(`zz-extra-group-${i}`, { scopeId: context.scopeId, lastActivityAt: 20 }));
  }
  m.facts.commonActor.contexts.sort((a, b) => (a.scopeId < b.scopeId ? -1 : 1));
  m.facts.dynamicActor.contexts.sort((a, b) => (a.scopeId < b.scopeId ? -1 : 1));
  const first = nav(m);
  assert.equal(first.groups.total, 100);
  const previous = project(m, first);
  const input = { surface: "web", section: "groups", cursor: first.groups.nextCursor };
  const data = nav(m, input);
  assert.equal(data.groups.items.length, 50);
  assert.equal(data.groups.nextCursor, null);
  const end = data.groups.items.at(-1);
  data.groups.nextCursor = Buffer.from(
    JSON.stringify({ key: JSON.stringify(["groups", "web"]), at: end.lastActivityAt, id: end.scopeId }),
  ).toString("base64url");
  const options = {
    ...m.facts,
    ...captured(data),
    request: { method: "POST", path: "/api/session-navigation", body: input },
    previous,
  };
  assert.throws(() => projectSidebarResponse(options), /Immutable group continuation/);
  const parent = addPrepared(
    m,
    m.row("other-family", { threadRef: "cron:channel:fire:000000000000", scopeId: "channel:new", lastActivityAt: 10 }),
  );
  const child = m.row("new-other-family", {
    threadRef: "agent:main:subagent:new-other-family",
    parentSessionId: parent.id,
    scopeId: parent.scopeId,
    lastActivityAt: 50,
    working: true,
  });
  assert.equal(actionable(m, [child], parent.id).project().unresolved[0].identityMapping.definitionId, "channel");
  assert.throws(() => actionable(m, [child], "web-000").project(), /another root\/family/);
});
