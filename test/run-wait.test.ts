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

const turnRequest = (): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: `run-wait-${randomUUID()}` },
  text: "hello",
  idempotencyKey: `run-wait-${randomUUID()}`,
});

test("a synchronous turn on a process that does not claim runs leaves its run queued", async () => {
  const built = buildApp(testConfig({ runWaitMs: 300, backgroundWorkEnabled: false }));
  const request = turnRequest();
  await assert.rejects(built.app.turn(request), /did not finish within 300ms/);
  const [run] = await built.runs.inFlightForThread(request.conversation.threadRef);
  assert.equal(run?.status, "pending");
  assert.equal(run?.attempts, 0);
  assert.equal(built.modelCalls.length, 0);
});

test("a synchronous turn respects its timeout without clearing a retry deadline", async () => {
  const built = buildApp(testConfig({ runWaitMs: 100, backgroundWorkEnabled: false }));
  const request = turnRequest();
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await built.runs.claimById(queued.runId!, "setup", 60_000);
  await built.runs.fail(claimed!.id, claimed!.leaseToken!, "temporary", { retryAfterMs: 30_000 });
  await assert.rejects(built.app.turn(request), /did not finish within 100ms/);
  assert.equal(await built.runs.claimById(claimed!.id, "other", 60_000), null);
});

test("a synchronous turn returns the result of the worker that ran it", async () => {
  const built = buildApp(testConfig({ runWaitMs: 5_000, backgroundWorkEnabled: false }));
  const request = turnRequest();
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await built.runs.claimById(queued.runId!, "other", 60_000);
  const pending = built.app.turn(request);
  await sleep(50);
  await built.runs.complete(claimed!.id, claimed!.leaseToken!, { status: "ok", reply: "other worker" });
  assert.equal((await pending).reply, "other worker");
  const run = await built.runs.get(claimed!.id);
  assert.equal(run?.attempts, 1);
  assert.equal(run?.workerId, "other");
});

test("a synchronous turn wakes when another instance finishes its run, without polling the run", async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const built = buildApp(
    testConfig({ databaseUrl, runWaitMs: 10_000, dataDir: mkdtempSync(join(tmpdir(), "run-wait-wake-")) }),
  );
  const elsewhere = createPostgresRunStore(databaseUrl);
  try {
    const request = turnRequest();
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
    testConfig({ databaseUrl, runWaitMs: 10_000, dataDir: mkdtempSync(join(tmpdir(), "run-wait-fallback-")) }),
  );
  const raw = new pg.Pool({ connectionString: databaseUrl });
  try {
    const request = turnRequest();
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
