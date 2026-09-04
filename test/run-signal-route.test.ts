import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "run-signal-")) }));
const core = createServer(built.app, { signingSecret: SECRET, webhookReceiver: built.webhookReceiver });
core.listen(0);
const corePort = (core.address() as AddressInfo).port;
const coreBase = `http://localhost:${corePort}`;

process.env.CORE_API_URL = coreBase;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

const actor: Principal = { id: "internal:U1", type: "internal" };
function request(text: string, threadRef = "t-signal"): OrchestratorInput {
  return { actor, conversation: { kind: "dm", threadRef, audience: [actor] }, origin: { kind: "direct" }, text };
}

async function coreSignal(runId: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = `/v1/runs/${encodeURIComponent(runId)}/signal`;
  const raw = JSON.stringify(body);
  const r = await fetch(`${coreBase}${path}`, {
    method: "POST",
    headers: signedHeaders(SECRET, "POST", path, raw),
    body: raw,
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${encodeURIComponent(user)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}

test("core route: signals for a pending run are accepted (abort, steer)", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-accept", request: request("hi") });
  for (const body of [{ kind: "steer", text: "go left" }, { kind: "abort" }]) {
    const r = await coreSignal(run.id, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, true);
  }
});

test("core route: steer without text is rejected 400", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-notext", request: request("hi") });
  for (const body of [{ kind: "steer" }, { kind: "steer", text: "   " }]) {
    const r = await coreSignal(run.id, body);
    assert.equal(r.status, 400);
    assert.equal(r.json.accepted, false);
  }
});

test("core route: a bad kind is rejected 400, an unknown run 404", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-bad", request: request("hi") });
  assert.equal((await coreSignal(run.id, { kind: "explode" })).status, 400);
  assert.equal((await coreSignal("no-such-run", { kind: "abort" })).status, 404);
});

test("core route: a terminal run rejects signals with reason=terminal", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-terminal", request: request("hi") });
  const claimed = await built.runs.claimById(run.id, "test-worker", 5_000);
  assert.ok(claimed);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const r = await coreSignal(run.id, { kind: "abort" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { accepted: false, reason: "terminal" });
});

test("web proxy: the submitting user can signal their run; others (and token-less strangers) cannot", async () => {
  const submit = (await (
    await fetch(`${webBase}/api/turn`, asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me" }) }))
  ).json()) as { runId?: string; runToken?: string };
  assert.ok(submit.runId, "async turn returns a runId");
  assert.equal(submit.runToken, undefined, "no bearer credential is exposed to browser code or URLs");

  const ok = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", { method: "POST", body: JSON.stringify({ kind: "steer", text: "louder" }) }),
  );
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { accepted?: boolean }).accepted, true);

  const stranger = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("bob", { method: "POST", body: JSON.stringify({ kind: "abort" }) }),
  );
  assert.equal(stranger.status, 404, "a non-owner without a token is told the run does not exist");
});

test("web proxy: Project roster revisions revoke pending run status, signals, and events", async () => {
  await built.app.upsertDirectory([
    { principalId: "project-owner", displayName: "Project Owner", type: "internal" },
    { principalId: "project-member", displayName: "Project Member", type: "internal" },
    { principalId: "project-late-member", displayName: "Late Member", type: "internal" },
  ]);
  const project = await built.app.createProject("project-owner", "Run access");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-member")).status, "ok");

  const threadRef = `web:project-owner:${crypto.randomUUID()}`;
  const submitted = await fetch(
    `${webBase}/api/turn`,
    asUser("project-owner", {
      method: "POST",
      body: JSON.stringify({
        text: "queued project work",
        threadRef,
        scopeId: project.scopeId,
        channelName: project.name,
      }),
    }),
  );
  assert.equal(submitted.status, 202);
  const queued = (await submitted.json()) as { runId?: string; runToken?: string };
  assert.ok(queued.runId);
  assert.equal(queued.runToken, undefined);

  const discovered = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-member"))
  ).json()) as { runId?: string | null; runToken?: string };
  assert.equal(
    discovered.runId,
    queued.runId,
    "a member rediscovers the creator's run without an instance-local index",
  );
  assert.equal(discovered.runToken, undefined);

  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-late-member")).status, "ok");
  const lateMember = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-late-member"))
  ).json()) as { runId?: string | null };
  assert.equal(lateMember.runId, null, "joining a Project does not reveal a turn from the prior roster");
  assert.equal(
    (
      (await (
        await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-member"))
      ).json()) as { runId?: string | null }
    ).runId,
    null,
    "a roster change invalidates the prior revision's run for every member",
  );

  const outsider = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-outsider"))
  ).json()) as { runId?: string | null };
  assert.equal(outsider.runId, null, "core's viewer gate hides the run from non-members");

  const currentThreadRef = `web:project-owner:${crypto.randomUUID()}`;
  const currentSubmit = await fetch(
    `${webBase}/api/turn`,
    asUser("project-owner", {
      method: "POST",
      body: JSON.stringify({
        text: "current project work",
        threadRef: currentThreadRef,
        scopeId: project.scopeId,
        channelName: project.name,
      }),
    }),
  );
  assert.equal(currentSubmit.status, 202);
  const current = (await currentSubmit.json()) as { runId?: string };
  assert.ok(current.runId);
  const currentDiscovery = (await (
    await fetch(
      `${webBase}/api/runs/active?threadRef=${encodeURIComponent(currentThreadRef)}`,
      asUser("project-member"),
    )
  ).json()) as { runId?: string | null; runToken?: string };
  assert.equal(currentDiscovery.runId, current.runId);
  assert.equal(currentDiscovery.runToken, undefined);

  const statusPath = `/api/runs/${encodeURIComponent(current.runId!)}`;
  assert.equal((await fetch(`${webBase}${statusPath}`, asUser("project-member"))).status, 200);

  assert.equal((await built.app.removeProjectMember(project.id, "project-owner", "project-member")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-member")).status, "ok");
  const active = (await (
    await fetch(
      `${webBase}/api/runs/active?threadRef=${encodeURIComponent(currentThreadRef)}`,
      asUser("project-member"),
    )
  ).json()) as { runId?: string | null };
  assert.equal(active.runId, null);
  assert.equal((await fetch(`${webBase}${statusPath}`, asUser("project-member"))).status, 404);

  const signal = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(current.runId!)}/signal`,
    asUser("project-member", {
      method: "POST",
      body: JSON.stringify({ kind: "abort" }),
    }),
  );
  assert.equal(signal.status, 404);

  const events = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(current.runId!)}/events`,
    asUser("project-member"),
  );
  assert.equal(events.status, 404);
});

test("web proxy: a Project member can resolve their own approval in another member's thread", async () => {
  await built.app.upsertDirectory([
    { principalId: "approval-owner", displayName: "Approval Owner", type: "internal" },
    { principalId: "approval-member", displayName: "Approval Member", type: "internal" },
  ]);
  const project = await built.app.createProject("approval-owner", "Shared approvals");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "approval-owner", "approval-member")).status, "ok");
  const threadRef = `web:approval-owner:${crypto.randomUUID()}`;
  const channelRef = project.scopeId.slice("group:".length);
  const conversation = { kind: "group" as const, channelRef, channelName: project.name, threadRef, audience: [] };

  assert.equal(
    (await built.app.turn({ surface: "web", actor: { externalId: "approval-owner" }, conversation, text: "start" }))
      .status,
    "ok",
  );
  const pending = await built.app.turn({
    surface: "web",
    actor: { externalId: "approval-member" },
    conversation,
    text: "!run git push --force origin main",
  });
  assert.equal(pending.status, "pending_approval");
  const requestId = pending.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  const approved = await fetch(
    `${webBase}/api/approvals/${encodeURIComponent(requestId)}`,
    asUser("approval-member", { method: "POST", body: JSON.stringify({ approved: true }) }),
  );
  assert.equal(approved.status, 202);
  assert.ok(((await approved.json()) as { runId?: string }).runId);
});

test("run control follows current shared membership while public history requires an active principal", async () => {
  await built.app.upsertChannels(
    [
      { channelId: "C-RUN", name: "run-room", isPrivate: true },
      { channelId: "C-PUBLIC-RUN", name: "public-run", isPrivate: false },
    ],
    [
      { channelId: "C-RUN", principalId: "shared-owner" },
      { channelId: "C-RUN", principalId: "shared-member" },
    ],
  );
  await built.app.upsertGroups([
    { groupId: "G-RUN", principalId: "shared-owner" },
    { groupId: "G-RUN", principalId: "shared-member" },
  ]);

  for (const shared of [
    { kind: "channel" as const, ref: "C-RUN", scope: "channel:C-RUN" as const },
    { kind: "group" as const, ref: "G-RUN", scope: "group:G-RUN" as const },
  ]) {
    const threadRef = `shared-run:${shared.ref}`;
    const owner = { id: "shared-owner", type: "internal" as const };
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        actor: owner,
        conversation: { kind: shared.kind, channelRef: shared.ref, threadRef, audience: [owner] },
        origin: { kind: "direct" },
        text: "queued shared work",
      },
    });
    const session = await built.sessions.getOrCreateByThread(threadRef, shared.kind, shared.scope, shared.ref, "web");
    await built.sessions.addParticipant(session.id, "shared-member");
    assert.ok(await built.app.getRun(run.id, "shared-member"));
    if (shared.kind === "channel") {
      await built.app.upsertChannels(
        [
          { channelId: "C-RUN", name: "run-room", isPrivate: true },
          { channelId: "C-PUBLIC-RUN", name: "public-run", isPrivate: false },
        ],
        [{ channelId: "C-RUN", principalId: "shared-owner" }],
      );
    } else {
      await built.app.upsertGroups([{ groupId: "G-RUN", principalId: "shared-owner" }]);
    }
    assert.ok(
      await built.app.getSessionForViewer(session.id, "shared-member"),
      "history remains readable through the participant window",
    );
    assert.equal(await built.app.getRun(run.id, "shared-member"), null);
    assert.deepEqual(await built.app.signalRun(run.id, { kind: "abort" }, "shared-member"), {
      accepted: false,
      reason: "not_found",
    });
  }

  const publicMember = "public-history-member";
  const publicThread = "shared-run:public";
  const publicOwner = { id: "public-owner", type: "internal" as const };
  const { run: publicRun } = await built.runs.enqueue({
    sessionId: publicThread,
    request: {
      actor: publicOwner,
      conversation: { kind: "channel", channelRef: "C-PUBLIC-RUN", threadRef: publicThread, audience: [publicOwner] },
      origin: { kind: "direct" },
      text: "queued public work",
    },
  });
  const publicSession = await built.sessions.getOrCreateByThread(
    publicThread,
    "channel",
    "channel:C-PUBLIC-RUN",
    "public-run",
    "web",
  );
  await built.sessions.addParticipant(publicSession.id, publicMember);
  assert.ok(await built.app.getRun(publicRun.id, publicMember));
  await built.identity.deactivate(publicMember);
  assert.equal(await built.app.getRun(publicRun.id, publicMember), null);
  await built.identity.reactivate(publicMember);
});

test("web proxy: /api/runs/active tracks queued runs — the live one first, the queued one after it finishes", async () => {
  const threadRef = `web:carol:${crypto.randomUUID()}`;
  const submitTwice = async (text: string): Promise<string> => {
    const r = (await (
      await fetch(`${webBase}/api/turn`, asUser("carol", { method: "POST", body: JSON.stringify({ text, threadRef }) }))
    ).json()) as { runId?: string };
    assert.ok(r.runId);
    return r.runId!;
  };
  const first = await submitTwice("turn one");
  const second = await submitTwice("turn two");
  assert.notEqual(first, second);

  const active1 = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("carol"))
  ).json()) as { runId?: string | null };
  assert.equal(active1.runId, first, "the oldest live run is the active one");

  const claimed = await built.runs.claimById(first, "test-worker", 5_000);
  assert.ok(claimed);
  await built.runs.complete(first, claimed!.leaseToken!, { status: "ok", reply: "done" });

  const active2 = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("carol"))
  ).json()) as { runId?: string | null };
  assert.equal(active2.runId, second, "once the live run finishes, the queued one becomes active");
});
