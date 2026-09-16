import assert from "node:assert/strict";
import { test } from "node:test";
import { composioCallbackUrl } from "../server/composio-return.ts";
import { saveConnectionAttempt, readConnectionAttempt, clearConnectionAttempt } from "../src/connection-return.ts";

const state = "00000000-0000-4000-8000-000000000000";
test("callbacks stay on the configured public origin and preserve the conversation", () => {
  assert.equal(
    composioCallbackUrl("https://qm.example", "/s/chat?layout=single", state),
    `https://qm.example/s/chat?layout=single&composioReturn=${state}`,
  );
  assert.equal(
    composioCallbackUrl("https://qm.example/web-ui", "/web-ui/s/chat", state),
    `https://qm.example/web-ui/s/chat?composioReturn=${state}`,
  );
  for (const path of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/admin/",
    "/s/chat/../../auth/logout",
    "/s/chat\n",
  ]) {
    assert.equal(composioCallbackUrl("https://qm.example", path, state), null);
  }
  assert.equal(composioCallbackUrl("https://qm.example", "/", "bad"), null);
});

test("return context is bound to the user, nonce, path and expiry", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const attempt = {
    state,
    user: "theo:alice",
    path: "/s/chat",
    service: { id: "gmail", name: "Gmail" },
    accountId: "ca_test",
    widget: "welcome",
    expiresAt: Date.now() + 60000,
    picker: { query: "gmail", expanded: true },
    scrollTop: 180,
  };
  saveConnectionAttempt(attempt);
  assert.deepEqual(readConnectionAttempt(attempt.user, state, attempt.path), attempt);
  assert.equal(readConnectionAttempt("theo:bob", state, attempt.path), null);
  assert.equal(readConnectionAttempt(attempt.user, "different", attempt.path), null);
  assert.equal(readConnectionAttempt(attempt.user, state, "/s/other"), null);
  saveConnectionAttempt({ ...attempt, expiresAt: Date.now() - 1 });
  assert.equal(readConnectionAttempt(attempt.user, state, attempt.path), null);
  saveConnectionAttempt(attempt);
  clearConnectionAttempt(attempt.user);
  assert.equal(readConnectionAttempt(attempt.user, state, attempt.path), null);
});
