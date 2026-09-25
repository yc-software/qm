import assert from "node:assert/strict";
import test from "node:test";
import { releaseBlockers } from "./live-slack/harness.ts";
import { scenarios } from "./live-slack/scenarios.ts";

test("release gates reject retries, skips, and quarantined failures", () => {
  assert.equal(releaseBlockers([{ status: "pass" }]).length, 0);
  assert.equal(releaseBlockers([{ status: "fail" }]).length, 1);
  assert.equal(releaseBlockers([{ status: "flaky" }]).length, 1);
  assert.equal(releaseBlockers([{ status: "skip" }]).length, 1);
});

test("the deployed release tier covers critical Slack and file paths", () => {
  const release = scenarios.filter((scenario) => scenario.tags?.includes("release"));
  assert.deepEqual(release.map((scenario) => scenario.name).toSorted(), [
    "concurrent-second-message",
    "dm-continuation",
    "dm-file-attach",
    "dm-reply",
    "file-upload",
    "mention-reply",
    "runtime-model-handoff",
    "teammate-dm-reach",
    "thread-context",
  ]);
  assert.ok(release.every((scenario) => !scenario.tags?.includes("quarantine")));
});
