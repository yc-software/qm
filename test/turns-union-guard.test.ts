import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "core-signing-secret".repeat(3);
const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "turns-union-")) }));
const core = createServer(built.app, {
  replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  signingSecret: SECRET,
  runs: built.runs,
  sessions: built.sessions,
});
core.listen(0);
const base = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

test("POST /v1/turns strips the owner-keychain union from the external body but keeps other fields", async () => {
  const body = JSON.stringify({
    surface: "cron",
    actor: { externalId: "internal:owner" },
    conversation: {
      kind: "channel",
      channelRef: "C9",
      threadRef: "t-union-guard",
      audience: [{ externalId: "internal:owner" }],
    },
    text: "x",
    origin: { kind: "automation", useOwnerKeychain: true },
    readOnly: true,
    skipMemory: true,
    async: true,
  });
  const r = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
    body,
  });
  assert.equal(r.status, 202);
  const { runId } = (await r.json()) as { runId: string };
  const run = await built.runs.get(runId);
  assert.deepEqual(
    run?.request.origin,
    { kind: "automation" },
    "external union injection is removed while trigger provenance survives",
  );
  assert.equal(run?.request.readOnly, true, "non-internal fields are still forwarded");
  assert.equal(run?.request.skipMemory, true, "the source-authenticated memory opt-out is forwarded");
});

test("POST /v1/turns strips the owner-keychain union and the owner-fire mark from a typed automation origin", async () => {
  const body = JSON.stringify({
    surface: "cron",
    actor: { externalId: "internal:owner" },
    conversation: {
      kind: "channel",
      channelRef: "C9",
      threadRef: "t-typed-union-guard",
      audience: [{ externalId: "internal:owner" }],
    },
    text: "x",
    origin: { kind: "automation", screenData: "external event", useOwnerKeychain: true, ownerFire: true },
    async: true,
  });
  const r = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
    body,
  });
  assert.equal(r.status, 202);
  const { runId } = (await r.json()) as { runId: string };
  const run = await built.runs.get(runId);
  assert.deepEqual(run?.request.origin, { kind: "automation", screenData: "external event" });
});

test("POST /v1/turns strips spawned: an external body can't opt out of mid-turn steer folding", async () => {
  const turnBody = (text: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: {
        kind: "channel",
        channelRef: "C-spawn-guard",
        threadRef: "ch:C-spawn-guard:1.0",
        audience: [{ externalId: "U1" }],
      },
      text,
      origin: { kind: "human" },
      async: true,
      ...extra,
    });
  const post = async (body: string): Promise<{ runId: string }> => {
    const r = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
      body,
    });
    assert.equal(r.status, 202);
    return (await r.json()) as { runId: string };
  };
  const first = await post(turnBody("@bot start"));
  const second = await post(turnBody("make it blue", { spawned: true }));
  assert.equal(second.runId, first.runId, "the spawned-asserting live message still steered the live run");
});

test("POST /v1/turns strips redeliveryKey: an external body cannot borrow Slack's redelivery namespace", async () => {
  const turnBody = (threadRef: string): string =>
    JSON.stringify({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "channel", channelRef: "C-rd", threadRef, audience: [{ externalId: "U1" }] },
      text: "hello",
      async: true,
      redeliveryKey: "slack:B1:C-rd:1.0",
    });
  const post = async (body: string): Promise<{ http: number; runId?: string }> => {
    const r = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
      body,
    });
    const json = (await r.json()) as { runId?: string };
    return { http: r.status, ...(json.runId ? { runId: json.runId } : {}) };
  };
  const first = await post(turnBody("ch:C-rd:1.0"));
  const second = await post(turnBody("ch:C-rd:2.0"));
  assert.equal(first.http, 202);
  assert.equal(second.http, 202);
  assert.ok(
    first.runId && second.runId && first.runId !== second.runId,
    "the shared key neither collapses nor refuses",
  );
});

test("POST /v1/turns rejects a client idempotencyKey in the reserved slack: namespace", async () => {
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:reserved" },
    text: "hi",
    async: true,
    idempotencyKey: "slack:B1:C1:1.0",
  });
  const r = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
    body,
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /reserved slack: prefix/);
});

test("POST /v1/turns drops a caller-supplied surface origin", async () => {
  const body = JSON.stringify({
    surface: "cron",
    actor: { externalId: "internal:owner" },
    conversation: {
      kind: "channel",
      channelRef: "C9",
      threadRef: "t-origin-guard",
      audience: [{ externalId: "internal:owner" }],
    },
    text: "x",
    origin: { kind: "automation" },
    surfaceOrigin: {
      author: { surface: "slack", account: "partner", id: "U1" },
      workspace: "TPARTNER",
      audience: "internal",
    },
    async: true,
  });
  const r = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
    body,
  });
  assert.equal(r.status, 202);
  const { runId } = (await r.json()) as { runId: string };
  const run = await built.runs.get(runId);
  assert.equal(run?.request.surfaceOrigin, undefined);
});
