import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
test("editing a webhook's action keeps its id (URL) and secret", async () => {
  const store = createWebhookStore();
  const wh = await store.create({
    owner: "u:a",
    createdBy: "u:a",
    ownerScopeId: "personal:a",
    action: "old task",
    verification: { scheme: "hmac-sha256", secret: "s3cret" },
  });
  const out = await store.update(wh.id, { action: "new task" });
  assert.equal(out?.id, wh.id);
  assert.equal(out?.action, "new task");
  assert.equal(out?.verification.secret, "s3cret");
  assert.equal((await store.get(wh.id))?.action, "new task");
  assert.equal(await store.update("nope", { action: "x" }), null);
});
