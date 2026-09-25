import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import { emitRunText, type RunStreamEvent } from "../src/runs/run-stream-events.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { MAX_NOTIFY_PAYLOAD_BYTES } from "../src/persistence/postgres-notify-bus.ts";

test("text publications push exact offsets immediately, including block boundaries and the buffer cap", () => {
  const changes: string[] = [];
  const deltas: Array<{ runId: string; text: string; offset: number }> = [];
  const stream = createTurnStream({
    maxChars: 9,
    onDelta: (runId, text, offset) => deltas.push({ runId, text, offset }),
    onChange: (id) => changes.push(id),
  });
  stream.begin("run");
  stream.publish("run", "hello");
  assert.deepEqual(deltas, [{ runId: "run", text: "hello", offset: 0 }]);
  stream.publishBlockStart("run");
  stream.publish("run", "world");
  stream.publish("run", "ignored");
  stream.markReplyDone("run");
  assert.deepEqual(
    deltas.map(({ text, offset }) => [text, offset]),
    [
      ["hello", 0],
      ["\n\n", 5],
      ["wo", 7],
    ],
  );
  assert.deepEqual(changes, ["run", "run"]);
});

test("cross-process text frames stay under Postgres' payload limit and preserve Unicode and offsets", () => {
  const bus = createMemoryEventBus<RunStreamEvent>("test");
  const parts: Array<Extract<RunStreamEvent, { kind: "delta" }>> = [];
  bus.subscribe((event) => {
    if (event.kind === "delta") parts.push(event);
  });
  const text = '\u0000"\\🌍'.repeat(3_000);
  emitRunText(bus, "r".repeat(36), text, 37);
  let offset = 37;
  for (const part of parts) {
    assert.equal(part.offset, offset);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < MAX_NOTIFY_PAYLOAD_BYTES);
    offset += part.text.length;
  }
  assert.equal(parts.map((part) => part.text).join(""), text);
});
