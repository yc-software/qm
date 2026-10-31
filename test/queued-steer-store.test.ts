import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { type RunSignal } from "../src/runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("queued steering transfers files once or leaves the original queue intact", async () => {
  const url = testDatabaseUrl();
  const runtime = createPostgresRunStore(url);
  const signals = createPostgresRunSignalStore(url);
  const runs = runtime.runs;
  const sessionId = randomUUID();
  const actor = { id: "queued-owner", type: "internal" as const };
  const request: OrchestratorInput = {
    actor,
    conversation: { kind: "dm", threadRef: sessionId, audience: [actor] },
    origin: { kind: "direct" },
    text: "",
  };
  const attachments = [{ name: "file.txt", blobId: "queued-blob", sizeBytes: 3, mimetype: "text/plain" }];
  try {
    const { run: target } = await runs.enqueue({ sessionId, request: { ...request, text: "working" } });
    const { run: queued } = await runs.enqueue({ sessionId, request: { ...request, attachments } });
    const signal: RunSignal = {
      kind: "steer",
      text: "",
      dedupeKey: randomUUID(),
      request: {
        surface: "web",
        actor: { externalId: actor.id },
        conversation: { kind: "dm", threadRef: sessionId },
        text: "",
        attachments,
      },
    };
    const moved = await Promise.all([
      runs.steerQueued(queued.id, target.id, signal, signals),
      runs.steerQueued(queued.id, target.id, signal, signals),
    ]);
    assert.equal(moved.filter(Boolean).length, 1);
    assert.equal(await runs.get(queued.id), null);
    const pending = await signals.takePending(target.id);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]?.request?.attachments, attachments);
    const { run: edited } = await runs.enqueue({ sessionId, request: { ...request, attachments } });
    assert.equal(await runs.editPendingText(edited.id, "new caption", ""), true);
    assert.equal(await runs.steerQueued(edited.id, target.id, { ...signal, dedupeKey: randomUUID() }, signals), false);
    assert.equal((await runs.get(edited.id))?.request.text, "new caption");
    assert.equal((await signals.pending(target.id)).length, 0);
    await runs.withdraw(edited.id);
    const lease = await runs.claimById(target.id, "test", 10000);
    assert.ok(lease?.leaseToken);
    await runs.complete(target.id, lease.leaseToken, { status: "ok", reply: "done" });
    const { run: late } = await runs.enqueue({ sessionId, request: { ...request, attachments } });
    assert.equal(await runs.steerQueued(late.id, target.id, { ...signal, dedupeKey: randomUUID() }, signals), false);
    assert.deepEqual((await runs.get(late.id))?.request.attachments, attachments);
    await runs.withdraw(late.id);
  } finally {
    await signals.close?.();
    await runs.close?.();
  }
});
