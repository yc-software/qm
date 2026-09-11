import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { TurnRequest } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";

function input(threadRef: string, text: string): OrchestratorInput {
  return {
    surface: "slack",
    actor: { id: "internal:U1", type: "internal" },
    conversation: { kind: "dm", threadRef, audience: [] },
    origin: { kind: "human" },
    text,
  };
}

for (const backend of ["memory", "postgres"] as const) {
  const skip = backend === "postgres" && !process.env.DATABASE_URL;
  test(
    `${backend}: queued transfer outbox survives failed signal persistence and target deletion`,
    { skip },
    async () => {
      const config = testConfig(
        backend === "postgres"
          ? { databaseUrl: process.env.DATABASE_URL, runStore: "postgres", sessionStore: "postgres" }
          : {},
      );
      const built = buildApp(config);
      const replica = backend === "postgres" ? buildApp(config) : built;
      try {
        const thread = randomUUID();
        const { run: target } = await built.runs.enqueue({ sessionId: thread, request: input(thread, "target") });
        const request: OrchestratorInput = { ...input(thread, "original accepted message"), timezone: "Europe/London" };
        const { run: source } = await built.runs.enqueue({ sessionId: thread, request });
        const send = built.signals.send.bind(built.signals);
        built.signals.send = async () => {
          throw new Error("disconnect before signal save");
        };
        await assert.rejects(built.app.signalRun(target.id, { kind: "steer", queuedRunId: source.id }), /disconnect/);
        built.signals.send = send;
        assert.equal((await replica.runs.get(source.id))?.signalTargetRunId, target.id);
        assert.equal(await replica.runs.claimById(source.id, "worker", 1000), null);
        assert.equal(await replica.runs.withdraw(source.id), false);
        assert.equal(await replica.runs.withdraw(target.id), true);
        const accepted = await replica.app.signalRun(target.id, { kind: "steer", queuedRunId: source.id });
        assert.equal(accepted.accepted, true);
        assert.ok(accepted.signalId);
        const saved = await replica.signals.get(accepted.signalId!);
        assert.equal(saved?.request?.actor.externalId, request.actor.id);
        assert.deepEqual(saved?.request?.attachments, request.attachments);
        assert.equal(saved?.request?.timezone, request.timezone);
        assert.ok(saved?.deliveryRunId);
        const replay = await replica.runs.get(saved!.deliveryRunId!);
        assert.equal(replay?.request.text, request.text);
        assert.deepEqual(replay?.request.attachments, request.attachments);
        assert.equal(
          (await replica.app.signalRun(target.id, { kind: "steer", queuedRunId: source.id })).signalId,
          saved!.id,
        );
        assert.equal(
          (await replica.runs.pendingSignalTransfers()).some((run) => run.id === source.id),
          false,
        );
      } finally {
        await built.runtime.stop();
        if (replica !== built) await replica.runtime.stop();
      }
    },
  );

  test(`${backend}: queued attachments cannot be consumed as a caption-only steer`, { skip }, async () => {
    const built = buildApp(
      testConfig(
        backend === "postgres"
          ? { databaseUrl: process.env.DATABASE_URL, runStore: "postgres", sessionStore: "postgres" }
          : {},
      ),
    );
    try {
      const thread = randomUUID();
      const { run: target } = await built.runs.enqueue({ sessionId: thread, request: input(thread, "target") });
      const request = {
        ...input(thread, "inspect this"),
        attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "blob-1" }],
      };
      const { run: source } = await built.runs.enqueue({ sessionId: thread, request });
      const result = await built.app.signalRun(target.id, { kind: "steer", queuedRunId: source.id });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, "attachments");
      assert.equal((await built.runs.get(source.id))?.status, "pending");
      assert.equal((await built.runs.get(source.id))?.signalTargetRunId, undefined);
      assert.deepEqual(await built.signals.pending(target.id), []);
    } finally {
      await built.runtime.stop();
    }
  });

  test(`${backend}: a refused replay does not starve a later authorized message`, { skip }, async () => {
    const built = buildApp(
      testConfig(
        backend === "postgres"
          ? { databaseUrl: process.env.DATABASE_URL, runStore: "postgres", sessionStore: "postgres" }
          : {},
      ),
    );
    try {
      const thread = randomUUID();
      const { run: target } = await built.runs.enqueue({ sessionId: thread, request: input(thread, "target") });
      const request: TurnRequest = {
        surface: "slack",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: thread },
        origin: { kind: "human" },
        text: "authorized",
      };
      await built.signals.send(target.id, {
        kind: "steer",
        text: "blocked",
        request: {
          ...request,
          surface: "web",
          actor: { externalId: "web-eve" },
          conversation: { kind: "group", threadRef: thread, channelRef: "G-NOPE" },
          liveActor: true,
          text: "blocked",
        },
      });
      const second = await built.signals.send(target.id, { kind: "steer", text: "authorized", request });
      assert.notEqual(second.status, "closed");
      if (second.status === "closed") throw new Error("unexpected closure");
      await built.runs.withdraw(target.id);
      await built.app.replayOrphanedRunSignals(target.id);
      assert.ok((await built.signals.get(second.signal.id))?.deliveryRunId);
      assert.deepEqual(
        (await built.signals.pending(target.id)).map((signal) => signal.text),
        ["blocked"],
      );
    } finally {
      await built.runtime.stop();
    }
  });

  test(`${backend}: one admission owns concurrent redelivery across original completion`, { skip }, async () => {
    const config = testConfig(
      backend === "postgres"
        ? { databaseUrl: process.env.DATABASE_URL, runStore: "postgres", sessionStore: "postgres" }
        : {},
    );
    const built = buildApp(config);
    const replica = backend === "postgres" ? buildApp(config) : built;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const thread = randomUUID();
      const { run } = await built.runs.enqueue({ sessionId: thread, request: input(thread, "first") });
      const claimed = await built.runs.claimById(run.id, "worker", 60_000);
      const key = randomUUID();
      const request: TurnRequest = {
        surface: "slack",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: thread },
        origin: { kind: "human" },
        text: "one message",
        redeliveryKey: key,
        async: true,
      };
      const active = built.runs.activeForThread.bind(built.runs);
      let lookups = 0;
      built.runs.activeForThread = async (...args) => {
        if (++lookups === 1) {
          entered.resolve();
          await release.promise;
        }
        return active(...args);
      };
      const first = built.app.turn(request);
      await entered.promise;
      const second = replica.app.turn(request);
      await sleep(30);
      assert.equal(lookups, 1);
      const send = built.signals.send.bind(built.signals);
      built.signals.send = async (...args) => {
        const saved = await send(...args);
        await built.runs.complete(run.id, claimed!.leaseToken!, { status: "silent" });
        return saved;
      };
      release.resolve();
      const results = await Promise.all([first, second]);
      assert.equal(results[0]!.signalId, results[1]!.signalId);
      assert.ok(results[0]!.signalId);
      assert.notEqual(results[0]!.runId, run.id);
      assert.equal(results[0]!.runId, results[1]!.runId);
      assert.equal(await built.runs.getByDedupKey(key), null);
      const saved = await replica.signals.getByDedupeKey(key);
      assert.equal(saved?.deliveryRunId, results[0]!.runId);
    } finally {
      release.resolve();
      await built.runtime.stop();
      if (replica !== built) await replica.runtime.stop();
    }
  });

  test(
    `${backend}: transfer and worker claim are mutually exclusive; busy replay retains identity`,
    { skip },
    async () => {
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(process.env.DATABASE_URL!);
      const sibling = backend === "memory" ? runtime : createPostgresRunStore(process.env.DATABASE_URL!);
      try {
        const thread = randomUUID();
        const { run } = await runtime.runs.enqueue({ sessionId: thread, request: input(thread, "queued") });
        const [transfer, claim] = await Promise.all([
          runtime.runs.beginSignalTransfer(run.id, "target"),
          sibling.runs.claimById(run.id, "worker", 30_000),
        ]);
        assert.equal(Number(!!transfer) + Number(!!claim), 1);
        const replayThread = randomUUID();
        const key = `signal-delivery:${randomUUID()}`;
        const { run: replay } = await runtime.runs.enqueue({
          sessionId: replayThread,
          request: input(replayThread, "replay"),
          dedupKey: key,
        });
        const busy = await runtime.runs.claimById(replay.id, "worker", 30_000);
        await runtime.runs.complete(replay.id, busy!.leaseToken!, {
          status: "refused",
          reason: "busy",
          refusalKind: "session_busy",
        });
        assert.equal((await sibling.runs.getByDedupKey(key))?.id, replay.id);
        assert.equal((await sibling.runs.get(replay.id))?.status, "pending");
        const retry = await sibling.runs.claimById(replay.id, "worker", 30_000);
        assert.equal(retry?.id, replay.id);
        await sibling.runs.complete(replay.id, retry!.leaseToken!, { status: "ok", reply: "delivered" });
        assert.equal((await runtime.runs.getByDedupKey(key))?.result?.reply, "delivered");
      } finally {
        await runtime.runs.close?.();
        if (sibling !== runtime) await sibling.runs.close?.();
      }
    },
  );
}
