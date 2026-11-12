import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { configureCommandRules } from "./support/command-rules.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-sse-")) }));
built.runtime.start();
await configureCommandRules(built.config);
const core = createServer(built.app, {
  ...browserSessionDeps,
  replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  signingSecret: SECRET,
  webhookReceiver: built.webhookReceiver,
});
core.listen(0);
const corePort = (core.address() as AddressInfo).port;
const coreBase = `http://localhost:${corePort}`;

after(async () => {
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: browserSessionCookie(user),
      origin: browserSessionDeps.portalUrl,
      ...init.headers,
    },
  };
}

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (!data) return [];
    const event = JSON.parse(data) as { type: string; name?: string; value?: unknown };
    if (event.type !== "CUSTOM") return [{ event: event.type, data: event }];
    const run = event.value as { status?: string; result?: unknown };
    if (event.name === "run" && (run.status === "done" || run.status === "failed" || run.result != null))
      return [{ event: "done", data: run }];
    return [{ event: event.name ?? event.type, data: event.value }];
  });
}

test("SSE streams partial frames then a terminal done frame carrying the reply", async () => {
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "stream me?" }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const res = await fetch(
    `${coreBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");

  const events = parseSse(await res.text());
  const partials = events.filter((e) => e.event === "delta" || Boolean((e.data as { partial?: string }).partial));
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
  const computer = await built.sandboxResources.create("alice", "personal:alice", "sprites", "default");
  await built.sandboxResources.setDefault("alice", "personal:alice", computer.id);
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "!run echo hi" }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const res = await fetch(
    `${coreBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());

  const activityFrames = events.filter((e) => e.event === "run" || e.event === "done");
  assert.ok(activityFrames.length >= 1, "expected at least one activity frame for the tool steps");

  const done = events.find((e) => e.event === "done");
  assert.ok(done, "expected a terminal done frame");
  const d = done.data as {
    activity?: Array<{ item?: { kind?: string } }>;
    startedAt?: number | null;
    finishedAt?: number | null;
  };
  const kinds = (d.activity ?? []).map((a) => a.item?.kind);
  assert.ok(kinds.includes("ToolCall") && kinds.includes("ToolResult"), "done frame carries the tool activity");
  assert.equal(typeof d.startedAt, "number", "done frame carries startedAt");
  assert.equal(typeof d.finishedAt, "number", "done frame carries finishedAt");
});

test("active run lookup returns the latest tracked run for the caller's web thread", async (t) => {
  const completion = Promise.withResolvers<void>();
  const complete = built.runs.complete.bind(built.runs);
  t.mock.method(built.runs, "complete", async (...args: Parameters<typeof complete>) => {
    await completion.promise;
    return complete(...args);
  });
  t.after(() => completion.resolve());
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "track me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const activeRes = await fetch(
    `${coreBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("alice"),
  );
  assert.equal(activeRes.status, 200);
  const active = (await activeRes.json()) as { runId?: string | null; run?: { status?: string } | null };
  assert.equal(active.runId, submit.runId);
  assert.ok(["pending", "running"].includes(active.run?.status ?? ""), "active lookup returns a run snapshot");

  const otherUser = await fetch(
    `${coreBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("mallory"),
  );
  assert.equal(otherUser.status, 200);
  assert.equal(((await otherUser.json()) as { runId?: string | null }).runId, null);
});

test("active run lookup is cleared after the events stream reaches a terminal frame", async () => {
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "cleanup me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const events = await fetch(
    `${coreBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(events.status, 200);
  parseSse(await events.text());

  const activeRes = await fetch(
    `${coreBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`,
    asUser("alice"),
  );
  assert.equal(activeRes.status, 200);
  const active = (await activeRes.json()) as { runId?: string | null; run?: unknown };
  assert.equal(active.runId, null);
  assert.equal(active.run, null);
});

test("web command approval pause is durable and doesn't hold up fresh input for the thread", async () => {
  const threadRef = `web:alice:${randomUUID()}`;
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", {
        method: "POST",
        body: JSON.stringify({ text: "!run git push --force origin main", threadRef }),
      }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId, "async turn should return a runId");

  const events = await fetch(
    `${coreBase}/api/runs/${encodeURIComponent(submit.runId)}/events`,
    asUser("alice", { signal: AbortSignal.timeout(20_000) }),
  );
  assert.equal(events.status, 200);
  const done = parseSse(await events.text()).find((e) => e.event === "done");
  assert.ok(done);
  const doneData = done.data as { result?: { status?: string; pendingApprovals?: Array<{ requestId?: string }> } };
  assert.equal(doneData.result?.status, "pending_approval");
  const requestId = doneData.result?.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  const followUp = await fetch(
    `${coreBase}/api/turn`,
    asUser("alice", { method: "POST", body: JSON.stringify({ text: "can you keep going?", threadRef }) }),
  );
  assert.equal(followUp.status, 202);
  const followUpRun = ((await followUp.json()) as { runId?: string }).runId;
  assert.ok(followUpRun, "the follow-up runs instead of bouncing off the card");
  await built.runs.waitFor(followUpRun, 10_000);

  const denied = await fetch(
    `${coreBase}/api/approvals/${encodeURIComponent(requestId)}`,
    asUser("alice", { method: "POST", body: JSON.stringify({ approved: false }) }),
  );
  assert.equal(denied.status, 202);
  assert.ok(((await denied.json()) as { runId?: string }).runId);
});

test("the events route is ownership-gated (404 for a run the caller doesn't own)", async () => {
  const res = await fetch(`${coreBase}/api/runs/not-my-run/events`, asUser("mallory"));
  assert.equal(res.status, 404);
});

test("the events route requires a signed-in principal (401 without a cookie)", async () => {
  const res = await fetch(`${coreBase}/api/runs/whatever/events`);
  assert.equal(res.status, 401);
});

test("a completed long stream replays its bounded tail with absolute offsets and its full reply", async () => {
  const text = "long output ".repeat(20_000) + "last sentence";
  const submit = (await (
    await fetch(
      `${coreBase}/api/turn`,
      asUser("alice", {
        method: "POST",
        body: JSON.stringify({ text, threadRef: `web:alice:${randomUUID()}` }),
      }),
    )
  ).json()) as { runId: string };
  await built.runs.waitFor(submit.runId, 10_000);
  const res = await fetch(
    `${coreBase}/api/runs/${submit.runId}/events`,
    asUser("alice", {
      signal: AbortSignal.timeout(20_000),
    }),
  );
  const done = parseSse(await res.text()).find((event) => event.event === "done")!.data as {
    partial: string;
    partialStartOffset: number;
    result: { reply: string };
  };
  assert.ok(done.partial.length <= 200_000);
  assert.ok(done.partial.length >= 100_000);
  assert.ok(done.partialStartOffset > 0);
  assert.equal(done.result.reply.slice(done.partialStartOffset), done.partial);
  assert.ok(done.partial.includes("last sentence"));
});
