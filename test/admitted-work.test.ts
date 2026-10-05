import assert from "node:assert/strict";
import test from "node:test";
import { createAdmittedWork, WorkAdmissionClosed } from "../src/util/admitted-work.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("pause fences new work while accepted work drains, then rollback resumes", async () => {
  const work = createAdmittedWork();
  const finish = Promise.withResolvers<void>();
  const accepted = work.run(() => finish.promise);
  work.pause();
  await assert.rejects(
    work.run(() => assert.fail("ran after pause")),
    WorkAdmissionClosed,
  );
  let drained = false;
  const drain = work.drained().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  work.resume();
  assert.equal(await work.run(() => 42), 42);
  assert.equal(drained, false);
  finish.resolve();
  await accepted;
  await drain;
});

test("already admitted callbacks can start nested work after pause without leaking admission", async () => {
  const work = createAdmittedWork();
  const paused = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let late!: () => Promise<void>;
  let child!: Promise<void>;
  const parent = work.run(async () => {
    await paused.promise;
    child = work.run(() => finish.promise);
    late = () => work.run(() => assert.fail("late outside admission"));
  });
  work.pause();
  paused.resolve();
  await parent;
  await assert.rejects(late(), WorkAdmissionClosed);
  let drained = false;
  const drain = work.drained().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  finish.resolve();
  await child;
  await drain;
});

test("detached async contexts lose admission when their accepting callback finishes", async () => {
  const work = createAdmittedWork();
  const invoke = Promise.withResolvers<void>();
  let delayed!: Promise<void>;
  await work.run(() => {
    delayed = invoke.promise.then(() => work.run(() => assert.fail("stale async context")));
  });
  work.pause();
  invoke.resolve();
  await assert.rejects(delayed, WorkAdmissionClosed);
});

test("failed work does not strand drained", async () => {
  const work = createAdmittedWork();
  await assert.rejects(
    work.run(() => {
      throw new Error("failed work");
    }),
    /failed work/,
  );
  work.pause();
  await work.drained();
});
