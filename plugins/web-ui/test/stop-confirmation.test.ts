import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { makeRunResumeStreamFn, createRunSlot, requestStop, type AssistantWork } from "../src/core-bridge.ts";
import type { Api, Model, Context } from "@earendil-works/pi-ai";

const fetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetch;
});
const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

test("stop before run discovery follows the run until server confirmation", async () => {
  const slot = createRunSlot();
  const terminal = Promise.withResolvers<Response>();
  const signalled = Promise.withResolvers<void>();
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/signal")) {
      signalled.resolve();
      return new Response("{}");
    }
    return terminal.promise;
  }) as typeof globalThis.fetch;
  let requested = false;
  const fn = makeRunResumeStreamFn(
    "slow-read",
    undefined,
    () => {
      if (!requested) {
        requested = true;
        requestStop(slot);
      }
    },
    slot,
  );
  const stream = await fn(model, {} as Context, {});
  let settled = false;
  const result = stream.result().then((value) => {
    settled = true;
    return value as AssistantWork;
  });
  await signalled.promise;
  await sleep(30);
  const premature = settled;
  terminal.resolve(
    new Response(JSON.stringify({ status: "done", result: { status: "ok", stopped: true, reply: "" } })),
  );
  const final = await result;
  assert.equal(premature, false, "Stopped requires server confirmation");
  assert.equal(final.stopReason, "aborted");
  await sleep(0);
  assert.equal(slot.stopGeneration, null);
});

for (const status of [404, 409, 500]) {
  test(`stop discovery with HTTP ${status} never invents a stopped result`, async () => {
    const errors: string[] = [];
    const slot = createRunSlot((message) => errors.push(message));
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/signal")) return new Response("{}", { status });
      return new Response(JSON.stringify({ status: "done", result: { status: "ok", reply: "completed normally" } }));
    }) as typeof globalThis.fetch;
    let requested = false;
    const fn = makeRunResumeStreamFn(
      "run",
      undefined,
      () => {
        if (!requested) {
          requested = true;
          requestStop(slot);
        }
      },
      slot,
    );
    const stream = await fn(model, {} as Context, {});
    const final = await stream.result();
    assert.equal(final.stopReason, "stop");
    assert.deepEqual(errors, status === 500 ? ["Could not request stop. Try again."] : []);
    await sleep(0);
    assert.equal(slot.stopGeneration, null);
  });
}

test("a stalled stop acknowledgment cannot delay confirmation or report a late error", async () => {
  const errors: string[] = [];
  const slot = createRunSlot((message) => errors.push(message));
  const signalReply = Promise.withResolvers<Response>();
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/signal")) return signalReply.promise;
    return new Response(JSON.stringify({ status: "done", result: { status: "ok", stopped: true } }));
  }) as typeof globalThis.fetch;
  let requested = false;
  const fn = makeRunResumeStreamFn(
    "run",
    undefined,
    () => {
      if (!requested) {
        requested = true;
        requestStop(slot);
      }
    },
    slot,
  );
  const stream = await fn(model, {} as Context, {});
  const result = stream.result();
  const first = await Promise.race([result, sleep(100).then(() => null)]);
  signalReply.reject(new TypeError("late transport failure"));
  await result;
  await sleep(0);
  assert.equal(first?.stopReason, "aborted");
  assert.deepEqual(errors, []);
});
