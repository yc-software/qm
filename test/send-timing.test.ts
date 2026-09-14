import { test } from "node:test";
import assert from "node:assert/strict";
import { createSendTiming, parseSendTiming, sendTraceId } from "../plugins/chassis/src/send-timing.ts";
const traceId = "bf42d301-3af5-4fa1-889b-eac3780f982c";

test("timing logs contain only approved metadata, never extra payload fields", () => {
  const event = {
    traceId,
    layer: "browser",
    stage: "request_start",
    elapsedMs: 12.8,
    at: 123,
    text: "secret",
    authorization: "secret",
  };
  assert.deepEqual(parseSendTiming(event), {
    event: "send_timing",
    traceId,
    layer: "browser",
    stage: "request_start",
    elapsedMs: 13,
    at: 123,
  });
});

test("unbounded or arbitrary trace data is rejected", () => {
  const event = { traceId, layer: "browser", stage: "request_start", elapsedMs: 1, at: 123 };
  for (const patch of [
    { traceId: "private message\n" },
    { stage: "a prompt" },
    { layer: "private" },
    { elapsedMs: NaN },
    { elapsedMs: Infinity },
    { elapsedMs: -1 },
    { elapsedMs: 3600001 },
    { at: "now" },
  ])
    assert.equal(parseSendTiming({ ...event, ...patch }), null);
  assert.equal(sendTraceId(undefined), undefined);
});

test("missing IDs are silent and a logging failure cannot fail a send", () => {
  let calls = 0;
  createSendTiming(undefined, "core", () => {
    calls++;
  })("received");
  assert.equal(calls, 0);
  assert.doesNotThrow(() =>
    createSendTiming(traceId, "core", () => {
      throw new Error("sink unavailable");
    })("received"),
  );
});
