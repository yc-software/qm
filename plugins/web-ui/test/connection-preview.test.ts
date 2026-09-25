import { test } from "node:test";
import assert from "node:assert/strict";

const values = new Map<string, string>();
let destination = "";
Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: {
    href: "http://localhost:8138/?connectionDemo=1",
    hostname: "localhost",
    pathname: "/",
    assign: (url: string) => {
      destination = url;
    },
  },
  configurable: true,
});
const preview = await import("../src/connection-preview.ts");

test("preview keeps the app, search, scroll and return state through a page redirect", () => {
  preview.startPreviewAttempt("acme:alex", { id: "gmail", name: "Gmail" }, { query: "gmail", expanded: false }, 80);
  const attempt = preview.readPreviewAttempt("acme:alex")!;
  assert.equal(new URL(destination).searchParams.get("connectionConsent"), attempt.state);
  assert.equal(new URL(attempt.callbackUrl).searchParams.get("connectionReturn"), attempt.state);
  assert.equal(attempt.picker.query, "gmail");
  assert.equal(attempt.scrollTop, 80);
  assert.equal(preview.readPreviewAttempt("acme:someone-else"), null);
  assert.equal(preview.verifyPreviewAttempt(attempt), false);
  preview.finishPreviewAttempt(attempt, "success");
  assert.equal(new URL(destination).searchParams.get("status"), "success");
  assert.equal(new URL(destination).searchParams.get("connectedAccountId"), attempt.accountId);
  assert.equal(preview.verifyPreviewAttempt(attempt), true);
  preview.savePreviewConnection(attempt);
  assert.deepEqual(preview.previewConnections("acme:alex"), ["gmail"]);
  assert.deepEqual(preview.previewConnections("acme:someone-else"), []);
  preview.clearPreviewAttempt(attempt);
  assert.equal(preview.readPreviewAttempt("acme:alex"), null);
});

test("cancellation never becomes a verified connection", () => {
  preview.startPreviewAttempt("acme:alex", { id: "github", name: "GitHub" }, { query: "", expanded: true }, 0);
  const attempt = preview.readPreviewAttempt("acme:alex")!;
  preview.finishPreviewAttempt(attempt, "cancelled");
  assert.equal(new URL(destination).searchParams.get("error"), "access_denied");
  assert.equal(preview.verifyPreviewAttempt(attempt), false);
  assert.deepEqual(preview.previewConnections("acme:alex"), ["gmail"]);
});

test("expired attempts cannot be resumed", () => {
  const attempt = preview.readPreviewAttempt("acme:alex")!;
  values.set("qm-connection-preview:attempt", JSON.stringify({ ...attempt, expiresAt: Date.now() - 1 }));
  assert.equal(preview.readPreviewAttempt("acme:alex"), null);
});
