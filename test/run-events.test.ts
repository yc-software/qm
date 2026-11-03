import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runEventRoutes } from "../src/api/routes/run-events.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { App } from "../src/api/app.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { emitRunReasoning, emitRunText, type RunStreamEvent } from "../src/runs/run-stream-events.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("run events push deltas without snapshot polling and recover a separate worker's prefix", async () => {
  const bus = createMemoryEventBus<RunStreamEvent>("test");
  let reads = 0;
  let workerText = "prefix 🌍";
  let holdSync = false;
  let syncCalls = 0;
  let status: "running" | "done" = "running";
  const app = {
    async getRun() {
      reads++;
      return {
        status,
        attempt: 1,
        startedAt: 0,
        finishedAt: null,
        result: status === "done" ? { status: "ok", reply: workerText } : null,
      };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream(runId, offset) {
      syncCalls++;
      if (!holdSync) emitRunText(bus, runId, workerText.slice(offset), offset, 0);
    },
    async getRunToolItems() {
      return [];
    },
  } as Pick<App, "getRun" | "getRunToolItems" | "subscribeRun" | "syncRunStream">;
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
    bus.emit({ runId: "run", kind: "delta", startOffset: 0, offset: 9, text: " more" });
    await sleep(120);
    assert.equal(reads, 2, "text publications must not poll the run");
    assert.match(wire, /more/);
    workerText += " lost then found";
    const beforeSync = syncCalls;
    holdSync = true;
    for (let i = 0; i < 3; i++) {
      bus.emit({ runId: "run", kind: "delta", startOffset: 0, offset: 20, text: "found" });
      await sleep(5);
    }
    assert.equal(syncCalls - beforeSync, 1, "later gaps must not start overlapping catch-up replays");
    holdSync = false;
    app.syncRunStream("run", 14, {});
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
        attempt: 1,
        startedAt: 0,
        finishedAt: null,
        result: status === "done" ? { status: "ok", reply: workerText } : null,
        activity: reads >= 3 ? [{ item: at(1, { kind: "AgentMessage", variant: "narration", text: "working" }) }] : [],
      };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream(runId, offset) {
      emitRunText(bus, runId, workerText.slice(offset), offset, 0);
    },
    async getRunToolItems() {
      return [];
    },
  } as Pick<App, "getRun" | "getRunToolItems" | "subscribeRun" | "syncRunStream">;
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
    bus.emit({ runId: "run", kind: "delta", startOffset: 0, offset: 0, text: workerText });
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

function at(seq: number, item: NewItem): Item {
  return storedItem(item, { sessionId: "session", seq, createdAt: seq });
}

function frames(wire: string): Array<{ id?: string; data: { type: string; name?: string } & Record<string, unknown> }> {
  return wire
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
      const data = JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6));
      return id === undefined ? { data } : { id, data };
    });
}

function toolFrames(wire: string) {
  return frames(wire).filter((frame) => frame.data.type.startsWith("TOOL_CALL_"));
}

async function streamToolRun(items: Item[], state: { status: "running" | "done" }) {
  const bus = createMemoryEventBus<RunStreamEvent>("tool-test");
  const viewers: Array<string | undefined> = [];
  const reads: Array<{ afterSeq: number | undefined; rows: number }> = [];
  const app = {
    async getRun() {
      return {
        status: state.status,
        attempt: 1,
        startedAt: 0,
        finishedAt: null,
        result: state.status === "done" ? { status: "ok", reply: "done" } : null,
      };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream() {},
    async getRunToolItems(_runId, viewer, afterSeq) {
      viewers.push(viewer);
      const rows = items.filter((item) => afterSeq === undefined || item.seq > afterSeq);
      reads.push({ afterSeq, rows: rows.length });
      return rows;
    },
  } as Pick<App, "getRun" | "getRunToolItems" | "subscribeRun" | "syncRunStream">;
  const server = createServer((req, res) => {
    void runEventRoutes[0]!.handle({
      app,
      req,
      res,
      params: { id: "run" },
      actor: { p: "U1" },
    } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
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
  return {
    bus,
    viewers,
    reads,
    consume,
    wire: () => wire,
    async close() {
      controller.abort();
      await consume.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const lookup = at(1, {
  kind: "ToolCall",
  tool: "salesforce_query",
  callId: "c1",
  body: { mcpServer: "salesforce", args: { q: "acme" } },
});
const lookupResult = at(2, {
  kind: "ToolResult",
  tool: "salesforce_query",
  callId: "c1",
  isError: false,
  text: "1 account",
  body: { mcpServer: "salesforce" },
});

test("run events replay a run's recorded tool calls and results on first connect", async () => {
  const stream = await streamToolRun([lookup, lookupResult], { status: "running" });
  try {
    await sleep(50);
    assert.deepEqual(toolFrames(stream.wire()), [
      {
        id: "tool:c1:start",
        data: {
          type: "TOOL_CALL_START",
          toolCallId: "c1",
          toolCallName: "salesforce_query",
          args: { mcpServer: "salesforce", args: { q: "acme" } },
        },
      },
      {
        id: "tool:c1:result",
        data: { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "1 account", isError: false },
      },
    ]);
    assert.ok(stream.viewers.length > 0 && stream.viewers.every((viewer) => viewer === "U1"));
  } finally {
    await stream.close();
  }
});

test("run events forward tool items recorded after connect on refresh, exactly once each", async () => {
  const items = [lookup];
  const stream = await streamToolRun(items, { status: "running" });
  try {
    await sleep(50);
    assert.deepEqual(
      toolFrames(stream.wire()).map((frame) => frame.id),
      ["tool:c1:start"],
    );
    items.push(lookupResult, at(3, { kind: "ToolCall", tool: "execute", callId: "c2", body: { command: "ls" } }));
    stream.bus.emit({ runId: "run", kind: "refresh" });
    await sleep(50);
    stream.bus.emit({ runId: "run", kind: "refresh" });
    stream.bus.emit({ runId: "run", kind: "refresh" });
    await sleep(50);
    items.push(at(4, { kind: "ToolResult", tool: "execute", callId: "c2", isError: true, text: "denied" }));
    stream.bus.emit({ runId: "run", kind: "refresh" });
    await sleep(50);
    assert.deepEqual(
      toolFrames(stream.wire()).map((frame) => frame.id),
      ["tool:c1:start", "tool:c1:result", "tool:c2:start", "tool:c2:result"],
    );
    assert.deepEqual(toolFrames(stream.wire())[3]!.data, {
      type: "TOOL_CALL_RESULT",
      toolCallId: "c2",
      content: "denied",
      isError: true,
    });
  } finally {
    await stream.close();
  }
});

test("a finished run replays its tool events and then RUN_FINISHED", async () => {
  const stream = await streamToolRun([lookup, lookupResult], { status: "done" });
  try {
    await stream.consume;
    assert.deepEqual(
      frames(stream.wire()).map(
        (frame) => frame.id ?? `${frame.data.type}${frame.data.name ? `:${frame.data.name}` : ""}`,
      ),
      ["RUN_STARTED", "tool:c1:start", "tool:c1:result", "CUSTOM:run", "done"],
    );
    assert.equal(stream.bus.size(), 0);
  } finally {
    await stream.close();
  }
});

test(
  "a tool replay larger than the send buffer drains instead of dropping the connection",
  { timeout: 10_000 },
  async () => {
    const bulky = "x".repeat(100_000);
    const items = Array.from({ length: 30 }, (_, i) => [
      at(i * 2 + 1, { kind: "ToolCall", tool: "execute", callId: `c${i}`, body: { command: `step ${i}` } }),
      at(i * 2 + 2, { kind: "ToolResult", tool: "execute", callId: `c${i}`, isError: false, text: bulky }),
    ]).flat();
    const stream = await streamToolRun(items, { status: "done" });
    try {
      await stream.consume;
      assert.equal(toolFrames(stream.wire()).length, 60);
      assert.equal(frames(stream.wire()).at(-1)?.id, "done");
    } finally {
      await stream.close();
    }
  },
);

test("refreshes read only tool items recorded after the last one sent", async () => {
  const items = [lookup, lookupResult];
  const stream = await streamToolRun(items, { status: "running" });
  try {
    await sleep(50);
    items.push(at(3, { kind: "ToolCall", tool: "execute", callId: "c2", body: { command: "ls" } }));
    stream.bus.emit({ runId: "run", kind: "refresh" });
    await sleep(50);
    stream.bus.emit({ runId: "run", kind: "refresh" });
    await sleep(50);
    assert.deepEqual(stream.reads, [
      { afterSeq: undefined, rows: 2 },
      { afterSeq: 2, rows: 0 },
      { afterSeq: 2, rows: 1 },
      { afterSeq: 3, rows: 0 },
    ]);
  } finally {
    await stream.close();
  }
});

test(
  "a final tool event larger than the send buffer is still followed by RUN_FINISHED",
  { timeout: 10_000 },
  async () => {
    const stream = await streamToolRun(
      [
        lookup,
        at(2, {
          kind: "ToolResult",
          tool: "salesforce_query",
          callId: "c1",
          isError: false,
          text: "é".repeat(1_500_000),
        }),
      ],
      { status: "done" },
    );
    try {
      await stream.consume;
      assert.deepEqual(
        frames(stream.wire()).map((frame) => frame.id ?? frame.data.type),
        ["RUN_STARTED", "tool:c1:start", "tool:c1:result", "CUSTOM", "done"],
      );
    } finally {
      await stream.close();
    }
  },
);

test("run events forward reasoning per block, dedupe overlap, and catch up gaps through sync", async () => {
  const bus = createMemoryEventBus<RunStreamEvent>("test");
  const worker = { step: "s1", index: 0, text: "**Checking** the cache" };
  const syncs: Array<Record<string, number> | undefined> = [];
  const app = {
    async getRun() {
      return { status: "running", attempt: 1, startedAt: 0, finishedAt: null, result: null };
    },
    subscribeRun(_runId, listener, onResync) {
      return bus.subscribe(listener, { onResync });
    },
    syncRunStream(runId, _offset, reasoning) {
      syncs.push(reasoning);
      const sent = reasoning?.["s1:0"] ?? 0;
      if (worker.text.length > sent) emitRunReasoning(bus, runId, worker, worker.text.slice(sent), sent);
    },
    async getRunToolItems() {
      return [];
    },
  } as Pick<App, "getRun" | "getRunToolItems" | "subscribeRun" | "syncRunStream">;
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
    void (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        wire += new TextDecoder().decode(next.value);
      }
    })().catch(() => {});
    await sleep(100);
    const frames = () =>
      wire
        .split("\n\n")
        .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
        .filter((line): line is string => !!line)
        .map((line) => JSON.parse(line.slice(6)) as { name?: string; value?: Record<string, unknown> })
        .filter((frame) => frame.name === "reasoning")
        .map((frame) => frame.value!);
    assert.equal(
      frames()
        .map((v) => v.delta)
        .join(""),
      worker.text,
      "connect-time sync replays the live block",
    );
    bus.emit({ runId: "run", kind: "reasoning", step: "s1", index: 0, offset: 12, text: " the cache" });
    worker.text += " and the queue";
    bus.emit({ runId: "run", kind: "reasoning", step: "s1", index: 0, offset: 22, text: " and the queue" });
    await sleep(50);
    assert.equal(
      frames()
        .map((v) => v.delta)
        .join(""),
      worker.text,
      "overlapping reasoning is sent once",
    );
    assert.deepEqual(
      frames().map((v) => [v.step, v.index, v.offset]),
      [
        ["s1", 0, 0],
        ["s1", 0, 22],
      ],
    );
    syncs.length = 0;
    worker.text += " then more";
    bus.emit({ runId: "run", kind: "reasoning", step: "s1", index: 0, offset: 40, text: "more" });
    await sleep(50);
    assert.deepEqual(syncs, [{ "s1:0": 36 }], "a gap asks the owner for exactly what this stream lacks");
    assert.equal(
      frames()
        .map((v) => v.delta)
        .join(""),
      worker.text,
    );
    for (let i = 1; i <= 10; i++)
      bus.emit({ runId: "run", kind: "reasoning", step: `s${i + 1}`, index: 0, offset: 0, text: "x" });
    syncs.length = 0;
    bus.emit({ runId: "run", kind: "reasoning", step: "s12", index: 0, offset: 5, text: "gap" });
    await sleep(50);
    assert.equal(Object.keys(syncs[0] ?? {}).length, 8, "sync requests stay small however many blocks a run streams");
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
