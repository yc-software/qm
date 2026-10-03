import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("runtime.stop() waits for startup seeding, so a stopped runtime writes nothing afterwards", async () => {
  const built = buildApp(testConfig({ seedSkills: true }));
  await built.runtime.stop();
  const atStop = (await built.skills.list()).length;
  assert.ok(atStop > 0, "seed skills were installed before stop resolved");
  await sleep(300);
  assert.equal((await built.skills.list()).length, atStop, "no skill writes after stop");
});
