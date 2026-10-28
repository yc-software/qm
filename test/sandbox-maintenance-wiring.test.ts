import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("sandbox maintenance runs when both idle stopping settings are disabled", async () => {
  const config = testConfig({ deepIdleMachineMs: 0, devIdleMachineMs: 0, sandboxBackend: "aws" });
  config.awsSandbox.s3Bucket = "maintenance-test";
  const built = buildApp(config);
  const called = Promise.withResolvers<number[]>();
  built.sandbox.reapDeepIdle = async (idleMs: number, devIdleMs: number) => {
    called.resolve([idleMs, devIdleMs]);
    return { reaped: 0 };
  };
  const deadline = new AbortController();
  try {
    built.runtime.startBackground();
    assert.deepEqual(
      await Promise.race([
        called.promise,
        delay(1_000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error("sandbox maintenance did not run");
        }),
      ]),
      [0, 0],
    );
  } finally {
    deadline.abort();
    await built.runtime.stop();
  }
});
