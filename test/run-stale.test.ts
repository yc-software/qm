import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
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

  const claimed = await built.runs.claim("w1", 60_000);
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
    "requeued after a claim (deploy drain) — awaiting re-claim",
  );

  const reclaimed = await built.runs.claim("w2", 5_000);
  assert.equal(reclaimed?.id, runId);
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "re-claimed on a fresh lease — not stale");

  await built.runs.complete(runId, reclaimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.equal((await built.app.getRun(runId))?.stale, undefined, "terminal runs are never stale");
});
