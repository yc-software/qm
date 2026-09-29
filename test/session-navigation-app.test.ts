import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

test("navigation reuses one authorized snapshot and preserves legacy list/context populations", async (t) => {
  const built = buildApp(testConfig());
  try {
    for (let i = 0; i < 63; i++) {
      const session = await built.sessions.getOrCreateByThread(`web:U1:${i}`, "dm", "personal:U1");
      await built.sessions.addParticipant(session.id, "U1");
      await built.sessions.updateTitle(session.id, `Visible ${i}`);
    }
    const hidden = await built.sessions.getOrCreateByThread("web:U1:hidden", "dm", "personal:U1");
    await built.sessions.addParticipant(hidden.id, "U1");
    const legacy = await built.app.listSessions("U1");
    const contexts = await built.app.listContexts("U1");
    const list = built.sessions.listByParticipant.bind(built.sessions);
    let reads = 0;
    t.mock.method(built.sessions, "listByParticipant", async (id: string) => {
      reads++;
      return list(id);
    });
    const navigation = await built.app.sessionNavigation("U1", { references: [{ kind: "id", value: hidden.id }] });
    assert.equal(reads, 1);
    assert.equal(navigation.recent.total, legacy.length);
    assert.equal(navigation.recent.items.length, 50);
    assert.equal(navigation.references[0]!.session?.id, hidden.id);
    assert.deepEqual(navigation.contexts, contexts);
    const page = await built.app.sessionPage("U1", {});
    assert.equal(reads, 2);
    assert.equal(page.total, 63);
    const next = await built.app.sessionPage("U1", { cursor: page.nextCursor! });
    assert.deepEqual(
      new Set([...page.items, ...next.items].map((row) => row.id)),
      new Set(legacy.map((row) => row.id)),
    );
    assert.deepEqual(await built.app.listSessions("U1"), legacy);
    assert.deepEqual(await built.app.listContexts("U1"), contexts);
    assert.equal(reads, 5);
  } finally {
    await built.runtime.stop();
  }
});

test("ID and thread resolution use participant and current project authorization without full enumeration", async (t) => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Current project", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    const own = await built.sessions.getOrCreateByThread("web:member:project", "group", projectScopeId(project.id));
    await built.sessions.addParticipant(own.id, "member");
    await built.sessions.updateTitle(own.id, "Project row");
    const foreign = await built.sessions.getOrCreateByThread("web:other:foreign", "dm", "personal:other");
    await built.sessions.addParticipant(foreign.id, "other");
    const refs = [
      { kind: "id" as const, value: own.id },
      { kind: "thread" as const, value: own.threadRef },
      { kind: "id" as const, value: foreign.id },
      { kind: "thread" as const, value: foreign.threadRef },
      { kind: "id" as const, value: "missing" },
    ];
    const participantGet = built.sessions.getForParticipant.bind(built.sessions);
    const readIds: string[] = [];
    t.mock.method(built.sessions, "getForParticipant", async (id: string, principal: string) => {
      readIds.push(id);
      return participantGet(id, principal);
    });
    t.mock.method(built.sessions, "listByParticipant", async () => {
      throw new Error("unexpected full enumeration");
    });
    assert.deepEqual(
      (await built.app.resolveSessions("member", refs)).references.map((ref) => ref.session?.id ?? null),
      [own.id, own.id, null, null, null],
    );
    assert.deepEqual(new Set(readIds), new Set([own.id, foreign.id, "missing"]));
    assert.equal(readIds.length, 3);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.ok((await built.app.resolveSessions("member", refs)).references.every((ref) => ref.session === null));
    t.mock.restoreAll();
    assert.equal((await built.app.sessionNavigation("member")).recent.total, 0);
    assert.equal((await built.app.sessionPage("member", { scopeId: projectScopeId(project.id) })).total, 0);
    assert.equal((await built.app.sessionNavigation("member", { references: refs })).references[0]!.session, null);
    await assert.rejects(built.app.resolveSessions("member", Array(13).fill(refs[0])), /too many session references/);
  } finally {
    await built.runtime.stop();
  }
});

test("finite-read aborts and query errors do not become empty successful navigation", async (t) => {
  const built = buildApp(testConfig());
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(built.app.sessionNavigation("U1", {}, cancelled.signal), { name: "AbortError" });
    await assert.rejects(built.app.sessionPage("U1", {}, cancelled.signal), { name: "AbortError" });
    await assert.rejects(built.app.resolveSessions("U1", [], cancelled.signal), { name: "AbortError" });
    const next = new AbortController();
    t.mock.method(built.sessions, "listByParticipant", async () => {
      next.abort();
      return [];
    });
    t.mock.method(built.crons, "list", async () => {
      throw new Error("should not continue after abort");
    });
    await assert.rejects(built.app.sessionPage("U1", {}, next.signal), { name: "AbortError" });
    t.mock.method(built.sessions, "listByParticipant", async () => {
      throw new Error("enumeration failed");
    });
    await assert.rejects(built.app.sessionNavigation("U1"), /enumeration failed/);
  } finally {
    await built.runtime.stop();
  }
});

test("abort during live-thread lookup stops navigation and page before background reads", async (t) => {
  const built = buildApp(testConfig());
  try {
    for (const method of ["sessionNavigation", "sessionPage"] as const) {
      const controller = new AbortController();
      let participantReads = 0;
      let backgroundReads = 0;
      t.mock.method(built.runs, "activeSessionIds", async () => {
        controller.abort();
        return [];
      });
      t.mock.method(built.sessions, "listByParticipant", async () => {
        participantReads++;
        return [];
      });
      t.mock.method(built.crons, "list", async () => {
        backgroundReads++;
        return [];
      });
      await assert.rejects(built.app[method]("U1", {}, controller.signal), { name: "AbortError" });
      assert.equal(participantReads, 1, method);
      assert.equal(backgroundReads, 0, method);
    }
  } finally {
    await built.runtime.stop();
  }
});

test("exact title pages select only participant and current managed-project authorized rows", async () => {
  const built = buildApp(testConfig());
  try {
    const title = "Same exact title";
    const own = await built.sessions.getOrCreateByThread("web:U1:exact", "dm", "personal:U1");
    await built.sessions.addParticipant(own.id, "U1");
    await built.sessions.updateTitle(own.id, title);
    const foreign = await built.sessions.getOrCreateByThread("web:U2:exact", "dm", "personal:U2");
    await built.sessions.addParticipant(foreign.id, "U2");
    await built.sessions.updateTitle(foreign.id, title);
    const project = await built.projects.create({ name: "Private project", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "U1");
    const revoked = await built.sessions.getOrCreateByThread("web:U1:revoked", "group", projectScopeId(project.id));
    await built.sessions.addParticipant(revoked.id, "U1");
    await built.sessions.updateTitle(revoked.id, title);
    await built.projects.removeMember(project.id, "owner", "U1");
    const result = await built.app.sessionPage("U1", { title, children: true });
    assert.deepEqual(
      result.items.map((row) => row.id),
      [own.id],
    );
    assert.equal(result.total, 1);
    assert.equal((await built.app.sessionPage("U1", { title: "unknown", children: true })).total, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("navigation and references preserve parent work, blocking approval and child failure from the full list", async () => {
  const built = buildApp(testConfig());
  try {
    const parent = await built.sessions.getOrCreateByThread("web:U1:parent", "dm", "personal:U1");
    const child = await built.sessions.getOrCreateByThread("web:U1:child", "dm", "personal:U1");
    for (const s of [parent, child]) await built.sessions.addParticipant(s.id, "U1");
    await built.sessions.updateTitle(child.id, "Child");
    await built.sessions.setParentSession(child.id, parent.id);
    const actor = { id: "internal:U1", type: "internal" as const };
    const request: OrchestratorInput = {
      actor,
      conversation: { kind: "dm", threadRef: child.threadRef, audience: [actor] },
      origin: { kind: "direct" },
      text: "work",
    };
    const { run } = await built.runs.enqueue({ sessionId: child.threadRef, request });
    let legacy = await built.app.listSessions("U1");
    assert.equal(legacy.find((s) => s.id === parent.id)?.working, true);
    assert.equal((await built.app.sessionNavigation("U1")).recent.items.find((s) => s.id === parent.id)?.working, true);
    assert.deepEqual(
      (await built.app.sessionPage("U1", { children: true })).items
        .map(({ subagents: _subagents, ...row }) => row)
        .sort((a, b) => a.id.localeCompare(b.id)),
      legacy.sort((a, b) => a.id.localeCompare(b.id)),
    );
    const parked = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: parent.threadRef },
      text: `!run ${["git", "push", `--${"force"}`, "origin", "main"].join(" ")}`,
    });
    assert.equal(parked.status, "pending_approval");
    const waiting = (await built.app.sessionNavigation("U1")).recent.items.find((s) => s.id === parent.id);
    assert.equal(waiting?.awaitingInput, true);
    assert.ok(!waiting?.working);
    const leased = await built.runs.claimById(run.id, "worker", 5_000);
    assert.ok(leased);
    await built.runs.complete(run.id, leased.leaseToken!, { status: "failed", reason: "modeled failure" });
    legacy = await built.app.listSessions("U1");
    const failed = legacy.find((s) => s.id === child.id);
    assert.equal(failed?.lastTurnFailed, true);
    const reference = { kind: "id" as const, value: child.id };
    assert.deepEqual((await built.app.resolveSessions("U1", [reference])).references[0]!.session, failed);
    assert.deepEqual((await built.app.sessionNavigation("U1", { references: [reference] })).references[0]!.session, {
      ...failed,
      subagents: { running: 0, waiting: 0 },
    });
    assert.deepEqual(
      (await built.app.sessionPage("U1", { children: true, parentSessionId: parent.id })).items.find(
        (s) => s.id === child.id,
      ),
      { ...failed, subagents: { running: 0, waiting: 0 } },
    );
  } finally {
    await built.runtime.stop();
  }
});

test("abort during the bulk child failure lookup prevents returning a page", async (t) => {
  const built = buildApp(testConfig());
  try {
    const parent = await built.sessions.getOrCreateByThread("web:U1:abort-parent", "dm", "personal:U1");
    for (let i = 0; i < 2; i++) {
      const child = await built.sessions.getOrCreateByThread(`web:U1:abort-child-${i}`, "dm", "personal:U1");
      await built.sessions.addParticipant(child.id, "U1");
      await built.sessions.updateTitle(child.id, "Child");
      await built.sessions.setParentSession(child.id, parent.id);
    }
    const controller = new AbortController();
    let reads = 0;
    t.mock.method(built.runs, "latestFailedThreads", async (refs: readonly string[], signal?: AbortSignal) => {
      reads++;
      assert.equal(refs.length, 2);
      assert.equal(signal, controller.signal);
      controller.abort();
      return new Set<string>();
    });
    await assert.rejects(built.app.sessionPage("U1", { children: true }, controller.signal), { name: "AbortError" });
    assert.equal(reads, 1);
  } finally {
    await built.runtime.stop();
  }
});

test("descendant pages use current project access and retain closed participant history", async () => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Descendants", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    const parent = await built.sessions.getOrCreateByThread("web:member:tree", "group", projectScopeId(project.id));
    const child = await built.sessions.getOrCreateByThread(
      "web:member:tree-child",
      "group",
      projectScopeId(project.id),
    );
    for (const row of [parent, child]) {
      await built.sessions.addParticipant(row.id, "member");
      await built.sessions.updateTitle(row.id, row.threadRef);
    }
    await built.sessions.setParentSession(child.id, parent.id);
    await built.sessions.removeParticipant(child.id, "member");
    const request = { children: true, parentSessionId: parent.id };
    assert.deepEqual(
      (await built.app.sessionPage("member", request)).items.map((row) => row.id),
      [child.id],
    );
    assert.equal((await built.app.sessionPage("other", request)).total, 0);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.equal((await built.app.sessionPage("member", request)).total, 0);
    assert.equal((await built.app.sessionNavigation("member")).recent.total, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("deep inactive ancestors retain a failed leaf in descendant pages without claiming active work", async () => {
  const built = buildApp(testConfig());
  try {
    const chain = [];
    for (let depth = 0; depth < 7; depth++) {
      const row = await built.sessions.getOrCreateByThread(`web:U1:deep-${depth}`, "dm", "personal:U1");
      await built.sessions.addParticipant(row.id, "U1");
      await built.sessions.updateTitle(row.id, `Depth ${depth}`);
      if (depth) await built.sessions.setParentSession(row.id, chain[depth - 1]!.id);
      chain.push(row);
    }
    const leaf = chain.at(-1)!;
    const actor = { id: "internal:U1", type: "internal" as const };
    const request: OrchestratorInput = {
      actor,
      conversation: { kind: "dm", threadRef: leaf.threadRef, audience: [actor] },
      origin: { kind: "direct" },
      text: "work",
    };
    const { run } = await built.runs.enqueue({ sessionId: leaf.threadRef, request });
    const leased = await built.runs.claimById(run.id, "worker", 5_000);
    assert.ok(leased);
    await built.runs.complete(run.id, leased.leaseToken!, { status: "failed", reason: "deep failure" });
    const root = chain[0]!;
    const nav = await built.app.sessionNavigation("U1");
    assert.deepEqual(nav.recent.items.find((row) => row.id === root.id)?.subagents, { running: 0, waiting: 0 });
    const page = await built.app.sessionPage("U1", { children: true, parentSessionId: root.id });
    assert.equal(page.total, 6);
    assert.deepEqual(new Set(page.items.map((row) => row.id)), new Set(chain.slice(1).map((row) => row.id)));
    assert.ok(page.items.every((row) => !row.working && !row.awaitingInput));
    assert.deepEqual(
      page.items.filter((row) => row.lastTurnFailed).map((row) => row.id),
      [leaf.id],
    );
    assert.ok(page.items.every((row) => row.subagents?.running === 0 && row.subagents.waiting === 0));
    const actionable = await built.app.sessionPage("U1", {
      children: true,
      parentSessionId: root.id,
      actionable: true,
    });
    assert.deepEqual(
      actionable.items.map((row) => row.id),
      [leaf.id],
    );
    assert.deepEqual(actionable.actionable, {
      parentSessionId: root.id,
      parentSubagents: { running: 0, waiting: 0 },
      depths: [6],
    });
    const foreign = await built.app.sessionPage("other", {
      children: true,
      parentSessionId: root.id,
      actionable: true,
    });
    assert.deepEqual(foreign.items, []);
    assert.equal(foreign.actionable?.parentSubagents, null);
  } finally {
    await built.runtime.stop();
  }
});

test("all session reads share one narrow failure projection with authorized idle-child exclusions", async (t) => {
  const built = buildApp(testConfig());
  try {
    const parent = await built.sessions.getOrCreateByThread("web:U1:projection-root", "dm", "personal:U1");
    const children = [];
    for (const name of ["idle", "active", "waiting", "foreign"]) {
      const child = await built.sessions.getOrCreateByThread(`web:U1:projection-${name}`, "dm", "personal:U1");
      await built.sessions.addParticipant(child.id, name === "foreign" ? "U2" : "U1");
      await built.sessions.updateTitle(child.id, name);
      await built.sessions.setParentSession(child.id, parent.id);
      children.push(child);
    }
    await built.sessions.addParticipant(parent.id, "U1");
    await built.sessions.updateTitle(parent.id, "Parent");
    const [idle, active, waiting] = children;
    const actor = { id: "internal:U1", type: "internal" as const };
    const request: OrchestratorInput = {
      actor,
      conversation: { kind: "dm", threadRef: active!.threadRef, audience: [actor] },
      origin: { kind: "direct" },
      text: "active",
    };
    await built.runs.enqueue({ sessionId: active!.threadRef, request });
    const parked = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: waiting!.threadRef },
      text: `!run ${["git", "push", `--${"force"}`, "origin", "main"].join(" ")}`,
    });
    assert.equal(parked.status, "pending_approval");
    t.mock.method(built.runs, "latestForThread", async () => {
      throw new Error("full run lookup reached from navigation");
    });
    let reads = 0;
    const original = built.runs.latestFailedThreads.bind(built.runs);
    t.mock.method(built.runs, "latestFailedThreads", async (refs: readonly string[], signal?: AbortSignal) => {
      reads++;
      assert.deepEqual(refs, [idle!.threadRef]);
      return original(refs, signal);
    });
    await built.app.listSessions("U1");
    await built.app.sessionNavigation("U1");
    await built.app.sessionPage("U1", { children: true, parentSessionId: parent.id });
    await built.app.resolveSessions("U1", [{ kind: "id", value: idle!.id }]);
    assert.equal(reads, 4);
    t.mock.method(built.runs, "latestFailedThreads", async () => {
      throw new Error("failure lookup unavailable");
    });
    await assert.rejects(built.app.sessionPage("U1", {}), /failure lookup unavailable/);
  } finally {
    await built.runtime.stop();
  }
});
