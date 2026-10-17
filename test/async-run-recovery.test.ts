import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer } from "../src/api/server.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);
const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "async-run-recovery-")) }));
const core = createServer(built.app, { signingSecret: SECRET, runs: built.runs, sessions: built.sessions });
core.listen(0);
const base = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => core.close(() => resolve()));
  await built.runtime.stop();
});

function request(id: string): TurnRequest {
  return {
    actor: { externalId: "internal:owner" },
    async: true,
    conversation: { kind: "dm", threadRef: `async-recovery:${id}` },
    idempotencyKey: `async-recovery:${id}`,
    surface: "webhook",
    text: "complete the accepted work",
    triggered: true,
  };
}

async function completeRun(runId: string, result: TurnResult): Promise<void> {
  const run = await built.runs.claimById(runId, "test-worker", 5_000);
  assert.ok(run?.leaseToken);
  assert.equal(await built.runs.complete(runId, run.leaseToken, result), true);
}

async function postAsync(turn: TurnRequest, nowSec: number): Promise<Response> {
  const path = "/v1/turns?async=1";
  const body = JSON.stringify(turn);
  return fetch(`${base}${path}`, {
    body,
    headers: signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" }, nowSec),
    method: "POST",
  });
}

test("POST /v1/turns async retry retains the original run ID after success", async () => {
  const turn = request("success");
  const nowSec = Math.floor(Date.now() / 1000);
  const acceptedResponse = await postAsync(turn, nowSec);
  assert.equal(acceptedResponse.status, 202);
  const accepted = (await acceptedResponse.json()) as TurnResult;
  assert.equal(accepted.status, "queued");
  assert.ok(accepted.runId);

  await completeRun(accepted.runId, { reply: "done", status: "ok" });

  const retryResponse = await postAsync(turn, nowSec + 1);
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), {
    reply: "done",
    runId: accepted.runId,
    status: "ok",
  });
});

test("an async idempotent retry retains the original run ID after a terminal failure", async () => {
  const turn = request("failure");
  const accepted = await built.app.turn(turn);
  assert.equal(accepted.status, "queued");
  assert.ok(accepted.runId);

  const run = await built.runs.claimById(accepted.runId, "test-worker", 5_000);
  assert.ok(run?.leaseToken);
  assert.deepEqual(await built.runs.fail(accepted.runId, run.leaseToken, "bounded attempt stopped", { retry: false }), {
    requeued: false,
  });

  assert.deepEqual(await built.app.turn(turn), {
    reason: "bounded attempt stopped",
    runId: accepted.runId,
    sessionId: undefined,
    status: "failed",
  });
});

test("a synchronous idempotent retry keeps the existing terminal response shape", async () => {
  const turn = request("sync");
  const accepted = await built.app.turn(turn);
  assert.equal(accepted.status, "queued");
  assert.ok(accepted.runId);

  await completeRun(accepted.runId, { reply: "done", status: "ok" });

  assert.deepEqual(await built.app.turn({ ...turn, async: false }), {
    reply: "done",
    status: "ok",
  });
});
