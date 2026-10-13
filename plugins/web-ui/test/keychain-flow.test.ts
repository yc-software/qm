import { test } from "node:test";
import assert from "node:assert/strict";
import { isActiveGrant, isExpiredCredential, KeychainOperations, keychainSummary } from "../src/keychain-state.ts";

test("reset invalidates identity-bound loads and operations", () => {
  const operations = new KeychainOperations();
  const load = operations.beginLoad();
  const mutation = operations.beginMutation()!;
  const drop = operations.beginDrop()!;

  operations.reset();

  assert.equal(operations.isCurrentLoad(load), false);
  assert.equal(operations.isCurrentEpoch(mutation.epoch), false);
  assert.equal(operations.isCurrentEpoch(drop), false);
  assert.equal(operations.dropInFlight, false);
  const currentMutation = operations.beginMutation()!;
  operations.finishMutation(mutation);
  assert.equal(operations.beginMutation(), null);
  operations.finishMutation(currentMutation);
  assert.ok(operations.beginMutation());
});

test("a reversed keychain load cannot overwrite the latest response", async () => {
  const operations = new KeychainOperations();
  let value = "initial";
  let resolveOlder!: () => void;
  let resolveLatest!: () => void;
  const olderResponse = new Promise<void>((resolve) => {
    resolveOlder = resolve;
  });
  const latestResponse = new Promise<void>((resolve) => {
    resolveLatest = resolve;
  });
  const apply = async (load: number, response: Promise<void>, next: string) => {
    await response;
    if (operations.isCurrentLoad(load)) value = next;
  };

  const older = apply(operations.beginLoad(), olderResponse, "older");
  const latest = apply(operations.beginLoad(), latestResponse, "latest");
  resolveLatest();
  await latest;
  resolveOlder();
  await older;

  assert.equal(value, "latest");
});

test("identity reset invalidates a pending connector start", async () => {
  const operations = new KeychainOperations();
  const epoch = operations.captureEpoch();
  let navigated = false;
  let resolveStart!: () => void;
  const response = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const continuation = (async () => {
    await response;
    if (operations.isCurrentEpoch(epoch)) navigated = true;
  })();

  operations.reset();
  resolveStart();
  await continuation;

  assert.equal(navigated, false);
});

test("destructive mutations and secure drops are single-flight", () => {
  const operations = new KeychainOperations();
  const mutation = operations.beginMutation()!;
  assert.equal(operations.mutationInFlight, true);
  assert.equal(operations.beginMutation(), null);
  assert.equal(operations.finishMutation(mutation), true);
  assert.equal(operations.mutationInFlight, false);
  assert.ok(operations.beginMutation());

  const drop = operations.beginDrop()!;
  assert.equal(operations.beginDrop(), null);
  operations.finishDrop(drop);
  assert.notEqual(operations.beginDrop(), null);
});

test("keychain summary excludes expired grants and counts pending asks", () => {
  const now = 10_000;
  const env = { id: "env", kind: "env", expiresAt: now + 1 };
  assert.equal(isActiveGrant({ credentialId: env.id, status: "active", expiresAt: now - 1 }, env, now), false);
  assert.equal(isActiveGrant({ credentialId: env.id, status: "active", expiresAt: now + 1 }, env, now), true);
  assert.equal(isActiveGrant({ credentialId: "missing", status: "active" }, undefined, now), false);

  const expiredEnv = { id: "expired-env", kind: "env", expiresAt: now - 1 };
  const legacyFile = { id: "legacy-file", kind: "file", expiresAt: now - 1 };
  const connector = { id: "connector", kind: "connector", expiresAt: now - 1 };
  assert.equal(isExpiredCredential(expiredEnv, now), true);
  assert.equal(isExpiredCredential(legacyFile, now), false);
  assert.equal(isExpiredCredential(connector, now), false);
  assert.equal(isActiveGrant({ credentialId: expiredEnv.id, status: "active" }, expiredEnv, now), false);
  assert.equal(isActiveGrant({ credentialId: legacyFile.id, status: "active" }, legacyFile, now), true);
  assert.equal(isActiveGrant({ credentialId: connector.id, status: "active" }, connector, now), true);

  const summary = keychainSummary(
    [{ connected: true }, { connected: true, needsReconnect: true }],
    [env, expiredEnv, legacyFile, connector],
    [
      { credentialId: env.id, status: "active" },
      { credentialId: expiredEnv.id, status: "active" },
      { credentialId: legacyFile.id, status: "active" },
      { credentialId: connector.id, status: "active" },
      { credentialId: env.id, status: "active", expiresAt: now - 1 },
      { credentialId: env.id, status: "revoked" },
    ],
    [{ id: "ask-1" }],
    now,
  );

  assert.deepEqual(summary, { connected: 1, activeGrants: 3, attention: 3 });
});

test("an inline credential card decides through the keychain approval route, not the command route", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ ask: { status: "approved" } });
  }) as typeof fetch;
  try {
    const { resolveApproval } = await import("../src/core-bridge.ts");
    assert.equal(await resolveApproval({ requestId: "keychain:a1", approved: true, scope: "always" }), "");
    await resolveApproval({ requestId: "keychain:a2", approved: true, scope: "once" });
    await resolveApproval({ requestId: "keychain:a3", approved: false });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    calls.map((c) => [c.url.replace(/^.*(\/api\/)/, "$1"), (c.body as { decision: string }).decision]),
    [
      ["/api/keychain/approvals/a1", "standing"],
      ["/api/keychain/approvals/a2", "once"],
      ["/api/keychain/approvals/a3", "deny"],
    ],
  );
});
