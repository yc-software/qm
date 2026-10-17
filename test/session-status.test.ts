import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { scopeId } from "../src/types.ts";
import type { WebhookReceiver } from "../src/webhooks/webhook-receiver.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const statusToken = "session-status-only-token".repeat(3);
const hookSecret = "hook-secret";
const auth = { authorization: `Bearer ${statusToken}` };
const home = scopeId("personal", "U1");

function fixture(options: { token?: string | null; sessions?: SessionStore; deliveries?: Map<string, boolean> } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const sessions = options.sessions ?? createMemorySessionStore();
  const runs = createMemoryRunStore().runs;
  const deliveries = options.deliveries ?? new Map<string, boolean>();
  const webhookReceiver: WebhookReceiver = {
    deliver: async () => ({ status: 404 }),
    delivery: async (ref) => (deliveries.has(ref) ? { failed: deliveries.get(ref)! } : null),
  };
  const token = options.token === undefined ? statusToken : options.token;
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    sessions,
    runs,
    webhookReceiver,
    ...(token ? { sessionStatusToken: token } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const status = async (session: string, headers: Record<string, string> = auth) => {
    const res = await fetch(`${base}/v1/session-status?session=${encodeURIComponent(session)}`, { headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { sessions, runs, deliveries, base, status, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const request = (threadRef: string) =>
  ({
    surface: "webhook",
    actor: { id: "U1", externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "private webhook payload",
    triggered: true,
  }) as unknown as OrchestratorInput;

test("session status: absent unless a token is configured", async () => {
  const s = fixture({ token: null });
  try {
    assert.equal((await s.status("webhook:w1:d1")).status, 404);
  } finally {
    await s.close();
  }
});

test("session status: missing, wrong and source-signed requests are refused before any read", async () => {
  const sessions = createMemorySessionStore();
  let reads = 0;
  const getByThread = sessions.getByThread.bind(sessions);
  sessions.getByThread = async (ref) => {
    reads++;
    return getByThread(ref);
  };
  const s = fixture({ sessions });
  try {
    const path = "/v1/session-status?session=webhook%3Aw1%3Ad1";
    const ts = Math.floor(Date.now() / 1000);
    for (const headers of [
      {},
      { authorization: `Bearer ${statusToken}x` },
      { authorization: statusToken },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-timestamp": String(ts), "x-signature": signRequest(sourceSecret, ts, `GET\n${path}\n`) },
    ] as Record<string, string>[]) {
      assert.equal((await fetch(s.base + path, { headers })).status, 401, JSON.stringify(headers));
    }
    assert.equal(reads, 0);
  } finally {
    await s.close();
  }
});

test("session status: a known delivery is accepted until its run starts, or failed if its fire failed", async () => {
  const s = fixture();
  try {
    s.deliveries.set("webhook:w1:d1", false);
    s.deliveries.set("webhook:w1:d2", true);
    assert.deepEqual((await s.status("webhook:w1:d1")).body, {
      sessionRef: "webhook:w1:d1",
      sessionId: null,
      state: "accepted",
      outcome: null,
      runId: null,
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    assert.equal((await s.status("webhook:w1:d2")).body.state, "failed");
    const { run } = await s.runs.enqueue({ sessionId: "webhook:w1:d1", request: request("webhook:w1:d1") });
    const queued = (await s.status("webhook:w1:d1")).body;
    assert.equal(queued.state, "running");
    assert.equal(queued.runId, run.id);
  } finally {
    await s.close();
  }
});

test("session status: a webhook session reports running through its subagents, then idle or failed, without content", async () => {
  const s = fixture();
  try {
    const ref = "webhook:w1:d1";
    const session = await s.sessions.getOrCreateByThread(ref, "dm", home, undefined, "webhook");
    const child = await s.sessions.getOrCreateByThread("agent:main:subagent:c1", "dm", home, undefined, "web");
    await s.sessions.setParentSession(child.id, session.id);

    await s.runs.enqueue({ sessionId: ref, request: request(ref) });
    const claimed = await s.runs.claim("worker-1", 60_000);
    let body = (await s.status(ref)).body;
    assert.equal(body.state, "running");
    assert.equal(body.sessionId, session.id);
    assert.equal(typeof body.startedAt, "number");

    await s.runs.complete(claimed!.id, claimed!.leaseToken!, { status: "ok", reply: "secret reply text" });
    await s.runs.enqueue({ sessionId: child.threadRef, request: request(child.threadRef) });
    assert.equal((await s.status(ref)).body.state, "running");
    const childRun = await s.runs.claim("worker-1", 60_000);
    await s.runs.complete(childRun!.id, childRun!.leaseToken!, { status: "ok" });

    const byRef = await s.status(ref);
    const byId = await s.status(session.id);
    assert.deepEqual(byId, byRef);
    assert.equal(byRef.body.state, "idle");
    assert.equal(byRef.body.outcome, "ok");
    assert.equal(typeof byRef.body.finishedAt, "number");
    assert.doesNotMatch(JSON.stringify(byRef.body), /secret reply text|private webhook payload/);

    await s.runs.enqueue({ sessionId: ref, request: request(ref) });
    const failing = await s.runs.claim("worker-1", 60_000);
    await s.runs.fail(failing!.id, failing!.leaseToken!, "boom", { retry: false });
    body = (await s.status(ref)).body;
    assert.equal(body.state, "failed");
    assert.doesNotMatch(JSON.stringify(body), /boom/);
  } finally {
    await s.close();
  }
});

test("session status: sessions not started by a webhook, unknown ids and invented refs are not found", async () => {
  const s = fixture();
  try {
    const dm = await s.sessions.getOrCreateByThread("dm:U1:t1", "dm", home, undefined, "slack");
    for (const key of [dm.id, dm.threadRef, "no-such-session", "webhook:w1:never-delivered"]) {
      assert.equal((await s.status(key)).status, 404, key);
    }
    assert.equal((await fetch(`${s.base}/v1/session-status`, { headers: auth })).status, 400);
    assert.equal((await s.status(`webhook:${"x".repeat(600)}`)).status, 400);
  } finally {
    await s.close();
  }
});

test("session status: a webhook delivery's sessionRef tracks its session through to idle", async () => {
  const built = buildApp(testConfig({ signingSecret: sourceSecret, dataDir: mkdtempSync(join(tmpdir(), "wh-")) }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    webhookReceiver: built.webhookReceiver,
    sessions: built.sessions,
    runs: built.runs,
    sessionStatusToken: statusToken,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const webhook = await built.app.createWebhook({
      ownerScopeId: home,
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "github", secret: hookSecret },
    });
    const eventBody = JSON.stringify({ action: "opened" });
    const accepted = await fetch(`${base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", hookSecret).update(eventBody).digest("hex"),
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(accepted.status, 202);
    const receipt: any = await accepted.json();
    assert.equal(receipt.ok, true);
    assert.equal(receipt.sessionRef, `webhook:${webhook.id}:${receipt.deliveryId}`);

    let body: any;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${base}/v1/session-status?session=${encodeURIComponent(receipt.sessionRef)}`, {
        headers: auth,
      });
      body = await res.json();
      if (body.state === "idle" || body.state === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(body.state, "idle");
    const session = await built.sessions.getByThread(receipt.sessionRef);
    assert.equal(session?.surface, "webhook");
    assert.equal(body.sessionId, session.id);
    assert.equal(typeof body.runId, "string");
    assert.deepEqual(await built.webhookReceiver.delivery(receipt.sessionRef), { failed: false });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
