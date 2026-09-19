import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createMemoryRunSignalStore, type RunSignal } from "../src/runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: queued steering transfers files once or leaves the original queue intact`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL ? "DATABASE_URL required" : false,
    },
    async () => {
      const database = backend === "postgres" ? await isolatedPostgres("queued_steer_test") : undefined;
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(database!.url);
      const signals = backend === "memory" ? createMemoryRunSignalStore() : createPostgresRunSignalStore(database!.url);
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
        assert.equal(
          await runs.steerQueued(edited.id, target.id, { ...signal, dedupeKey: randomUUID() }, signals),
          false,
        );
        assert.equal((await runs.get(edited.id))?.request.text, "new caption");
        assert.equal((await signals.pending(target.id)).length, 0);
        await runs.withdraw(edited.id);
        const lease = await runs.claimById(target.id, "test", 10000);
        assert.ok(lease?.leaseToken);
        await runs.complete(target.id, lease.leaseToken, { status: "ok", reply: "done" });
        const { run: late } = await runs.enqueue({ sessionId, request: { ...request, attachments } });
        assert.equal(
          await runs.steerQueued(late.id, target.id, { ...signal, dedupeKey: randomUUID() }, signals),
          false,
        );
        assert.deepEqual((await runs.get(late.id))?.request.attachments, attachments);
        await runs.withdraw(late.id);
      } finally {
        await signals.close?.();
        await runs.close?.();
        await database?.cleanup();
      }
    },
  );
}
