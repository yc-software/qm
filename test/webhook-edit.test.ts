import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { testMap } from "./support/test-database.ts";
import { personalScope } from "../src/types.ts";
test("editing a webhook's action keeps its id (URL) and secret", async () => {
  const store = createWebhookStore(testMap(), testMap());
  const wh = await store.create({
    owner: "u:a",
    createdBy: "u:a",
    ownerScopeId: personalScope("a"),
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

test("a webhook's title is set on create, normalized, and renamed without touching its task", async () => {
  const store = createWebhookStore(testMap(), testMap());
  const wh = await store.create({
    owner: "u:a",
    createdBy: "u:a",
    ownerScopeId: personalScope("a"),
    title: "  GitHub   PR review ",
    action: "review it",
    verification: { scheme: "hmac-sha256", secret: "s3cret" },
  });
  assert.equal(wh.title, "GitHub PR review");
  const out = await store.update(wh.id, { title: "PR triage" });
  assert.equal(out?.title, "PR triage");
  assert.equal(out?.action, "review it");
});
