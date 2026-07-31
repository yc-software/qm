import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityOf,
  applySessionState,
  bumpActivity,
  chatBrowseStatusMatches,
  clearWorking,
  groupProjectSessions,
  backgroundLabel,
  conversationBackground,
  markWorking,
  recencyGroup,
  rowIndicators,
  recentProjectSeeds,
  reconcileSessions,
  splitPinned,
  withPendingSession,
  withoutUnsentPending,
} from "../src/session-list.ts";
import type { CoreSession } from "../src/core-bridge.ts";

function pending(threadRef: string): CoreSession {
  return {
    id: "",
    type: "dm",
    scopeId: "",
    threadRef,
    createdAt: Date.now(),
    title: null,
    channelName: null,
    archived: false,
  };
}
function saved(id: string, threadRef: string, title: string | null = null): CoreSession {
  return { id, type: "dm", scopeId: "", threadRef, createdAt: 1, title, channelName: null, archived: false };
}

test("chat browse statuses are mutually exclusive and working does not mean waiting", () => {
  const active = { ...saved("active", "web:u:active"), working: true };
  const waiting = { ...saved("waiting", "web:u:waiting"), awaitingInput: true };
  const archived = { ...saved("archived", "web:u:archived"), archived: true, awaitingInput: true };
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "active"))
      .map((session) => session.id),
    ["active"],
  );
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "waiting"))
      .map((session) => session.id),
    ["waiting"],
  );
  assert.deepEqual(
    [active, waiting, archived]
      .filter((session) => chatBrowseStatusMatches(session, "archived"))
      .map((session) => session.id),
    ["archived"],
  );
});

test("splitPinned lifts pinned rows out in order and leaves the rest untouched", () => {
  const a = saved("a", "web:u:a");
  const b = { ...saved("b", "web:u:b"), pinned: true };
  const c = saved("c", "web:u:c");
  const d = { ...saved("d", "web:u:d"), pinned: true };
  const { pinned, rest } = splitPinned([a, b, c, d]);
  assert.deepEqual(
    pinned.map((s) => s.id),
    ["b", "d"],
    "pinned rows keep their relative (recency) order",
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(splitPinned([]).pinned, []);
  assert.deepEqual(
    splitPinned([a]).rest.map((s) => s.id),
    ["a"],
  );
});

test("a second New chat keeps the first pending row (both show in Recents)", () => {
  let list: CoreSession[] = [];
  list = withPendingSession(list, pending("web:u:a"));
  list = withPendingSession(list, pending("web:u:b"));
  assert.deepEqual(
    list.map((s) => s.threadRef),
    ["web:u:b", "web:u:a"],
  );
});

test("re-adding the same threadRef dedupes rather than duplicating", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  list = withPendingSession(list, pending("web:u:a"));
  list = withPendingSession(list, pending("web:u:a"));
  assert.equal(list.filter((s) => s.threadRef === "web:u:a").length, 1);
  assert.equal(list.length, 2);
});

test("reconcile keeps saved sessions and re-adds unsent pending chats", () => {
  const prev = [pending("web:u:a"), pending("web:u:b"), saved("1", "web:u:x")];
  const server = [saved("1", "web:u:x")];
  const out = reconcileSessions(server, prev);
  assert.deepEqual(new Set(out.map((s) => s.threadRef)), new Set(["web:u:a", "web:u:b", "web:u:x"]));
});

test("reconcile drops a pending chat once the server knows its threadRef", () => {
  const prev = [pending("web:u:a")];
  const server = [saved("9", "web:u:a", "Bubble waffle order")];
  const out = reconcileSessions(server, prev);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "9");
  assert.equal(out[0]!.title, "Bubble waffle order");
});

test("reconcile against an empty prev is just the server list", () => {
  const server = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  assert.deepEqual(reconcileSessions(server, []), server);
});

test("bumpActivity stamps lastActivityAt on the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const out = bumpActivity(list, "web:u:y", 12345);
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.lastActivityAt, 12345);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.lastActivityAt, undefined, "other rows untouched");
});

test("bumpActivity is a no-op when no row matches the threadRef", () => {
  const list = [saved("1", "web:u:x")];
  assert.deepEqual(bumpActivity(list, "web:u:missing", 999), list);
});

test("activityOf prefers lastActivityAt, falling back to createdAt", () => {
  assert.equal(activityOf(saved("1", "web:u:x")), 1, "no lastActivityAt -> createdAt (createdAt is 1 here)");
  assert.equal(activityOf({ ...saved("2", "web:u:y"), lastActivityAt: 999 }), 999, "lastActivityAt wins when present");
});

test("activityOf orders a context's conversations by recency, not creation", () => {
  const old = { ...saved("1", "web:u:old"), createdAt: 200 };
  const active = { ...saved("2", "web:u:active"), createdAt: 100, lastActivityAt: 500 };
  const ranked = [old, active].sort((a, b) => activityOf(b) - activityOf(a));
  assert.deepEqual(
    ranked.map((s) => s.threadRef),
    ["web:u:active", "web:u:old"],
    "most-recently-active first",
  );
});

test("withoutUnsentPending drops only the empty-id twin for the threadRef", () => {
  const list = [pending("web:u:a"), saved("1", "web:u:x")];
  const out = withoutUnsentPending(list, "web:u:a");
  assert.deepEqual(
    out.map((s) => s.threadRef),
    ["web:u:x"],
  );
});

test("withoutUnsentPending never removes a real server-backed row", () => {
  const list = [saved("9", "web:u:a")];
  assert.deepEqual(withoutUnsentPending(list, "web:u:a"), list);
});

test("withoutUnsentPending is a no-op for an unknown threadRef", () => {
  const list = [pending("web:u:a")];
  assert.deepEqual(withoutUnsentPending(list, "web:u:zzz"), list);
});

test("applySessionState: working lights the dot on the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:y", state: "working" });
  assert.equal(matched, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.working, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.working, undefined, "other rows untouched");
});

test("applySessionState: awaiting_approval swaps the working dot for the amber dot", () => {
  const list = [{ ...saved("1", "web:u:x"), working: true }];
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "awaiting_approval" });
  assert.equal(out[0]!.working, false);
  assert.equal(out[0]!.awaitingInput, true);
});

test("applySessionState: idle clears both dots", () => {
  const list = [{ ...saved("1", "web:u:x"), working: true, awaitingInput: true }];
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "idle" });
  assert.equal(out[0]!.working, false);
  assert.equal(out[0]!.awaitingInput, false);
});

test("applySessionState: an unknown threadRef reports matched:false and leaves the list identical", () => {
  const list = [saved("1", "web:u:x")];
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:missing", state: "working" });
  assert.equal(matched, false);
  assert.equal(out, list, "caller heals by re-snapshotting; the list object is untouched");
});

test("applySessionState does not bump recency — lifecycle is not user activity", () => {
  const row = { ...saved("1", "web:u:x"), lastActivityAt: 1111 };
  const { list: out } = applySessionState([row], { threadRef: "web:u:x", state: "idle" });
  assert.equal(activityOf(out[0]!), 1111);
});

test("applySessionState: an out-of-order (older `at`) frame is ignored — last state wins by timestamp", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  ({ list } = applySessionState(list, { threadRef: "web:u:x", state: "idle", at: 200 }));
  const { list: out, matched } = applySessionState(list, { threadRef: "web:u:x", state: "working", at: 100 });
  assert.equal(matched, true, "the row exists — no heal snapshot needed");
  assert.equal(out[0]!.working, false, "the stale working frame is dropped");
});

test("applySessionState: frames without `at` (and rows fresh from a snapshot) still apply", () => {
  let list: CoreSession[] = [saved("1", "web:u:x")];
  ({ list } = applySessionState(list, { threadRef: "web:u:x", state: "idle", at: 200 }));
  const { list: out } = applySessionState(list, { threadRef: "web:u:x", state: "working" });
  assert.equal(out[0]!.working, true, "an unstamped frame applies unconditionally");
});

test("reconcile replaces a pushed working state with server truth", () => {
  const { list: prev } = applySessionState([saved("1", "web:u:x")], { threadRef: "web:u:x", state: "working" });
  const out = reconcileSessions([saved("1", "web:u:x")], prev);
  assert.equal(out[0]!.working, undefined, "server row (no working flag) supersedes the pushed state");
});

test("markWorking stamps the matching row only", () => {
  const list = [saved("1", "web:u:x"), saved("2", "web:u:y")];
  const out = markWorking(list, "web:u:y");
  assert.equal(out.find((s) => s.threadRef === "web:u:y")!.working, true);
  assert.equal(out.find((s) => s.threadRef === "web:u:x")!.working, undefined, "other rows untouched");
});

test("markWorking is a no-op when no row matches", () => {
  const list = [saved("1", "web:u:x")];
  assert.deepEqual(markWorking(list, "web:u:missing"), list);
});

test("clearWorking clears only the matching row", () => {
  const list = [
    { ...saved("1", "web:u:x"), working: true },
    { ...saved("2", "web:u:y"), working: true },
  ];
  assert.deepEqual(
    clearWorking(list, "web:u:x").map((s) => s.working),
    [false, true],
  );
});

test("recencyGroup buckets by calendar day, then widening spans", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  const day = 86_400_000;
  const midnight = new Date(2026, 6, 14, 0, 0).getTime();
  assert.equal(recencyGroup(now, now), "Today");
  assert.equal(recencyGroup(midnight, now), "Today", "first instant of today");
  assert.equal(recencyGroup(midnight - 1, now), "Yesterday", "last instant of yesterday");
  assert.equal(recencyGroup(midnight - day, now), "Yesterday");
  assert.equal(recencyGroup(midnight - day - 1, now), "Previous 7 days");
  assert.equal(recencyGroup(midnight - 6 * day, now), "Previous 7 days", "6 days back is still in the window");
  assert.equal(recencyGroup(midnight - 6 * day - 1, now), "Previous 30 days");
  assert.equal(recencyGroup(midnight - 29 * day, now), "Previous 30 days");
  assert.equal(recencyGroup(midnight - 29 * day - 1, now), "Older");
});

test("recencyGroup anchors boundaries to calendar days, not fixed 24h offsets", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  assert.equal(recencyGroup(new Date(2026, 6, 13, 23, 59, 59).getTime(), now), "Yesterday");
  assert.equal(recencyGroup(new Date(2026, 6, 13, 0, 0).getTime(), now), "Yesterday");
  assert.equal(recencyGroup(new Date(2026, 6, 8, 0, 0).getTime(), now), "Previous 7 days");
  assert.equal(recencyGroup(new Date(2026, 6, 7, 23, 59, 59).getTime(), now), "Previous 30 days");
  assert.equal(recencyGroup(new Date(2026, 5, 15, 0, 0).getTime(), now), "Previous 30 days");
  assert.equal(recencyGroup(new Date(2026, 5, 14, 23, 59, 59).getTime(), now), "Older");
});

test("recencyGroup treats a future timestamp (optimistic bump) as Today", () => {
  const now = new Date(2026, 6, 14, 15, 30).getTime();
  assert.equal(recencyGroup(now + 60_000, now), "Today");
});

test("reconcile replaces an optimistic working stamp with server truth", () => {
  const prev = markWorking([saved("1", "web:u:x")], "web:u:x");
  const out = reconcileSessions([saved("1", "web:u:x")], prev);
  assert.equal(out[0]!.working, undefined, "server row (no working flag) supersedes the stamp");
});

test("project metadata groups only its group scope while ordinary chats stay flat", () => {
  const project = {
    scopeId: "group:web-project-p1",
    kind: "group" as const,
    name: "Launch",
    sessionCount: 2,
    lastActivityAt: 30,
    project: {
      id: "p1",
      name: "Launch",
      ownerId: "alice",
      memberIds: ["alice"],
      scopeId: "group:web-project-p1",
      members: [{ principalId: "alice", displayName: "Alice" }],
    },
  };
  const sessions = [
    { ...saved("1", "web:alice:p1-a"), type: "group" as const, scopeId: project.scopeId, lastActivityAt: 30 },
    { ...saved("2", "web:alice:plain"), lastActivityAt: 20 },
    { ...saved("3", "web:alice:p1-b"), type: "group" as const, scopeId: project.scopeId, lastActivityAt: 10 },
  ];
  const items = groupProjectSessions(sessions, recentProjectSeeds([project]));
  assert.equal(items[0]?.kind, "project");
  assert.deepEqual(items[0]?.kind === "project" ? items[0].sessions.map((session) => session.id) : [], ["1", "3"]);
  assert.equal(items[1]?.kind, "session");
});

test("empty projects appear in Recents", () => {
  const seeds = [{ scopeId: "group:web-project-empty", name: "Empty" }];
  const items = groupProjectSessions([], seeds);
  assert.deepEqual(items, [
    { kind: "project", scopeId: "group:web-project-empty", name: "Empty", groupKind: "project", sessions: [] },
  ]);
});

test("a pending (not-yet-sent) chat in a project scope nests under its project", () => {
  const seeds = [{ scopeId: "group:web-project-p1", name: "P1" }];
  const fresh = { ...pending("web:alice:new"), type: "group" as const, scopeId: seeds[0]!.scopeId };
  const list = withPendingSession([saved("1", "web:alice:old")], fresh);
  const items = groupProjectSessions(list, seeds);
  assert.equal(items[0]?.kind, "project");
  assert.deepEqual(items[0]?.kind === "project" ? items[0].sessions.map((s) => s.threadRef) : [], ["web:alice:new"]);
});

test("without project metadata every conversation keeps the existing flat recency order", () => {
  const olderGroup = {
    ...saved("1", "web:alice:group"),
    type: "group" as const,
    scopeId: "group:slack-mpdm",
    lastActivityAt: 10,
  };
  const newerPersonal = { ...saved("2", "web:alice:personal"), lastActivityAt: 20 };
  assert.deepEqual(groupProjectSessions([olderGroup, newerPersonal], []), [
    { kind: "session", session: newerPersonal },
    { kind: "session", session: olderGroup },
  ]);
});

test("rowIndicators: server working flag lights the dot", () => {
  const ind = rowIndicators({ ...saved("1", "web:u:x"), working: true }, null);
  assert.equal(ind.working, true);
  assert.equal(ind.awaiting, false);
  assert.equal(ind.background, null);
});

test("rowIndicators: the mounted pane's live turn lights its own row even before the server flag lands", () => {
  const ind = rowIndicators(saved("1", "web:u:x"), "web:u:x");
  assert.equal(ind.working, true);
  assert.equal(
    rowIndicators(saved("2", "web:u:other"), "web:u:x").working,
    false,
    "only the live thread borrows the client signal",
  );
});

test("rowIndicators: awaitingInput maps through", () => {
  assert.equal(rowIndicators({ ...saved("1", "web:u:x"), awaitingInput: true }, null).awaiting, true);
});

test("backgroundLabel: jobs and watches fold into one chip with a spoken label", () => {
  assert.deepEqual(backgroundLabel(1, 0), { jobs: 1, watches: 0, label: "1 background job running" });
  assert.deepEqual(backgroundLabel(2, 1), {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
  assert.deepEqual(backgroundLabel(0, 2), { jobs: 0, watches: 2, label: "2 watches armed" });
  assert.equal(backgroundLabel(0, 0), null, "nothing running, nothing to say");
});

test("rowIndicators: background counts flow through backgroundLabel — zero counts treated as absent", () => {
  const both = rowIndicators({ ...saved("1", "web:u:x"), backgroundJobs: 2, watches: 1 }, null);
  assert.deepEqual(both.background, {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
  assert.equal(rowIndicators({ ...saved("1", "web:u:x"), backgroundJobs: 0, watches: 0 }, null).background, null);
  assert.equal(rowIndicators(saved("1", "web:u:x"), null).background, null);
});

test("conversationBackground: resolves the mounted conversation by session id", () => {
  const list = [saved("1", "web:u:a"), { ...saved("2", "web:u:b"), backgroundJobs: 2, watches: 1 }];
  assert.deepEqual(conversationBackground(list, "2", null), {
    jobs: 2,
    watches: 1,
    label: "2 background jobs running · 1 watch armed",
  });
});

test("conversationBackground: falls back to threadRef while the conversation is still pending adoption", () => {
  const list = [{ ...saved("1", "web:u:a"), watches: 1 }];
  assert.deepEqual(conversationBackground(list, null, "web:u:a"), { jobs: 0, watches: 1, label: "1 watch armed" });
});

test("conversationBackground: null when the conversation has nothing running, or isn't in the list", () => {
  assert.equal(conversationBackground([saved("1", "web:u:a")], "1", "web:u:a"), null, "no counts, no strip");
  assert.equal(
    conversationBackground([{ ...saved("1", "web:u:a"), backgroundJobs: 1 }], "9", "web:u:zzz"),
    null,
    "unknown conversation",
  );
  assert.equal(
    conversationBackground([{ ...saved("1", "web:u:a"), backgroundJobs: 1 }], null, null),
    null,
    "nothing mounted",
  );
});
