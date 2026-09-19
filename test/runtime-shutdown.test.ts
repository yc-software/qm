import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("runtime shutdown drains terminal effects before stores and waits for pending error writes", async (t) => {
  const config = testConfig();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const built = buildApp(config);
  const terminalEntered = Promise.withResolvers<void>();
  const terminalRelease = Promise.withResolvers<void>();
  const flushEntered = Promise.withResolvers<void>();
  const flushRelease = Promise.withResolvers<void>();
  let storeClosed = false;
  let terminalFinished = false;
  let stopped = false;
  const close = built.runs.close?.bind(built.runs);
  built.runs.close = async () => {
    storeClosed = true;
    await close?.();
  };
  const flush = built.errors.flush.bind(built.errors);
  built.errors.flush = async () => {
    assert.equal(terminalFinished, true);
    flushEntered.resolve();
    await flushRelease.promise;
    await flush();
  };
  built.runs.onTerminal(async () => {
    terminalEntered.resolve();
    await terminalRelease.promise;
    terminalFinished = true;
    built.errors.record({ category: "test", code: "late", message: "terminal write", scopeLabel: "org:test" });
  });
  await built.runs.enqueue({
    sessionId: "dm:shutdown",
    request: {
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef: "dm:shutdown", audience: [{ id: "U1", type: "internal" }] },
      origin: { kind: "direct" },
      text: "test shutdown",
    },
  });
  const run = (await built.runs.claim("test-worker", 5_000))!;
  await built.runs.complete(run.id, run.leaseToken!, { status: "silent" });
  await terminalEntered.promise;
  const stopping = built.runtime.stop().then(() => {
    stopped = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(storeClosed, false);
    assert.equal(stopped, false);
    terminalRelease.resolve();
    await flushEntered.promise;
    assert.equal(storeClosed, true);
    assert.equal(stopped, false);
    flushRelease.resolve();
    await stopping;
    assert.equal(
      (await built.errors.list()).some((event) => event.code === "late"),
      true,
    );
  } finally {
    terminalRelease.resolve();
    flushRelease.resolve();
    await stopping;
  }
});

test("runtime shutdown finishes other store closes and error flush after a synchronous close failure", async (t) => {
  const config = testConfig();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const built = buildApp(config);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("run store close failed");
  let flushed = false;
  built.runs.close = () => {
    throw failure;
  };
  const close = built.sessionStateBus.close?.bind(built.sessionStateBus);
  built.sessionStateBus.close = async () => {
    entered.resolve();
    await release.promise;
    await close?.();
  };
  const flush = built.errors.flush.bind(built.errors);
  built.errors.flush = async () => {
    flushed = true;
    await flush();
  };
  const stopping = assert.rejects(built.runtime.stop(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(failure));
    return true;
  });
  try {
    await entered.promise;
    assert.equal(flushed, false);
    release.resolve();
    await stopping;
    assert.equal(flushed, true);
  } finally {
    release.resolve();
    await stopping;
  }
});
