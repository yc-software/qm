import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { scopeId } from "../src/types.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { testTenant } from "./support/test-tenant.ts";

const SECRET = "web-run-ownership-secret".repeat(2);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "web-run-owner-")) }));
const core = createServer(built.app, {
  ...browserSessionDeps,
  replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  signingSecret: SECRET,
});
core.listen(0);
const coreBase = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

function browser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: browserSessionCookie(user),
      origin: browserSessionDeps.portalUrl,
    },
  };
}

test("another user cannot see a run's queued text, or edit, withdraw or answer its runs", async () => {
  const threadRef = `web:alice:${crypto.randomUUID()}`;
  const submit = async (text: string): Promise<string> => {
    const r = await fetch(
      `${coreBase}/api/turn`,
      browser("alice", { method: "POST", body: JSON.stringify({ text, threadRef, midTurn: "queue" }) }),
    );
    const runId = ((await r.json()) as { runId?: string }).runId;
    assert.ok(runId);
    return runId;
  };
  const live = await submit("alice private first");
  const queued = await submit("alice private second");
  const discover = (user: string) =>
    fetch(`${coreBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, browser(user));
  assert.deepEqual(((await (await discover("alice")).json()) as { queued?: Array<{ text: string }> }).queued, [
    { runId: queued, text: "alice private second" },
  ]);
  assert.deepEqual(await (await discover("bob")).json(), { runId: null, run: null });
  const edit = await fetch(
    `${coreBase}/api/runs/${queued}/input`,
    browser("bob", {
      method: "PATCH",
      body: JSON.stringify({ text: "rewritten", expectedText: "alice private second" }),
    }),
  );
  assert.equal(edit.status, 404);
  assert.equal(
    (await fetch(`${coreBase}/api/runs/${queued}/withdraw`, browser("bob", { method: "POST" }))).status,
    404,
  );
  const answer = JSON.stringify({ kind: "client_result", callId: "c1", result: { content: "forged" } });
  assert.equal(
    (await fetch(`${coreBase}/api/runs/${live}/signal`, browser("bob", { method: "POST", body: answer }))).status,
    404,
  );
  assert.deepEqual(await built.signals.takePending(live), []);
  const untouched = await built.runs.get(queued);
  assert.equal(untouched?.status, "pending");
  assert.equal(untouched?.request.text, "alice private second");
  const withdrawn = await fetch(`${coreBase}/api/runs/${queued}/withdraw`, browser("alice", { method: "POST" }));
  assert.deepEqual([withdrawn.status, ((await withdrawn.json()) as { withdrawn?: boolean }).withdrawn], [200, true]);
});

test("another user cannot inspect or control a session's swarm", async () => {
  const session = await built.sessions.getOrCreateByThread(
    `web:alice:${crypto.randomUUID()}`,
    "dm",
    scopeId("personal", "alice"),
  );
  await built.sessions.addParticipant(session.id, "alice");
  const path = `${coreBase}/api/sessions/${encodeURIComponent(session.id)}/swarm`;
  const control = JSON.stringify({ action: "control", memberId: "m1", state: "stopped" });
  assert.notEqual((await fetch(path, browser("alice"))).status, 403);
  assert.equal((await fetch(path, browser("bob"))).status, 403);
  assert.equal((await fetch(path, browser("bob", { method: "POST", body: control }))).status, 403);
  for (const action of ["spawn", "send", "context"]) {
    const refused = await fetch(
      path,
      browser("alice", { method: "POST", body: JSON.stringify({ action, requestId: "r", text: "t", context: {} }) }),
    );
    assert.equal(refused.status, 400, action);
    assert.deepEqual(await refused.json(), { error: "only swarm controls are available here" });
  }
});

test("the active-run lookup finds a Slack DM or private-channel run only for someone who may use it", async () => {
  await built.app.upsertChannels(
    testTenant,
    [{ channelId: "PRIVRUNS", name: "private-runs", isPrivate: true }],
    [{ channelId: "PRIVRUNS", principalId: "alice" }],
  );
  const dm = `dm:D-${crypto.randomUUID()}`;
  const channel = `ch:PRIVRUNS:${crypto.randomUUID()}`;
  for (const conversation of [
    { kind: "dm" as const, threadRef: dm, audience: [] },
    { kind: "channel" as const, channelRef: "PRIVRUNS", threadRef: channel, audience: [] },
  ]) {
    const { run } = await built.runs.enqueue({
      sessionId: conversation.threadRef,
      request: {
        surface: "slack",
        actor: { id: "alice", type: "internal" },
        origin: { kind: "human" },
        conversation,
        text: "private work",
      },
    });
    const lookup = async (user: string) =>
      (await fetch(
        `${coreBase}/api/runs/active?threadRef=${encodeURIComponent(conversation.threadRef)}`,
        browser(user),
      ).then((r) => r.json())) as { runId: string | null; run: { status?: string } | null };
    const own = await lookup("alice");
    assert.deepEqual([own.runId, own.run?.status], [run.id, "pending"], conversation.kind);
    assert.deepEqual(await lookup("bob"), { runId: null, run: null }, conversation.kind);
  }
});
