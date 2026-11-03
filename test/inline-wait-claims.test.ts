import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import pg from "pg";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { RUN_WAIT_FALLBACK_MS } from "../src/runs/run-store.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

test("a synchronous turn waiting on a run another worker holds does not poll claims", { timeout: 30_000 }, async () => {
  const built = buildApp(
    testConfig({
      runWaitMs: 5_000,
      dataDir: mkdtempSync(join(tmpdir(), "inline-wait-")),
    }),
  );
  try {
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `inline-wait-${randomUUID()}` },
      text: "hello",
      idempotencyKey: `held-${randomUUID()}`,
    };
    const queued = await built.app.turn({ ...request, async: true });
    const held = await built.runs.claimById(queued.runId!, "other-worker", 60_000);
    assert.ok(held?.leaseToken);
    let claims = 0;
    const claimForSession = built.runs.claimForSession.bind(built.runs);
    built.runs.claimForSession = async (...args) => {
      claims += 1;
      return claimForSession(...args);
    };
    const waiting = built.app.turn(request);
    await sleep(500);
    assert.equal(claims, 0);
    await built.runs.complete(held.id, held.leaseToken, { status: "ok", reply: "done elsewhere" });
    const result = await waiting;
    assert.equal(result.status, "ok");
    assert.equal(result.reply, "done elsewhere");
  } finally {
    await built.runtime.stop();
  }
});

test("a synchronous turn wakes when another instance finishes its run, without polling the run", async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const built = buildApp(
    testConfig({ databaseUrl, runWaitMs: 10_000, dataDir: mkdtempSync(join(tmpdir(), "inline-wake-")) }),
  );
  const elsewhere = createPostgresRunStore(databaseUrl);
  try {
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `inline-wake-${randomUUID()}` },
      text: "hello",
      idempotencyKey: `wake-${randomUUID()}`,
    };
    const queued = await built.app.turn({ ...request, async: true });
    const held = await elsewhere.runs.claimById(queued.runId!, "other-instance", 60_000);
    assert.ok(held?.leaseToken);
    let reads = 0;
    const get = built.runs.get.bind(built.runs);
    built.runs.get = async (...args) => {
      reads += 1;
      return get(...args);
    };
    const waiting = built.app.turn(request);
    await sleep(1_500);
    const readsWhileHeld = reads;
    const finishedAt = performance.now();
    await elsewhere.runs.complete(held.id, held.leaseToken, { status: "ok", reply: "done elsewhere" });
    const result = await waiting;
    const wokeAfterMs = performance.now() - finishedAt;
    assert.equal(result.reply, "done elsewhere");
    assert.ok(readsWhileHeld <= 4, `read the run ${readsWhileHeld} times while another instance held it`);
    assert.ok(wokeAfterMs < 500, `woke ${Math.round(wokeAfterMs)}ms after the other instance finished`);
  } finally {
    await elsewhere.close();
    await built.runtime.stop();
  }
});

test("a synchronous turn still finishes when the completion notification never arrives", async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const built = buildApp(
    testConfig({ databaseUrl, runWaitMs: 10_000, dataDir: mkdtempSync(join(tmpdir(), "inline-fallback-")) }),
  );
  const raw = new pg.Pool({ connectionString: databaseUrl });
  try {
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `inline-fallback-${randomUUID()}` },
      text: "hello",
      idempotencyKey: `fallback-${randomUUID()}`,
    };
    const queued = await built.app.turn({ ...request, async: true });
    assert.ok(await built.runs.claimById(queued.runId!, "silent-instance", 60_000));
    const waiting = built.app.turn(request);
    await sleep(300);
    const finishedAt = performance.now();
    await raw.query(
      "UPDATE runs SET status='done', result=$2, lease_token=NULL, lease_expires_at=NULL, finished_at=$3 WHERE id=$1",
      [queued.runId, JSON.stringify({ status: "ok", reply: "finished silently" }), Date.now()],
    );
    const result = await waiting;
    const wokeAfterMs = performance.now() - finishedAt;
    assert.equal(result.reply, "finished silently");
    assert.ok(wokeAfterMs <= RUN_WAIT_FALLBACK_MS + 500, `fallback read took ${Math.round(wokeAfterMs)}ms`);
  } finally {
    await raw.end();
    await built.runtime.stop();
  }
});
