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
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "web-run-ownership-secret".repeat(2);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "web-run-owner-")) }));
const core = createServer(built.app, { signingSecret: SECRET });
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
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

function as(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}

async function aliceThread(): Promise<{ threadRef: string; live: string; queued: string }> {
  const threadRef = `web:alice:${crypto.randomUUID()}`;
  const submit = async (text: string): Promise<string> => {
    const r = await fetch(
      `${webBase}/api/turn`,
      as("alice", { method: "POST", body: JSON.stringify({ text, threadRef }) }),
    );
    const runId = ((await r.json()) as { runId?: string }).runId;
    assert.ok(runId);
    return runId;
  };
  return { threadRef, live: await submit("alice private first"), queued: await submit("alice private second") };
}

const active = async (user: string, threadRef: string) =>
  (await (await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, as(user))).json()) as {
    runId: string | null;
    queued?: Array<{ runId: string; text: string }>;
  };

test("another user cannot discover a run, its status or its queued text through /api/runs/active", async () => {
  const { threadRef, live, queued } = await aliceThread();
  const own = await active("alice", threadRef);
  assert.equal(own.runId, live);
  assert.deepEqual(
    own.queued?.map((q) => q.text),
    ["alice private second"],
  );
  const stolen = await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, as("bob"));
  assert.equal(stolen.status, 200);
  const body = await stolen.text();
  assert.deepEqual(JSON.parse(body), { runId: null, run: null });
  for (const leaked of [live, queued, "alice private"]) assert.ok(!body.includes(leaked));
  assert.equal((await fetch(`${webBase}/api/runs/${live}`, as("bob"))).status, 404);
});

test("another user cannot read, stream, signal, edit or withdraw a run", async () => {
  const { threadRef, live, queued } = await aliceThread();
  assert.equal((await fetch(`${webBase}/api/runs/${live}`, as("bob"))).status, 404);
  assert.equal((await fetch(`${webBase}/api/runs/${live}/events`, as("bob"))).status, 404);
  for (const signal of [
    { kind: "abort" },
    { kind: "steer", text: "do something else" },
    { kind: "steer", text: "hijack", threadRef: `web:bob:${crypto.randomUUID()}` },
    { kind: "client_result", callId: "c1", result: { content: "forged" } },
  ]) {
    const r = await fetch(
      `${webBase}/api/runs/${live}/signal`,
      as("bob", { method: "POST", body: JSON.stringify(signal) }),
    );
    assert.ok([403, 404].includes(r.status), `${signal.kind} answered ${r.status}`);
  }
  assert.deepEqual(await built.signals.takePending(live), []);
  const edit = await fetch(
    `${webBase}/api/runs/${queued}/input`,
    as("bob", { method: "PATCH", body: JSON.stringify({ text: "rewritten", expectedText: "alice private second" }) }),
  );
  assert.equal(edit.status, 404);
  assert.equal((await fetch(`${webBase}/api/runs/${queued}/withdraw`, as("bob", { method: "POST" }))).status, 404);
  const after = await built.runs.get(queued);
  assert.equal(after?.status, "pending");
  assert.equal(after?.request.text, "alice private second");
  assert.equal((await built.runs.get(live))?.status, "pending");
  assert.equal((await active("alice", threadRef)).runId, live);
  assert.equal((await fetch(`${webBase}/api/runs/${live}`, as("alice"))).status, 200);
});

test("another user cannot inspect or control a session's swarm", async () => {
  const session = await built.sessions.getOrCreateByThread(
    `web:alice:${crypto.randomUUID()}`,
    "dm",
    scopeId("personal", "alice"),
  );
  await built.sessions.addParticipant(session.id, "alice");
  const path = `${webBase}/api/sessions/${encodeURIComponent(session.id)}/swarm`;
  const control = JSON.stringify({ action: "control", memberId: "m1", state: "stopped" });
  assert.notEqual((await fetch(path, as("alice"))).status, 403);
  assert.equal((await fetch(path, as("bob"))).status, 403);
  assert.equal((await fetch(path, as("bob", { method: "POST", body: control }))).status, 403);
});

test("a run id is not usable without a portal identity", async () => {
  const { live } = await aliceThread();
  for (const [path, init] of [
    [`/api/runs/${live}`, {}],
    [`/api/runs/${live}/signal`, { method: "POST", body: JSON.stringify({ kind: "abort" }) }],
  ] as const) {
    const r = await fetch(`${webBase}${path}`, { ...init, headers: { cookie: "webuiuser=alice" } });
    assert.equal(r.status, 401);
  }
  assert.equal((await built.runs.get(live))?.status, "pending");
});
