import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { takeLoadSample, withLoadProbe } from "../src/sandbox/load-probe.ts";

test("the load probe reports how long the command itself ran on the computer", () => {
  const stdout = execFileSync("sh", ["-c", withLoadProbe("sleep 0.3; echo done")], { encoding: "utf8" });
  const { stdout: output, sample, commandMs } = takeLoadSample(stdout, 0);
  assert.equal(output, "done\n");
  assert.ok(sample);
  assert.ok(commandMs !== undefined && commandMs >= 290 && commandMs < 5_000, `command took ${commandMs} ms`);
});
