import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { createServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { isUserItem } from "../src/sessions/items.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

async function setup() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-move-")) }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const personal = async (principal: string, thread: string, text: string) => {
    const result = await built.app.turn({
      surface: "web",
      actor: { externalId: principal },
      conversation: { kind: "dm", threadRef: thread },
      text,
    });
    return result.sessionId!;
  };
  return { built, project, scope: projectScopeId(project.id), personal };
}

test("moving a personal chat into a project copies it there, keeps its title, and archives the original", async () => {
  const { built, scope, personal } = await setup();
  const sid = await personal("owner", "web:owner:move-1", "Plan the launch checklist");
  await built.app.updateSession(sid, { actorId: "owner" }, { title: "Launch checklist", pinned: true });

  const out = await built.app.moveSession(sid, "owner", scope);
  assert.ok(out.moved);
  const moved = out.session;
  assert.notEqual(moved.id, sid);
  assert.equal(moved.scopeId, scope);
  assert.equal(moved.type, "group");
  assert.equal(moved.title, "Launch checklist", "the moved chat keeps its title without a fork marker");
  assert.equal(moved.pinned, true);
  assert.equal(moved.forkedFrom, undefined, "a move is not presented as a fork");

  const view = await built.app.getSessionForViewer(moved.id, { actorId: "member" });
  assert.ok(
    view?.items.filter(isUserItem).some((item) => item.text?.includes("Plan the launch checklist")),
    "project members see the moved transcript",
  );
  const mine = await built.app.listSessions({ actorId: "owner" });
  assert.equal(mine.find((s) => s.id === sid)?.archived, true, "the original is archived for the mover");
  const audits = (await built.auditLog.events(tenant)).filter((e) => e.action === "session.move");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.resource, sid);
  assert.equal(audits[0]!.scopeLabel, scope);
});

test("moves are refused for non-members, busy chats, strangers, and non-project targets", async () => {
  const { built, scope, personal } = await setup();
  const outsiders = await personal("outsider", "web:outsider:move", "Not a member here");
  assert.deepEqual(await built.app.moveSession(outsiders, "outsider", scope), { moved: false, reason: "forbidden" });

  const sid = await personal("owner", "web:owner:move-2", "Some private notes");
  assert.deepEqual(await built.app.moveSession(sid, "member", scope), { moved: false, reason: "not_found" });
  assert.deepEqual(await built.app.moveSession(sid, "owner", "personal:owner"), {
    moved: false,
    reason: "same_scope",
  });
  assert.deepEqual(await built.app.moveSession(sid, "owner", "personal:member"), {
    moved: false,
    reason: "not_project",
  });
  const sideChat = await built.app.forkSession(sid, "owner", {
    sideChat: { entrySeq: 0, quote: "private notes", occurrence: 0 },
  });
  assert.deepEqual(await built.app.moveSession(sideChat!.session.id, "owner", scope), {
    moved: false,
    reason: "unsupported_source",
  });

  const thread = (await built.sessions.get(sid))!.threadRef;
  const actor = { id: "internal:owner", type: "internal" as const };
  const conversation = { kind: "dm" as const, threadRef: thread, audience: [actor] };
  await built.runs.enqueue({
    sessionId: thread,
    request: { actor, conversation, origin: { kind: "direct" as const }, text: "Keep going" },
  });
  assert.deepEqual(await built.app.moveSession(sid, "owner", scope), { moved: false, reason: "busy" });
  assert.equal((await built.sessions.listByScope(scope)).length, 0, "refused moves create nothing");
  assert.equal((await built.app.listSessions({ actorId: "owner" })).find((s) => s.id === sid)?.archived, undefined);
});

test("the move route binds the principal to the portal identity and maps refusals to statuses", async () => {
  const { built, scope, personal } = await setup();
  const sid = await personal("owner", "web:owner:move-route", "Route move");
  const outsiders = await personal("outsider", "web:outsider:move-route", "Route refusal");
  const sourceSecret = "session-move-source-secret-for-http-tests";
  const identitySecret = "session-move-identity-secret-for-http-tests";
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    capabilitySecret: "session-move-capability-secret-for-http-tests",
    portalIdentitySecret: identitySecret,
    production: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const move = async (id: string, principal: string, body: Record<string, unknown>) => {
    const path = `/v1/sessions/${id}/move?nonce=${crypto.randomUUID()}`;
    const payload = JSON.stringify({ principalId: principal, ...body });
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedRequestHeaders(sourceSecret, "POST", path, payload),
        "x-portal-identity": await mintSignedPayload({ p: principal, exp: Date.now() + 60_000 }, identitySecret),
      },
      body: payload,
    });
  };
  try {
    assert.equal((await move(sid, "owner", {})).status, 400);
    const refused = await move(outsiders, "outsider", { scopeId: scope });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { message: string }).message, "You're not a member of that project.");
    const ok = await move(sid, "owner", { scopeId: scope });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { session: { scopeId: string } };
    assert.equal(body.session.scopeId, scope);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
