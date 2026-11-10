import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { STALE_LEASE_GRACE_MS } from "../src/api/app.ts";
import { testConfig } from "./support/test-config.ts";

test("getRun reports stale exactly when no live worker owns a previously-claimed run", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "run-stale-")),
      backgroundWorkEnabled: false,
    }),
  );
  const ack = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "t1" },
    text: "x",
    async: true,
  });
  const runId = ack.runId!;

  assert.equal((await built.app.getRun(runId))?.stale, undefined, "a fresh pending run was never claimed — not stale");

  const claimed = (await built.runs.claim("w1", 60_000))[0] ?? null;
  assert.equal(claimed?.id, runId);
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "running on a live lease — not stale");

  assert.equal(await built.runs.heartbeat(runId, claimed!.leaseToken!, -(STALE_LEASE_GRACE_MS + 1_000)), true);
  assert.equal((await built.app.getRun(runId))?.stale, true, "running past its lease — the worker is gone");

  assert.equal(await built.runs.heartbeat(runId, claimed!.leaseToken!, 5_000), true);
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "a renewed lease clears staleness");

  await built.runs.releaseLease(runId, claimed!.leaseToken!);
  assert.equal(
    (await built.app.getRun(runId))?.stale,
    true,
    "requeued after a claim with no recorded reason — awaiting re-claim",
  );

  const parkedClaim = (await built.runs.claim("w2", 5_000))[0] ?? null;
  assert.equal(parkedClaim?.id, runId);
  await built.runs.releaseLease(runId, parkedClaim!.leaseToken!, { kind: "parked" });
  assert.equal(
    (await built.app.getRun(runId))?.stale,
    undefined,
    "parked for a person's turn — planned, not interrupted",
  );

  const drained = (await built.runs.claim("w2", 5_000))[0] ?? null;
  await built.runs.releaseLease(runId, drained!.leaseToken!, { kind: "shutdown" });
  assert.equal(
    (await built.app.getRun(runId))?.stale,
    undefined,
    "handed back by a draining worker — planned, not interrupted",
  );

  const crashed = (await built.runs.claim("w3", 5_000))[0] ?? null;
  assert.equal(await built.runs.heartbeat(runId, crashed!.leaseToken!, -1_000), true);
  await built.runs.reapExpired();
  assert.equal((await built.app.getRun(runId))?.stale, true, "a worker lost after a planned requeue — interrupted again");

  const reclaimed = (await built.runs.claim("w2", 5_000))[0] ?? null;
  assert.equal(reclaimed?.id, runId);
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "re-claimed on a fresh lease — not stale");

  await built.runs.complete(runId, reclaimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "terminal runs are never stale");
});
