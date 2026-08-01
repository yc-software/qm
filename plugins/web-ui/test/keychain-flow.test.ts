import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isActiveGrant, isExpiredCredential, KeychainOperations, keychainSummary } from "../src/keychain-state.ts";

const connectorsSource = readFileSync(new URL("../src/connectors.ts", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const shellCssSource = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

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
  assert.match(shellSource, /resetKeychainState\(\);\s*appState\.me =/);
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
  assert.match(connectorsSource, /keychainOperations\.isCurrentLoad\(load\)/);
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
  assert.match(
    connectorsSource,
    /const stateEpoch = keychainOperations\.captureEpoch\(\);[\s\S]*api<\{ authorizeUrl\?: string \}>[\s\S]*isCurrentEpoch\(stateEpoch\)/,
  );
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

test("keychain overview wires managed connector grants into account controls", () => {
  assert.match(connectorsSource, /connectorCredentials\?: KeychainConnectorCredential\[\]/);
  assert.match(
    connectorsSource,
    /keychainConnectorCredentials\.filter\(\(credential\) => hosts\.has\(credential\.host\)\)/,
  );
  assert.match(connectorsSource, /isActiveGrant\(grant, credentialsById\.get\(grant\.credentialId\)\)/);
  assert.match(connectorsSource, /c\.kind !== "file" && c\.expiresAt/);
});

test("destructive controls settle duplicate attempts while a mutation is busy", () => {
  assert.match(connectorsSource, /\?disabled=\$\{keychainOperations\.mutationInFlight\}/);
  assert.match(connectorsSource, /connectorNotice = t\("Another keychain change is still in progress\."\)/);
  assert.equal(connectorsSource.match(/const operation = beginKeychainMutation\(\)/g)?.length, 3);
  assert.equal(
    connectorsSource.match(/if \(keychainOperations\.finishMutation\(operation\)\) drawConnectors\(\)/g)?.length,
    3,
  );
});

test("keychain rows reserve success badges for actionable states", () => {
  assert.doesNotMatch(connectorsSource, /Stored securely/);
  assert.doesNotMatch(connectorsSource, />Connected<\/span>/);
  assert.match(connectorsSource, /expired \? html`<span class="kc-state warning">\$\{t\("Expired"\)\}<\/span>` : ""/);
  assert.match(connectorsSource, /<span class="kc-state warning">\$\{t\("Reconnect needed"\)\}<\/span>/);
});

test("keychain actions keep secondary weight and compact mobile sizing", () => {
  assert.match(connectorsSource, /\$\{available \? html`<button class="btn" type="button"/);
  assert.doesNotMatch(shellCssSource, /\.kc-hero-actions \.btn\s*\{\s*flex:\s*1;/);
  assert.doesNotMatch(shellCssSource, /sidebar-closed \.kc-hero-copy/);
});
