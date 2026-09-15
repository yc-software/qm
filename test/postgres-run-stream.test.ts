import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresNotifyBus } from "../src/persistence/postgres-notify-bus.ts";
import { emitRunText, type RunStreamEvent } from "../src/runs/run-stream-events.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";

const database = process.env.DATABASE_URL;

test(
  "independent worker and API connections replay and push Unicode text over Postgres",
  { skip: !database, timeout: 15_000 },
  async () => {
    const channel = `stream_${randomUUID().replaceAll("-", "")}`;
    const worker = createPostgresNotifyBus<RunStreamEvent>(database!, channel, "test-worker");
    const api = createPostgresNotifyBus<RunStreamEvent>(database!, channel, "test-api");
    const stream = createTurnStream({ onDelta: (runId, text, offset) => emitRunText(worker, runId, text, offset) });
    const runId = randomUUID();
    stream.begin(runId);
    stream.publish(runId, "preexisting 🌍 ");
    let text = "";
    let complete!: () => void;
    const received = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const expected = "preexisting 🌍 " + '\u0000\\"🌍'.repeat(900) + " final";
    const offWorker = await new Promise<() => void>((resolve) => {
      const off = worker.subscribe(
        (event) => {
          if (event.kind === "sync")
            emitRunText(worker, runId, (stream.snapshot(runId) ?? "").slice(event.offset), event.offset);
        },
        { onResync: () => resolve(off) },
      );
    });
    const offApi = await new Promise<() => void>((resolve) => {
      const off = api.subscribe(
        (event) => {
          if (event.kind !== "delta") return;
          if (event.offset > text.length) {
            api.emit({ runId, kind: "sync", offset: text.length });
            return;
          }
          text += event.text.slice(text.length - event.offset);
          if (text === expected) complete();
        },
        { onResync: () => resolve(off) },
      );
    });
    try {
      api.emit({ runId, kind: "sync", offset: 0 });
      stream.publish(runId, '\u0000\\"🌍'.repeat(900));
      stream.publish(runId, " final");
      await received;
      assert.equal(text, expected);
    } finally {
      offWorker();
      offApi();
      await worker.close?.();
      await api.close?.();
    }
  },
);
