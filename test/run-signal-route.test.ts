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
import { attributedSteerText } from "../src/api/app-turn.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
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

function steererRequest(externalId: string, threadRef: string, text: string, displayName?: string): TurnRequest {
  return {
    surface: "web",
    actor: { externalId, ...(displayName ? { displayName } : {}) },
    conversation: { kind: "dm", threadRef },
    liveActor: true,
    text,
  };
}

test("core route: a steer's ts and request thread through to the signal store", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-fields", request: request("hi", "t-fields") });
  const body = {
    kind: "steer",
    text: "go left",
    ts: "1712.001",
    request: steererRequest("internal:U1", "t-fields", "go left"),
  };
  const r = await coreSignal(run.id, body);
  assert.equal(r.status, 200);
  const [signal] = await built.signals.takePending(run.id);
  assert.ok(signal);
  assert.equal(signal.ts, "1712.001");
  assert.equal(signal.request?.actor.externalId, "internal:U1");
  assert.equal(signal.text, "go left", "the run owner's own steer is not attributed");
});

test("core route: another person's steer is attributed with their display name", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-foreign", request: request("hi", "t-foreign") });
  const r = await coreSignal(run.id, {
    kind: "steer",
    text: "go right",
    ts: "1712.002",
    request: steererRequest("web-eve", "t-foreign", "go right", "Eve Example"),
  });
  assert.equal(r.status, 200);
  const [signal] = await built.signals.takePending(run.id);
  assert.equal(signal?.text, "Eve Example: go right");
  assert.equal(signal?.request?.text, "go right", "the replayable request keeps the steerer's own words");
});

test("core route: a malformed request is rejected 400, and privileged fields are stripped", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-sanitize", request: request("hi", "t-sanitize") });
  const bad = await coreSignal(run.id, { kind: "steer", text: "x", request: { text: "x" } });
  assert.equal(bad.status, 400);

  const smuggled = {
    ...steererRequest("internal:U1", "t-sanitize", "x"),
    ownerKeychainUnion: true,
    spawned: true,
    unattendedGrants: ["admin-read"],
  };
  const r = await coreSignal(run.id, { kind: "steer", text: "x", request: smuggled });
  assert.equal(r.status, 200);
  const [signal] = await built.signals.takePending(run.id);
  assert.ok(signal?.request);
  assert.equal("ownerKeychainUnion" in signal.request, false);
  assert.equal("spawned" in signal.request, false);
  assert.equal("unattendedGrants" in signal.request, false);
});

test("core route: a bare steer without a ts gets one minted so harnesses persist it", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-mint", request: request("hi", "t-mint") });
  const r = await coreSignal(run.id, { kind: "steer", text: "keep going" });
  assert.equal(r.status, 200);
  const [signal] = await built.signals.takePending(run.id);
  assert.ok(signal?.ts, "signalRun mints a ts when the caller sends none");
});

test("signalRun attributes a bare steer from a shared-scope viewer who is not the run's owner", async () => {
  await built.app.upsertChannels(
    [{ channelId: "C-STEER", name: "steer-room", isPrivate: true }],
    [
      { channelId: "C-STEER", principalId: "steer-owner" },
      { channelId: "C-STEER", principalId: "steer-member" },
    ],
  );
  await built.app.upsertDirectory([{ principalId: "steer-member", displayName: "Steer Member", type: "internal" }]);
  const threadRef = "shared-steer:C-STEER";
  const owner = { id: "steer-owner", type: "internal" as const };
  const { run } = await built.runs.enqueue({
    sessionId: threadRef,
    request: {
      actor: owner,
      conversation: { kind: "channel", channelRef: "C-STEER", threadRef, audience: [owner] },
      origin: { kind: "direct" },
      text: "queued shared work",
    },
  });
  const session = await built.sessions.getOrCreateByThread(threadRef, "channel", "channel:C-STEER", "C-STEER", "web");
  await built.sessions.addParticipant(session.id, "steer-member");
  const outcome = await built.app.signalRun(run.id, { kind: "steer", text: "try harder" }, "steer-member");
  assert.equal(outcome.accepted, true);
  const [signal] = await built.signals.takePending(run.id);
  assert.equal(signal?.text, "Steer Member: try harder");
  assert.ok(signal?.ts);
});

test("core route: a request claiming a different conversation than the run's is refused 400", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-bind", request: request("hi", "t-bind") });
  const r = await coreSignal(run.id, {
    kind: "steer",
    text: "over here instead",
    request: steererRequest("internal:U1", "somewhere-else", "over here instead"),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, "conversation_mismatch");
  assert.deepEqual(await built.signals.takePending(run.id), []);
});

test("core route: a portal identity that does not match the request actor is refused 403", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-mismatch", request: request("hi", "t-mismatch") });
  const path = `/v1/runs/${encodeURIComponent(run.id)}/signal`;
  const raw = JSON.stringify({
    kind: "steer",
    text: "as someone else",
    request: steererRequest("mallory", "t-mismatch", "as someone else"),
  });
  const r = await fetch(`${coreBase}${path}`, {
    method: "POST",
    headers: {
      ...signedHeaders(SECRET, "POST", path, raw),
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "eve", exp: Date.now() + 60_000 }, SECRET),
    },
    body: raw,
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await built.signals.takePending(run.id), []);
});

test("an orphaned steer with a request replays as the steerer, not the run's owner", async () => {
  const threadRef = `web:web-eve:${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({
    sessionId: "t-orphan",
    request: { ...request("hi", "t-orphan"), timezone: "America/New_York" },
  });
  const attachment = { name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "blob-1" };
  await built.signals.send(run.id, {
    kind: "steer",
    text: "finish this instead",
    ts: "1712.003",
    request: { ...steererRequest("web-eve", threadRef, "finish this instead"), attachments: [attachment] },
  });
  const claimed = await built.runs.claimById(run.id, "test-worker", 5_000);
  assert.ok(claimed);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.ok(replayed, "the steer text was re-enqueued as its own turn");
  assert.equal(replayed!.request.actor.id, "web-eve");
  assert.equal(replayed!.request.text, "finish this instead");
  assert.deepEqual(replayed!.request.attachments, [attachment], "the steer's own files survive the replay");
  assert.equal(replayed!.request.timezone, "America/New_York", "turn options are inherited from the ended run");
});

test("an orphaned steer whose own request is refused falls back to replaying on the run's request", async () => {
  const threadRef = "t-orphan-fallback";
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: request("hi", threadRef) });
  await built.signals.send(run.id, {
    kind: "steer",
    text: "still matters",
    ts: "1712.004",
    request: {
      surface: "web",
      actor: { externalId: "web-eve" },
      conversation: { kind: "group", threadRef: `web:web-eve:${crypto.randomUUID()}`, channelRef: "G-NOPE" },
      liveActor: true,
      text: "still matters",
    },
  });
  const claimed = await built.runs.claimById(run.id, "test-worker", 5_000);
  assert.ok(claimed);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.ok(replayed, "a refused steerer request still replays the text on the run's own request");
  assert.equal(replayed!.request.actor.id, "internal:U1");
  assert.equal(replayed!.request.text, "still matters");
});

test("attributedSteerText prefixes foreign and ambient steers only", () => {
  const eve = { id: "web-eve", displayName: "Eve Example" };
  assert.equal(attributedSteerText(eve, "web-eve", "hello"), "hello");
  assert.equal(attributedSteerText(eve, "web-alice", "hello"), "Eve Example: hello");
  assert.equal(attributedSteerText({ id: "web-eve" }, "web-alice", "hello"), "web-eve: hello");
  assert.equal(attributedSteerText({ id: "web-eve", displayName: "  " }, "web-alice", "hi"), "web-eve: hi");
  assert.equal(attributedSteerText(eve, null, "hello"), "Eve Example: hello");
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

test("web proxy: a steer carries a server-built ts and TurnRequest for the signed-in user", async () => {
  const threadRef = `web:alice:${crypto.randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId);

  const steer = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({
        kind: "steer",
        text: "louder",
        threadRef,
        ts: "client-forged",
        request: steererRequest("mallory", threadRef, "louder"),
      }),
    }),
  );
  assert.equal(steer.status, 200);

  const [signal] = await built.signals.takePending(submit.runId!);
  assert.ok(signal);
  assert.equal(signal.text, "louder");
  assert.ok(
    signal.ts && signal.ts !== "client-forged",
    "the ts is minted server-side; a client-supplied one is ignored",
  );
  assert.equal(signal.request?.actor.externalId, "alice", "a client-supplied request/actor is ignored");
  assert.equal(signal.request?.surface, "web");
  assert.deepEqual(signal.request?.conversation, { kind: "dm", threadRef });
});

test("web proxy: a steer claiming another user's thread is refused", async () => {
  const submit = (await (
    await fetch(`${webBase}/api/turn`, asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me" }) }))
  ).json()) as { runId?: string };
  assert.ok(submit.runId);
  const steer = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({ kind: "steer", text: "louder", threadRef: "web:bob:stolen" }),
    }),
  );
  assert.equal(steer.status, 403);
  assert.deepEqual(await built.signals.takePending(submit.runId!), []);
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
