import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("runtime stop waits for store closes to finish their final writes", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "stop-close-")) }));
  built.runtime.start();
  let flushed = false;
  built.runs.close = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushed = true;
  };
  await built.runtime.stop();
  assert.equal(flushed, true, "stop() resolved before the run store finished closing");
});

test("a store close that hangs cannot wedge runtime stop", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "stop-close-")), shutdownDrainMs: 100 }));
  built.runtime.start();
  built.runs.close = () => new Promise<void>(() => {});
  const started = Date.now();
  await built.runtime.stop();
  assert.ok(Date.now() - started < 5_000);
});
