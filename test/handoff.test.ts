import test from "node:test";
import assert from "node:assert/strict";
import { createHandoff } from "../src/runs/handoff.ts";
import { sleep } from "../src/util/async.ts";

test("returning leadership preserves the retiring generation's deadline", async () => {
  const handoff = createHandoff();
  const retiring = handoff.signals();
  handoff.request(10);
  handoff.reset();
  await sleep(30);
  assert.equal(retiring.requested.aborted, true);
  assert.equal(retiring.deadline.aborted, true);
  assert.equal(handoff.signals().requested.aborted, false);
  assert.equal(handoff.signals().deadline.aborted, false);
});

test("shutdown can shorten but cannot extend a handoff deadline", async () => {
  const handoff = createHandoff();
  handoff.request(10);
  handoff.request(10000);
  await sleep(30);
  assert.equal(handoff.signals().deadline.aborted, true);
  handoff.reset();
  handoff.request(10000);
  handoff.request(0);
  assert.equal(handoff.signals().deadline.aborted, true);
});
