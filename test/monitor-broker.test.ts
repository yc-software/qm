import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitorBroker, readBackgroundOutputTail } from "../src/monitors/monitor-broker.ts";
import type { BackgroundWatchArmedResult, BackgroundWatchResult } from "../src/monitors/monitor-broker.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { scopeId } from "../src/types.ts";

const SCOPE = "personal:U1";
type ReadOutputTail = Parameters<typeof createMonitorBroker>[0]["readOutputTail"];

function armed(r: BackgroundWatchResult): BackgroundWatchArmedResult {
  if ("completed" in r) assert.fail("expected watch to arm a monitor");
  return r;
}

async function harness(readOutputTail: ReadOutputTail = async () => ({ outputTail: "" })) {
  const store = createMonitorStore();
  const registry = createMemoryProcessRegistry();
  const rec = await registry.register({
    processId: "p-1",
    scopeId: SCOPE,
    kind: "background",
    command: "bg: npm test",
    ttlMs: 60_000,
  });
  const broker = createMonitorBroker({
    store,
    registry,
    readOutputTail,
    scopeId: SCOPE,
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    threadRef: "thread-1",
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
    graceMs: 1000,
  });
  return { store, registry, broker, rec };
}

test("watch arms a monitor inheriting the turn's owner, scope, thread, and destination", async () => {
  const { broker, store, rec } = await harness();
  const r = armed(await broker.watch("p-1", { instructions: "summarize failures", pattern: "FAIL", sinceCursor: 7 }));
  assert.equal(r.reattached, false);
  assert.equal(r.expiresAt, rec.expiresAt + 1000);
  const m = await store.get(r.monitorId);
  assert.equal(m?.owner, "U1");
  assert.equal(m?.ownerScopeId, "personal:U1");
  assert.equal(m?.threadRef, "thread-1");
  assert.equal(m?.destination?.target, "D1");
  assert.equal(m?.cursor, 7);
  assert.equal(m?.pattern, "FAIL");
  assert.equal(m?.instructions, "summarize failures");
  assert.equal(m?.command, "bg: npm test");
});

test("watching the same job in the same thread twice reattaches instead of double-arming", async () => {
  const { broker, store } = await harness();
  const first = armed(await broker.watch("p-1"));
  const second = armed(await broker.watch("p-1"));
  assert.equal(second.reattached, true);
  assert.equal(second.monitorId, first.monitorId);
  assert.equal((await store.list()).length, 1);
});

test("a repeat watch re-arms with the new settings instead of silently keeping stale ones", async () => {
  const { broker, store } = await harness();
  const first = armed(await broker.watch("p-1", { pattern: "FAIL", instructions: "old", sinceCursor: 5 }));
  await store.advance(first.monitorId, { cursor: 9, tail: "partial" });
  const second = armed(await broker.watch("p-1", { pattern: "ERROR", instructions: "new", sinceCursor: 20 }));
  assert.equal(second.reattached, true);
  const m = await store.get(first.monitorId);
  assert.equal(m?.pattern, "ERROR");
  assert.equal(m?.instructions, "new");
  assert.equal(m?.cursor, 20);
  assert.equal(m?.tail, undefined);

  await broker.watch("p-1", { sinceCursor: 30 });
  const after = await store.get(first.monitorId);
  assert.equal(after?.pattern, "ERROR");
  assert.equal(after?.instructions, "new");
  assert.equal(after?.cursor, 30);
});

test("watch refuses a job from another scope and an unknown job", async () => {
  const { broker, registry } = await harness();
  await registry.register({
    processId: "p-other",
    scopeId: "personal:U2",
    kind: "background",
    command: "bg: x",
    ttlMs: 60_000,
  });
  await assert.rejects(() => broker.watch("p-other"), /no such background job/);
  await assert.rejects(() => broker.watch("p-missing"), /no such background job/);
});

test("watch on an exited job with output returns its final tail without arming a monitor", async () => {
  const calls: Array<{ processId: string; maxBytes: number }> = [];
  const { broker, registry, store } = await harness(async (processId, maxBytes) => {
    calls.push({ processId, maxBytes });
    return { outputTail: "last lines\nfinished\n", cursor: 8192, exitCode: 0 };
  });
  await registry.markStatus("p-1", "exited");

  const r = await broker.watch("p-1");

  assert.deepEqual(r, {
    processId: "p-1",
    completed: true,
    registryStatus: "exited",
    exitCode: 0,
    outputTail: "last lines\nfinished\n",
    cursor: 8192,
  });
  assert.deepEqual(calls, [{ processId: "p-1", maxBytes: 4096 }]);
  assert.equal((await store.list()).length, 0);
});

test("watch on an exited job with no output returns success without arming a monitor", async () => {
  const { broker, registry, store } = await harness(async () => ({ outputTail: "", cursor: 0 }));
  await registry.markStatus("p-1", "exited");

  const r = await broker.watch("p-1");

  assert.deepEqual(r, {
    processId: "p-1",
    completed: true,
    registryStatus: "exited",
    outputTail: "",
    cursor: 0,
  });
  assert.equal((await store.list()).length, 0);
});

test("readBackgroundOutputTail scans output and keeps the final bytes", async () => {
  const output = "abcdefghij";

  const r = await readBackgroundOutputTail(5, async (cursor, maxBytes) => {
    const next = Math.min(output.length, cursor + maxBytes);
    return {
      chunks: output.slice(cursor, next),
      cursor: next,
      ...(next === output.length ? { exitCode: 0 } : {}),
    };
  });

  assert.deepEqual(r, { outputTail: "fghij", cursor: 10, exitCode: 0 });
});

test("watch rejects an invalid regex pattern up front", async () => {
  const { broker } = await harness();
  await assert.rejects(() => broker.watch("p-1", { pattern: "(" }), /literal alternatives/);
  await assert.rejects(() => broker.watch("p-1", { pattern: "(a+)+$" }), /literal alternatives/);
  await assert.rejects(() => broker.watch("p-1", { pattern: "(a|aa)+$" }), /literal alternatives/);
  await assert.rejects(() => broker.watch("p-1", { pattern: ".*a.*a.*a.*a.*a.*a.*a.*a.*b" }), /literal alternatives/);
});

test("unwatch removes own monitors only", async () => {
  const { broker, store } = await harness();
  const r = armed(await broker.watch("p-1"));
  const other = await store.create({
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: scopeId("personal", "U2"),
    processId: "p-9",
    command: "bg: y",
    threadRef: "t9",
    expiresAt: Date.now() + 1000,
  });
  assert.equal((await broker.unwatch(other.id)).removed, false);
  assert.ok(await store.get(other.id));
  assert.equal((await broker.unwatch(r.monitorId)).removed, true);
  assert.equal(await store.get(r.monitorId), null);
});
