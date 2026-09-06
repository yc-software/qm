import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { recentPrincipalDeliveryNote } from "../src/core/orchestrator/turn-helpers.ts";

async function deliveredNote(texts: string[]): Promise<string> {
  const store = createDeliveryStore();
  for (const [i, text] of texts.entries()) {
    const d = await store.enqueue({
      destination: { type: "principal", target: "U-alice", onBehalfOf: "U-carol" },
      text,
      idempotencyKey: `k-${i}`,
    });
    await store.recordRecipientThread(d.id, "dm:D-alice", 1_700_000_000_000 + i);
  }
  return recentPrincipalDeliveryNote(store, "dm:D-alice");
}

test("a long delivery is capped at 200 chars with an ellipsis, keeping timestamp and sender", async () => {
  const long = "legal-cycle report: " + "clause ".repeat(1000);
  const note = await deliveredNote([long]);
  const item = note.split("\n").find((l) => l.startsWith("- "));
  assert.ok(item, "note contains a delivery item");
  assert.match(item!, /^- \d{4}-\d{2}-\d{2}T[\d:.]+Z from U-carol: /);
  const body = item!.split(" from U-carol: ")[1]!;
  assert.equal(body.length, 201);
  assert.ok(body.endsWith("…"));
  assert.equal(body.slice(0, 200), long.replace(/\s+/g, " ").slice(0, 200));
});

test("a short delivery stays verbatim", async () => {
  const note = await deliveredNote(["deploy digest ready"]);
  assert.match(note, /from U-carol: deploy digest ready$/m);
  assert.doesNotMatch(note, /…/);
});

test("the note lists at most five deliveries", async () => {
  const note = await deliveredNote(Array.from({ length: 8 }, (_, i) => `delivery number ${i}`));
  const items = note.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(items.length, 5);
  assert.match(note, /delivery number 7/);
  assert.doesNotMatch(note, /delivery number 2\b/);
});
