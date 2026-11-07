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
const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "turn-client-surface-")) }));
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

async function postTurn(fields: Record<string, unknown>, threadRef: string): Promise<Response> {
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef },
    text: "hello",
    origin: { kind: "human" },
    async: true,
    ...fields,
  });
  return fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
    body,
  });
}

test("a web turn keeps the client surface it came from on its run", async () => {
  const response = await postTurn({ clientSurface: "ios" }, "web:alice:client-surface-ios");
  assert.equal(response.status, 202);
  const { runId } = (await response.json()) as { runId: string };
  assert.equal((await built.runs.get(runId))?.request.clientSurface, "ios");
});

test("a client surface is kept on turns of other surfaces, as approval replays into swarm workers are", async () => {
  const response = await postTurn(
    {
      surface: "cron",
      actor: { externalId: "internal:owner" },
      conversation: {
        kind: "channel",
        channelRef: "C9",
        threadRef: "t-client-surface-cron",
        audience: [{ externalId: "internal:owner" }],
      },
      origin: { kind: "automation" },
      clientSurface: "browser",
    },
    "unused",
  );
  assert.equal(response.status, 202);
  const { runId } = (await response.json()) as { runId: string };
  assert.equal((await built.runs.get(runId))?.request.clientSurface, "browser");
});

test("an unknown client surface is refused", async () => {
  assert.equal((await postTurn({ clientSurface: "watch" }, "web:alice:client-surface-bad")).status, 400);
});
