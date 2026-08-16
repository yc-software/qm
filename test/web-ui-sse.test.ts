import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-sse-")) }));
built.runtime.start();
const core = createServer(built.app, { signingSecret: SECRET, webhookReceiver: built.webhookReceiver });
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
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

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice("event: ".length);
    const dataLine = lines.find((l) => l.startsWith("data: "))?.slice("data: ".length);
    if (!event) continue;
    let data: unknown = undefined;
    try {
      data = dataLine ? JSON.parse(dataLine) : undefined;
    } catch {
      void 0;
    }
    out.push({ event, data });
  }
  return out;
}

test("SSE streams partial frames then a terminal done frame carrying the reply", async () => {
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "stream me?" }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const res = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(res.headers.get("x-accel-buffering"), "no");

  const events = parseSse(await res.text());
  const partials = events.filter((e) => e.event === "partial");
  const done = events.find((e) => e.event === "done");

  assert.ok(partials.length >= 1, "expected at least one partial frame");
  assert.ok(done, "expected a terminal done frame");
  const d = done.data as { status?: string; result?: { status?: string; reply?: string }; replyComplete?: boolean };
  assert.equal(d.status, "done");
  assert.equal(d.result?.status, "ok");
  assert.match(d.result?.reply ?? "", /You said: stream me\?/);
  assert.equal(d.replyComplete, true, "done frame flags the reply as final");
});

test("SSE relays tool activity frames and folds them into the done frame", async () => {
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "!run echo hi" }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const res = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());

  const activityFrames = events.filter((e) => e.event === "activity");
  assert.ok(activityFrames.length >= 1, "expected at least one activity frame for the tool steps");

  const done = events.find((e) => e.event === "done");
  assert.ok(done, "expected a terminal done frame");
  const d = done.data as { activity?: Array<{ type?: string }>; startedAt?: number | null; finishedAt?: number | null };
  const types = (d.activity ?? []).map((a) => a.type);
  assert.ok(types.includes("tool_call") && types.includes("tool_result"), "done frame carries the tool activity");
  assert.equal(typeof d.startedAt, "number", "done frame carries startedAt");
  assert.equal(typeof d.finishedAt, "number", "done frame carries finishedAt");
});

test("active run lookup returns the latest tracked run for the caller's web thread", async () => {
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "track me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const activeRes = await fetch(
    `${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("alice"),
  );
  assert.equal(activeRes.status, 200);
  const active = (await activeRes.json()) as { runId?: string | null; run?: { status?: string } | null };
  assert.equal(active.runId, submit.runId);
  assert.ok(
    ["pending", "running", "done", "failed"].includes(active.run?.status ?? ""),
    "active lookup returns a run snapshot",
  );

  const otherUser = await fetch(
    `${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("mallory"),
  );
  assert.equal(otherUser.status, 200);
  assert.equal(((await otherUser.json()) as { runId?: string | null }).runId, null);

  const nonWeb = await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent("dm:D1")}`, asUser("alice"));
  assert.equal(nonWeb.status, 404);
});

test("active run lookup is cleared after the events stream reaches a terminal frame", async () => {
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "cleanup me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const events = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(events.status, 200);
  parseSse(await events.text());

  const activeRes = await fetch(
    `${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("alice"),
  );
  assert.equal(activeRes.status, 200);
  const active = (await activeRes.json()) as { runId?: string | null; run?: unknown };
  assert.equal(active.runId, null);
  assert.equal(active.run, null);
});

test("web command approval pause is durable and blocks fresh input for the thread", async () => {
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", {
        method: "POST",
        body: JSON.stringify({ text: "!run git push --force origin main", threadRef }),
      }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const events = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(events.status, 200);
  const done = parseSse(await events.text()).find((e) => e.event === "done");
  assert.ok(done);
  const doneData = done.data as { result?: { status?: string; pendingApprovals?: Array<{ requestId?: string }> } };
  assert.equal(doneData.result?.status, "pending_approval");
  const requestId = doneData.result?.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  const blocked = await fetch(
    `${webBase}/api/turn`,
    asUser("alice", { method: "POST", body: JSON.stringify({ text: "can you keep going?", threadRef }) }),
  );
  assert.equal(blocked.status, 200);
  const blockedBody = (await blocked.json()) as { status?: string; runId?: string };
  assert.equal(blockedBody.status, "pending_approval");
  assert.equal(blockedBody.runId, undefined);

  const denied = await fetch(
    `${webBase}/api/approvals/${encodeURIComponent(requestId)}`,
    asUser("alice", { method: "POST", body: JSON.stringify({ approved: false }) }),
  );
  assert.equal(denied.status, 202);
  assert.ok(((await denied.json()) as { runId?: string }).runId);
});

test("the events route is ownership-gated (404 for a run the caller doesn't own)", async () => {
  const res = await fetch(`${webBase}/api/runs/not-my-run/events`, asUser("mallory"));
  assert.equal(res.status, 404);
});

test("the events route requires a signed-in principal (401 without a cookie)", async () => {
  const res = await fetch(`${webBase}/api/runs/whatever/events`);
  assert.equal(res.status, 401);
});
