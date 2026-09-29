import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSessionReferences,
  projectSessionNavigation,
  projectSessionPage,
  validateNavigationCursor,
  validateSessionPageCursor,
} from "../src/api/session-navigation.ts";
import {
  activityOf,
  chatBrowseStatusMatches,
  chatMatches,
  surfaceOf,
  type SessionPageRequest,
  type SessionNavigationRequest,
} from "../plugins/chassis/src/session-navigation.ts";
import type { ContextSummary } from "../src/api/app-types.ts";
import type { Session } from "../src/types.ts";

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  threadRef: `web:U1:${id}`,
  scopeId: "personal:U1",
  type: "dm",
  createdAt: 10,
  title: id,
  ...patch,
});
const context: ContextSummary = {
  scopeId: "personal:U1",
  kind: "personal",
  name: null,
  sessionCount: 0,
  lastActivityAt: null,
};
const undecorated = (rows: Session[]) => rows.map(({ subagents: _subagents, ...row }) => row);
const order = (rows: Session[]) =>
  [...rows].sort((a, b) => activityOf(b) - activityOf(a) || (a.id < b.id ? -1 : Number(a.id !== b.id)));

function allPages(rows: Session[], contexts: ContextSummary[], request: SessionPageRequest): Session[] {
  const result: Session[] = [];
  let cursor: string | undefined;
  do {
    const page = projectSessionPage(rows, contexts, { ...request, cursor });
    assert.ok(page.items.length <= 50);
    result.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}

test("session pages cover every matching row with deterministic ties and independent status totals", () => {
  const rows = Array.from({ length: 213 }, (_, i) =>
    session(String(i).padStart(3, "0"), {
      createdAt: i % 4,
      lastActivityAt: i % 7,
      archived: i % 9 === 0,
      pinned: i % 11 === 0,
      awaitingInput: i % 5 === 0,
      ...(i % 6 === 0 ? { parentSessionId: "parent" } : {}),
      threadRef: [`dm:C:${i}`, `web:U1:${i}`, `cron:${i}`][i % 3]!,
    }),
  ).reverse();
  for (const children of [false, true])
    for (const status of [undefined, "active", "waiting", "archived"] as const)
      for (const surface of ["all", "web", "slack", "core"] as const) {
        const request = { children, status, surface };
        const expected = rows.filter(
          (row) =>
            (children || !row.parentSessionId) &&
            (!status || chatBrowseStatusMatches(row, status)) &&
            (surface === "all" || surfaceOf(row) === surface),
        );
        assert.deepEqual(undecorated(allPages(rows, [context], request)), order(expected));
        const page = projectSessionPage(rows, [context], request);
        assert.equal(page.total, expected.length);
        for (const key of ["active", "waiting", "archived"] as const)
          assert.equal(
            page.statusTotals[key],
            rows.filter((row) => !row.parentSessionId && chatBrowseStatusMatches(row, key)).length,
          );
      }
  for (const archived of [false, true])
    for (const pinned of [false, true]) {
      const expected = rows.filter((row) => Boolean(row.archived) === archived && Boolean(row.pinned) === pinned);
      assert.deepEqual(undecorated(allPages(rows, [context], { children: true, archived, pinned })), order(expected));
    }
  assert.deepEqual(allPages([], [], {}), []);
});

test("literal query, current project labels, and actual thread surfaces use shared presentation rules", () => {
  const project = {
    ...context,
    scopeId: "group:web-project-P" as const,
    kind: "group" as const,
    project: {
      id: "P",
      scopeId: "group:web-project-P",
      name: "Current [100%_]",
      ownerId: "U1",
      orgId: "default-org",
      memberIds: ["U1"],
      members: [],
      createdAt: 1,
      updatedAt: 2,
    },
  };
  const rows = [
    session("project", { title: "\u00a0", scopeId: project.scopeId }),
    session("group", {
      type: "group",
      threadRef: "dm:G:1",
      channelName: "#mpdm-Ada-Lovelace-1--Grace-Hopper-2",
      title: null,
    }),
    session("child", { threadRef: "agent:main:subagent:1", surface: "web", parentSessionId: "parent" }),
    session("literal", { title: "100%_ literal" }),
    session("not-wildcard", { title: "100xx literal" }),
  ];
  for (const query of ["Current", "[100%_]", "ada lovelace, grace hopper", "100%_", "  PERSONAL  "]) {
    const page = projectSessionPage(rows, [context, project], { query, children: true });
    assert.deepEqual(
      undecorated(page.items),
      order(
        rows.filter((row) =>
          chatMatches(row, query.trim().toLowerCase(), row.scopeId === project.scopeId ? project.project.name : null),
        ),
      ),
    );
  }
  assert.deepEqual(projectSessionPage(rows, [context, project], { scopeId: "group:missing" }).items, []);
  assert.equal(
    projectSessionPage(rows, [context, project], { surface: "web", children: true }).items.some(
      (row) => row.id === "child",
    ),
    true,
  );
  assert.equal(
    projectSessionPage(rows, [context, project], { surface: "web" }).items.some((row) => row.id === "child"),
    false,
  );
  assert.equal(
    "members" in projectSessionPage(rows, [project], { scopeId: project.scopeId }).contexts[0]!.project!,
    false,
  );
});

test("navigation bounds every section without losing pins, empty personal/project groups or global startup facts", () => {
  const contexts: ContextSummary[] = [context];
  const rows: Session[] = [];
  for (let i = 0; i < 117; i++) {
    const scopeId = `channel:C${i}` as const;
    contexts.push({ scopeId, kind: "channel", name: `C${i}`, sessionCount: 1, lastActivityAt: i });
    rows.push(session(`recent-${i}`, { scopeId, createdAt: i }));
    rows.push(session(`pin-${i}`, { pinned: true, createdAt: i }));
    rows.push(session(`archive-${i}`, { archived: true, createdAt: i }));
  }
  contexts.push({
    ...context,
    scopeId: "group:web-project-empty",
    kind: "group",
    project: {
      id: "empty",
      scopeId: "group:web-project-empty",
      name: "Empty",
      ownerId: "U1",
      orgId: "default-org",
      memberIds: [],
      members: [],
      createdAt: 500,
      updatedAt: 600,
    },
  });
  rows.push(session("child", { parentSessionId: "parent", createdAt: 1000 }));
  rows.push(session("oldest", { createdAt: -10, archived: true }));
  rows.push(session("ideas", { threadRef: "web:U1:ideas:first", createdAt: -20 }));
  const hidden = session("hidden", { title: null, hasEntries: false });
  const read = (request: SessionNavigationRequest = {}) =>
    projectSessionNavigation(rows, [...rows, hidden], contexts, "U1", request);
  const initial = read({
    references: [
      { kind: "id", value: "hidden" },
      { kind: "thread", value: "web:U1:missing" },
    ],
  });
  assert.equal(initial.recent.items.length, 50);
  assert.equal(initial.pinned.items.length, 50);
  assert.equal(initial.groups.items.length, 50);
  assert.equal(initial.archived, undefined);
  assert.equal(initial.archivedCount, 118);
  assert.equal(initial.startup.oldestPersonalThreadRef, "web:U1:oldest");
  assert.equal(initial.startup.latest?.id, "child");
  assert.equal(initial.startup.hasNonCronSessions, true);
  assert.equal(initial.references[0]!.session?.id, "hidden");
  assert.equal(initial.references[1]!.session, null);
  for (const section of ["recent", "pinned", "groups", "archived"] as const) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = read({ section, cursor })[section]!;
      assert.ok(result.items.length <= 50);
      for (const item of result.items) ids.push("id" in item ? item.id : item.scopeId);
      assert.equal(new Set(ids).size, ids.length);
      cursor = result.nextCursor ?? undefined;
      if (!cursor) assert.equal(ids.length, result.total);
    } while (cursor);
    if (section === "groups") assert.ok(ids.includes("personal:U1") && ids.includes("group:web-project-empty"));
  }
  assert.ok(initial.groups.items.every((group) => !("sessions" in group) && !("members" in group)));
  assert.equal(read({ surface: "web" }).recent.total, initial.recent.total);
});

test("cursors reject wrong filters and malformed tuples, and do not grant access to rows", () => {
  const rows = Array.from({ length: 70 }, (_, i) => session(String(i), { createdAt: i }));
  const cursor = projectSessionPage(rows, [], { status: "active" }).nextCursor!;
  assert.throws(() => validateSessionPageCursor({ cursor, status: "archived" }), /invalid session cursor/);
  assert.throws(() => validateSessionPageCursor({ cursor: "not-json" }), /invalid session cursor/);
  assert.throws(() => validateNavigationCursor({ cursor }), /section required/);
  assert.deepEqual(projectSessionPage([], [], { status: "active", cursor }).items, []);
  const navCursor = projectSessionNavigation(rows, rows, [], "U1", {}).recent.nextCursor!;
  assert.throws(() => validateNavigationCursor({ section: "pinned", cursor: navCursor }), /invalid session cursor/);
});

test("exact title pages bypass substring distractors, preserve literal case and bind continuation", () => {
  const title = " Exact [100%_] Title ";
  const target = session("exact", { title, archived: true, parentSessionId: "parent", threadRef: "agent:child" });
  const rows = [...Array.from({ length: 65 }, (_, i) => session(`distractor-${i}`, { title: `${title}${i}` })), target];
  assert.deepEqual(projectSessionPage(rows, [], { children: true, title }).items, [
    { ...target, subagents: { running: 0, waiting: 0 } },
  ]);
  assert.deepEqual(projectSessionPage(rows, [], { children: true, title: title.trim() }).items, []);
  assert.deepEqual(projectSessionPage(rows, [], { children: true, title: title.toLowerCase() }).items, []);
  assert.deepEqual(projectSessionPage(rows, [], { children: true, title: "unknown" }).items, []);
  const duplicates = Array.from({ length: 65 }, (_, i) => session(String(i).padStart(3, "0"), { title }));
  const first = projectSessionPage(duplicates, [], { title });
  assert.equal(first.items[0]!.id, "000");
  assert.equal(first.total, 65);
  assert.ok(first.nextCursor);
  assert.throws(
    () => validateSessionPageCursor({ title: title.trim(), cursor: first.nextCursor! }),
    /invalid session cursor/,
  );
  assert.equal(projectSessionPage(duplicates, [], { title, cursor: first.nextCursor! }).items.length, 15);
});

test("descendant pages preserve all-depth state and full-snapshot summaries across page boundaries", () => {
  const root = session("root", { createdAt: 1000 });
  const children = Array.from({ length: 53 }, (_, i) =>
    session(`child-${String(i).padStart(2, "0")}`, {
      parentSessionId: root.id,
      createdAt: 53 - i,
      working: i === 52,
    }),
  );
  const grandchild = session("grandchild", {
    parentSessionId: children[52]!.id,
    createdAt: 0,
    awaitingInput: true,
    working: true,
  });
  const failed = session("failed", { parentSessionId: grandchild.id, createdAt: -1, lastTurnFailed: true });
  const rows = [root, ...children, grandchild, failed, session("unrelated", { working: true })];
  const request = { children: true, parentSessionId: root.id };
  const first = projectSessionPage(rows, [context], request);
  assert.equal(first.items.length, 50);
  assert.equal(first.total, 55);
  assert.ok(first.nextCursor);
  const second = projectSessionPage(rows, [context], { ...request, cursor: first.nextCursor });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(undecorated([...first.items, ...second.items]), order([...children, grandchild, failed]));
  assert.deepEqual(second.items.find((row) => row.id === "child-52")?.subagents, { running: 0, waiting: 1 });
  assert.equal(second.items.find((row) => row.id === "failed")?.lastTurnFailed, true);
  const nav = projectSessionNavigation(rows, rows, [context], "U1", { references: [{ kind: "id", value: root.id }] });
  for (const row of [
    nav.recent.items.find((row) => row.id === root.id),
    nav.references[0]!.session,
    nav.startup.latest,
  ])
    assert.deepEqual(row?.subagents, { running: 1, waiting: 1 });
  assert.deepEqual(projectSessionPage(rows, [], { query: "root" }).items[0]?.subagents, { running: 1, waiting: 1 });
  const resolved = resolveSessionReferences([root], [{ kind: "id", value: root.id }]);
  assert.ok(!("subagents" in resolved.references[0]!.session!));
  assert.throws(
    () => projectSessionPage(rows, [], { ...request, parentSessionId: "unrelated", cursor: first.nextCursor! }),
    /invalid session cursor/,
  );
  assert.throws(() => projectSessionPage(rows, [], { parentSessionId: root.id }), /children required/);
  assert.throws(() => projectSessionPage(rows, [], { parentSessionId: root.id, children: false }), /children required/);
});

test("descendant filtering cannot recover unauthorized roots or missing intermediate nodes", () => {
  const root = session("root");
  const child = session("child", { parentSessionId: root.id });
  const grandchild = session("grandchild", { parentSessionId: child.id });
  const request = { children: true, parentSessionId: root.id };
  assert.equal(projectSessionPage([child, grandchild], [], request).total, 0);
  assert.equal(projectSessionPage([child, grandchild], [], request, [root, child, grandchild]).total, 2);
  assert.equal(projectSessionPage([root, grandchild], [], request).total, 0);
  assert.equal(projectSessionPage([root, child, grandchild], [], { ...request, parentSessionId: "unknown" }).total, 0);
  assert.deepEqual(
    projectSessionPage([root, child, grandchild], [], { ...request, query: "grandchild" }).items.map((s) => s.id),
    [grandchild.id],
  );
  const cycle = [session("x", { parentSessionId: "y" }), session("y", { parentSessionId: "x" })];
  assert.deepEqual(
    projectSessionPage(cycle, [], { children: true, parentSessionId: "x" }).items.map((s) => s.id),
    ["y"],
  );
});

test("actionable pages filter before the limit and preserve depth through omitted idle ancestors", () => {
  const root = session("root");
  const idle = Array.from({ length: 65 }, (_, i) =>
    session(`idle-${i}`, { parentSessionId: root.id, createdAt: 1000 + i }),
  );
  const chain = Array.from({ length: 6 }, (_, i) =>
    session(`chain-${i}`, { parentSessionId: i ? `chain-${i - 1}` : root.id }),
  );
  const failed = session("failed", { parentSessionId: "chain-5", createdAt: -2, lastTurnFailed: true });
  const working = session("working", {
    parentSessionId: "chain-5",
    createdAt: -1,
    working: true,
    lastTurnFailed: true,
  });
  const waiting = session("waiting", { parentSessionId: "chain-5", createdAt: 0, working: true, awaitingInput: true });
  const rows = [root, ...idle, ...chain, failed, working, waiting];
  const request = { parentSessionId: root.id, children: true, actionable: true };
  const page = projectSessionPage(rows, [], request);
  assert.deepEqual(
    page.items.map((row) => row.id),
    ["waiting", "working", "failed"],
  );
  assert.equal(page.total, 3);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.actionable, {
    parentSessionId: root.id,
    parentSubagents: { running: 1, waiting: 1 },
    depths: [7, 7, 7],
  });
  assert.equal(projectSessionPage(rows, [], { ...request, actionable: false }).total, 74);
  assert.equal(projectSessionPage(rows, [], { ...request, actionable: false }).actionable, undefined);
  const ordinary = projectSessionPage(rows, [], { ...request, actionable: false });
  assert.equal(
    JSON.parse(Buffer.from(ordinary.nextCursor!, "base64url").toString()).key,
    JSON.stringify(["all", null, null, "", null, true, root.id, null, null]),
  );
  const failedOnly = projectSessionPage(
    rows.filter((row) => ![working.id, waiting.id].includes(row.id)),
    [],
    request,
  );
  assert.deepEqual(failedOnly.actionable?.parentSubagents, { running: 0, waiting: 0 });
  const hidden = rows.filter((row) => row.id !== root.id);
  assert.deepEqual(projectSessionPage(hidden, [], request, rows).actionable, page.actionable);
  const denied = projectSessionPage(hidden, [], request);
  assert.deepEqual(denied.actionable, { parentSessionId: root.id, parentSubagents: null, depths: [] });
  assert.equal(denied.total, 0);
  const broken = projectSessionPage(
    rows.filter((row) => row.id !== "chain-2"),
    [],
    request,
  );
  assert.deepEqual(broken.items, []);
  assert.deepEqual(broken.actionable?.parentSubagents, { running: 0, waiting: 0 });
});

test("actionable continuation binds its selector and returns complete deterministic ties without granting roots", () => {
  const root = session("root");
  const rows = [
    root,
    ...Array.from({ length: 103 }, (_, i) =>
      session(`child-${String(i).padStart(3, "0")}`, { parentSessionId: root.id, lastTurnFailed: true }),
    ),
  ];
  const request = { parentSessionId: root.id, children: true, actionable: true };
  const first = projectSessionPage(rows, [], request);
  assert.equal(first.items.length, 50);
  assert.equal(first.total, 103);
  assert.equal(first.items[0]?.id, "child-000");
  assert.deepEqual(first.actionable?.depths, Array(50).fill(1));
  assert.equal(allPages(rows, [], request).length, 103);
  for (const changed of [{ actionable: false }, { parentSessionId: "other" }, { children: false }])
    assert.throws(() => validateSessionPageCursor({ ...request, ...changed, cursor: first.nextCursor! }));
  assert.throws(() => validateSessionPageCursor({ actionable: true, children: true }), /parentSessionId required/);
  const revoked = projectSessionPage(rows.slice(1), [], { ...request, cursor: first.nextCursor! });
  assert.deepEqual(revoked.items, []);
  assert.equal(revoked.actionable?.parentSubagents, null);
});
