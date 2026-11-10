import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresLedgerEventBus, type OwnedLedgerEvent } from "../src/loops/ledger-events.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function event(over: Partial<OwnedLedgerEvent> = {}): OwnedLedgerEvent {
  return { loopId: "loop-1", itemId: "item-1", op: "ingest", at: 111, owner: "josh", ...over };
}

test("ledger events cross bus instances and an unsubscribed listener hears nothing more", async () => {
  const url = testDatabaseUrl();
  const a = createPostgresLedgerEventBus(url);
  const b = createPostgresLedgerEventBus(url);
  try {
    const got: OwnedLedgerEvent[] = [];
    let off = (): void => {};
    const ready = new Promise<void>((resolve) => {
      off = b.subscribe((e) => {
        if (e.loopId === "loop-xbus") {
          got.push(e);
          resolve();
        }
      });
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      a.emit(event({ loopId: "loop-xbus", itemId: "item-9", op: "shipped", at: 42, owner: "ada" }));
      const landed = await Promise.race([
        ready.then(() => true),
        new Promise((r) => setTimeout(r, 250)).then(() => false),
      ]);
      if (landed) break;
      if (Date.now() > deadline) assert.fail("event never crossed instances");
    }
    assert.equal(got[0]?.itemId, "item-9");
    assert.equal(got[0]?.op, "shipped");
    assert.equal(got[0]?.owner, "ada");
    assert.equal(got[0]?.at, 42);
    off();
    await new Promise((r) => setTimeout(r, 300));
    const heard = got.length;
    a.emit(event({ loopId: "loop-xbus", op: "reopen" }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(got.length, heard, "an unsubscribed listener hears nothing");
  } finally {
    await a.close?.();
    await b.close?.();
  }
});
