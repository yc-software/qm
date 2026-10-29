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
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "web-run-ownership-secret".repeat(2);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "web-run-owner-")) }));
const core = createServer(built.app, {
  replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  signingSecret: SECRET,
});
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

test("another user cannot see a run's queued text, or edit, withdraw or answer its runs", async () => {
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
  const live = await submit("alice private first");
  const queued = await submit("alice private second");
  const discover = (user: string) =>
    fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, as(user));
  assert.deepEqual(((await (await discover("alice")).json()) as { queued?: Array<{ text: string }> }).queued, [
    { runId: queued, text: "alice private second" },
  ]);
  assert.deepEqual(await (await discover("bob")).json(), { runId: null, run: null });
  const edit = await fetch(
    `${webBase}/api/runs/${queued}/input`,
    as("bob", { method: "PATCH", body: JSON.stringify({ text: "rewritten", expectedText: "alice private second" }) }),
  );
  assert.equal(edit.status, 404);
  assert.equal((await fetch(`${webBase}/api/runs/${queued}/withdraw`, as("bob", { method: "POST" }))).status, 404);
  const answer = JSON.stringify({ kind: "client_result", callId: "c1", result: { content: "forged" } });
  assert.equal(
    (await fetch(`${webBase}/api/runs/${live}/signal`, as("bob", { method: "POST", body: answer }))).status,
    404,
  );
  assert.deepEqual(await built.signals.takePending(live), []);
  const untouched = await built.runs.get(queued);
  assert.equal(untouched?.status, "pending");
  assert.equal(untouched?.request.text, "alice private second");
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
