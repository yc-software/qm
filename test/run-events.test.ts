import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runEventRoutes } from "../src/api/routes/run-events.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { App } from "../src/api/app.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { emitRunText, type RunStreamEvent } from "../src/runs/run-stream-events.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("run events push deltas without snapshot polling and recover a separate worker's prefix", async () => {
  const bus = createMemoryEventBus<RunStreamEvent>("test");
  let reads = 0;
  let workerText = "prefix 🌍";
  let status: "running" | "done" = "running";
  const app = {
    async getRun() {
      reads++;
      return {
        status,
        startedAt: 0,
        finishedAt: null,
        result: status === "done" ? { status: "ok", reply: workerText } : null,
      };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream(runId, offset) {
      emitRunText(bus, runId, workerText.slice(offset), offset);
    },
  } as Pick<App, "getRun" | "subscribeRun" | "syncRunStream">;
  const server = createServer((req, res) => {
    void runEventRoutes[0]!.handle({ app, req, res, params: { id: "run" } } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let wire = "";
    const consume = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        wire += new TextDecoder().decode(next.value);
      }
    })();
    await sleep(120);
    assert.equal(reads, 2, "only initial authorization and race-free hydration read snapshots");
    workerText += " more";
    bus.emit({ runId: "run", kind: "delta", offset: 9, text: " more" });
    await sleep(120);
    assert.equal(reads, 2, "text publications must not poll the run");
    assert.match(wire, /more/);
    workerText += " lost then found";
    bus.emit({ runId: "run", kind: "delta", offset: 20, text: "found" });
    await sleep(50);
    assert.match(wire, /lost then found/);
    status = "done";
    bus.emit({ runId: "run", kind: "refresh" });
    await consume;
    assert.match(wire, /RUN_FINISHED/);
    assert.equal(reads, 3);
    assert.equal(bus.size(), 0, "completion releases subscriptions");
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("run events deliver a pending activity snapshot before subsequent text and recover held deltas", async () => {
  const bus = createMemoryEventBus<RunStreamEvent>("ordered-test");
  let reads = 0;
  let workerText = "";
  let status: "running" | "done" = "running";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = {
    async getRun() {
      reads++;
      if (reads === 3) {
        entered.resolve();
        await release.promise;
      }
      return {
        status,
        startedAt: 0,
        finishedAt: null,
        result: status === "done" ? { status: "ok", reply: workerText } : null,
        activity:
          reads >= 3 ? [{ seq: 1, parentSeq: null, type: "text", payload: { text: "working" }, createdAt: 0 }] : [],
      };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream(runId, offset) {
      emitRunText(bus, runId, workerText.slice(offset), offset);
    },
  } as Pick<App, "getRun" | "subscribeRun" | "syncRunStream">;
  const server = createServer((req, res) => {
    void runEventRoutes[0]!.handle({ app, req, res, params: { id: "run" } } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let wire = "";
    const consume = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        wire += new TextDecoder().decode(next.value);
      }
    })();
    await sleep(50);
    assert.equal(reads, 2);
    bus.emit({ runId: "run", kind: "refresh" });
    await entered.promise;
    workerText = "after-boundary";
    bus.emit({ runId: "run", kind: "delta", offset: 0, text: workerText });
    await sleep(30);
    assert.doesNotMatch(wire, /after-boundary/);
    release.resolve();
    await sleep(50);
    assert.ok(wire.indexOf("working") >= 0);
    assert.ok(wire.indexOf("after-boundary") > wire.indexOf("working"));
    assert.equal(wire.match(/after-boundary/g)?.length, 1);
    status = "done";
    bus.emit({ runId: "run", kind: "refresh" });
    await consume;
    assert.equal(bus.size(), 0);
  } finally {
    release.resolve();
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
