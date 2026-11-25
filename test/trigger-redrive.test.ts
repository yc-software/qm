import { test } from "node:test";
import assert from "node:assert/strict";
import { REDRIVE_MIN_AGE_MS, redriveHandedOffFires } from "../src/triggers/redrive.ts";

const idempotency = (committed: string[]) => ({ committed: async (key: string) => committed.includes(key) });

test("re-drives only fires old enough to have been handed off and not yet committed", async () => {
  const now = 10 * REDRIVE_MIN_AGE_MS;
  const refired: string[] = [];
  await redriveHandedOffFires(
    [
      { fireKey: "old", firedAt: now - 2 * REDRIVE_MIN_AGE_MS },
      { fireKey: "young", firedAt: now - REDRIVE_MIN_AGE_MS + 1 },
      { fireKey: "done", firedAt: now - 2 * REDRIVE_MIN_AGE_MS },
    ],
    { now, idempotency: idempotency(["done"]), refire: (f) => void refired.push(f.fireKey) },
  );
  assert.deepEqual(refired, ["old"]);
});

test("stops re-driving once the caller is stopping", async () => {
  const refired: string[] = [];
  let stopping = false;
  await redriveHandedOffFires(
    [
      { fireKey: "a", firedAt: 0 },
      { fireKey: "b", firedAt: 0 },
    ],
    {
      now: 10 * REDRIVE_MIN_AGE_MS,
      idempotency: idempotency([]),
      stopped: () => stopping,
      refire: (f) => {
        refired.push(f.fireKey);
        stopping = true;
      },
    },
  );
  assert.deepEqual(refired, ["a"]);
});
