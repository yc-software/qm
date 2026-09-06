import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("a run executing on another instance still reports alive", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "liveness-")),
      workers: 0,
      leaseTtlMs: 60_000,
      reaperIntervalMs: 60_000,
    }),
  );
  try {
    const { run } = await built.runs.enqueue({
      sessionId: "t1",
      request: {
        surface: "test",
        actor: { id: "u1", type: "internal" },
        conversation: { kind: "dm", threadRef: "t1", audience: [{ id: "u1", type: "internal" }] },
        text: "hello",
        origin: { kind: "human" },
      },
    });
    const claimed = await built.runs.claim("some-other-instance", 60_000);
    assert.equal(claimed?.id, run.id, "the foreign worker holds the run");

    const view = await built.app.getRun(run.id);
    assert.equal(view?.status, "running");
    assert.equal(view?.alive, true, "liveness comes from the durable lease, not this instance's memory");
    assert.notEqual(view?.stale, true);
  } finally {
    await built.runtime.stop();
  }
});

test("a run whose lease has lapsed is not alive", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "liveness-")),
      workers: 0,
      leaseTtlMs: 1,
      reaperIntervalMs: 60_000,
    }),
  );
  try {
    const { run } = await built.runs.enqueue({
      sessionId: "t2",
      request: {
        surface: "test",
        actor: { id: "u1", type: "internal" },
        conversation: { kind: "dm", threadRef: "t2", audience: [{ id: "u1", type: "internal" }] },
        text: "hello",
        origin: { kind: "human" },
      },
    });
    await built.runs.claim("some-other-instance", 1);
    await new Promise((r) => setTimeout(r, 20));

    const view = await built.app.getRun(run.id);
    assert.notEqual(view?.alive, true, "an expired lease is the durable signal that nobody is working");
  } finally {
    await built.runtime.stop();
  }
});
