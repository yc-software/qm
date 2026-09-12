import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalReceipts } from "../src/harness/signal-receipts.ts";

test("closing before deferred submission prevents old buffered delivery", async () => {
  const receipts = createSignalReceipts();
  let submitted = false;
  const pending = receipts.waitFor("one", async () => {
    submitted = true;
  });
  receipts.close();
  await assert.rejects(pending, /closed/);
  assert.equal(submitted, false);
});

test("closing unblocks an unconsumed receipt even if submission is still pending", async () => {
  const receipts = createSignalReceipts();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const pending = receipts.waitFor("one", async () => {
    entered.resolve();
    await blocked.promise;
  });
  await entered.promise;
  receipts.close();
  await assert.rejects(pending, /closed/);
  receipts.accept("one");
  blocked.resolve();
  await assert.rejects(
    receipts.waitFor("two", async () => {}),
    /closed/,
  );
});
