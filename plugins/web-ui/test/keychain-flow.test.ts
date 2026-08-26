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
  const navigation = operations.beginNavigation()!;

  operations.reset();

  assert.equal(operations.isCurrentLoad(load), false);
  assert.equal(operations.isCurrentEpoch(mutation.epoch), false);
  assert.equal(operations.isCurrentEpoch(drop), false);
  assert.equal(operations.dropInFlight, false);
  assert.equal(navigation.signal.aborted, true);
  assert.equal(operations.isCurrentNavigation(navigation), false);
  const currentMutation = operations.beginMutation()!;
  operations.finishMutation(mutation);
  assert.equal(operations.beginMutation(), null);
  operations.finishMutation(currentMutation);
  assert.ok(operations.beginMutation());
  assert.match(shellSource, /resetKeychainState\(\);\s*appState\.me =/);
});

test("connector navigation is single-flight and cancel-safe", () => {
  const operations = new KeychainOperations();
  const first = operations.beginNavigation()!;
  assert.equal(operations.navigationInFlight, true);
  assert.equal(operations.beginNavigation(), null);
  operations.cancelNavigation();
  assert.equal(first.signal.aborted, true);
  assert.equal(operations.isCurrentNavigation(first), false);
  const next = operations.beginNavigation()!;
  assert.equal(operations.finishNavigation(next), true);
  assert.equal(operations.navigationInFlight, false);
});

test("leaving integrations cancels navigation without clearing other operation locks", () => {
  const operations = new KeychainOperations();
  const mutation = operations.beginMutation()!;
  operations.beginDrop();
  const navigation = operations.beginNavigation()!;

  operations.cancelNavigation();

  assert.equal(navigation.signal.aborted, true);
  assert.equal(operations.beginMutation(), null);
  assert.equal(operations.beginDrop(), null);
  operations.finishMutation(mutation);
  assert.match(shellSource, /appState\.currentView === "keychain"\) leaveKeychainView\(\)/);
  assert.doesNotMatch(shellSource, /appState\.currentView === "keychain"\) resetKeychainState\(\)/);
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

test("a completed mutation can invalidate an older integrations load", () => {
  const operations = new KeychainOperations();
  const load = operations.beginLoad();
  operations.invalidateLoads();
  assert.equal(operations.isCurrentLoad(load), false);
});

test("identity reset invalidates a pending connector start", async () => {
  const operations = new KeychainOperations();
  const operation = operations.beginNavigation()!;
  let navigated = false;
  let resolveStart!: () => void;
  const response = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const continuation = (async () => {
    await response;
    if (operations.isCurrentNavigation(operation)) navigated = true;
  })();

  operations.reset();
  resolveStart();
  await continuation;

  assert.equal(navigated, false);
  assert.match(
    connectorsSource,
    /const operation = keychainOperations\.beginNavigation\(\);[\s\S]*api<\{ authorizeUrl\?: string \}>[\s\S]*isCurrentNavigation\(operation\)/,
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
  assert.match(connectorsSource, /connectorNotice = "Another keychain change is still in progress\."/);
  assert.equal(connectorsSource.match(/const operation = beginKeychainMutation\(\)/g)?.length, 5);
  assert.equal(
    connectorsSource.match(/if \(keychainOperations\.finishMutation\(operation\)\) drawConnectors\(\)/g)?.length,
    3,
  );
});

test("keychain rows reserve success badges for actionable states", () => {
  assert.doesNotMatch(connectorsSource, /Stored securely/);
  assert.doesNotMatch(connectorsSource, />Connected<\/span>/);
  assert.match(connectorsSource, /expired \? html`<span class="kc-state warning">Expired<\/span>` : ""/);
  assert.match(connectorsSource, /<span class="kc-state warning">Reconnect needed<\/span>/);
  assert.match(
    connectorsSource,
    /connection\.healthy && \(!connection\.targetRequired \|\| connection\.target\?\.verified === true\)/,
  );
});

test("keychain actions keep secondary weight and compact mobile sizing", () => {
  assert.match(connectorsSource, /available[\s\S]*navigationInFlight[\s\S]*startConnector\(id\)/);
  assert.doesNotMatch(shellCssSource, /\.kc-hero-actions \.btn\s*\{\s*flex:\s*1;/);
  assert.doesNotMatch(shellCssSource, /sidebar-closed \.kc-hero-copy/);
});

test("integrations degrade clearly when optional secure storage is unavailable", () => {
  assert.match(connectorsSource, /keys\.reason instanceof ApiError && keys\.reason\.status === 404/);
  assert.match(connectorsSource, /Secure credential storage is not enabled on this deployment\./);
  assert.doesNotMatch(connectorsSource, /connectorNotice = "not_found"/);
});

test("managed integrations choose an app before opening Pipedream Connect", () => {
  assert.match(connectorsSource, /\/api\/integrations\/apps\?q=/);
  assert.match(connectorsSource, /JSON\.stringify\(\{ app: appSlug \}\)/);
  assert.match(connectorsSource, /startManagedIntegration\(connection\.appSlug\)/);
  assert.doesNotMatch(connectorsSource, /startManagedIntegration\(\)/);
  assert.match(connectorsSource, /aria-label=\$\{`\$\{managedIntegrationConnecting/);
  assert.match(connectorsSource, /managedIntegrationSearchError/);
  assert.match(shellCssSource, /\.kc-app-result > div[\s\S]*overflow-wrap: anywhere/);
  assert.match(connectorsSource, /Connect the HighLevel sub-account for this business/);
  assert.match(connectorsSource, /not an agency-level account spanning multiple clients/);
  assert.match(connectorsSource, /Provider authorization may include broad read and write access/);
  assert.match(connectorsSource, /await startManagedIntegration\(appSlug, true\)/);
  assert.match(connectorsSource, /Verified \$\{connection\.target\.type\}: \$\{connection\.target\.name\}/);
  assert.match(connectorsSource, /\$\{connection\.appName\} target identity is not verified/);
  assert.match(connectorsSource, /Integration actions stay blocked/);
  assert.match(connectorsSource, /Disconnect and reconnect/);
});

test("managed integration policy changes render the canonical saved account without a stale reload", () => {
  const start = connectorsSource.indexOf("async function updateManagedIntegration");
  const end = connectorsSource.indexOf("async function toggleManagedIntegrationScope", start);
  const policySource = connectorsSource.slice(start, end);
  const [successSource, errorSource] = policySource.split("} catch (error) {");
  assert.match(policySource, /api<\{ account\?: ManagedIntegration \}>/);
  assert.match(policySource, /const saved = result\.account/);
  assert.match(policySource, /saved\.accountId !== connection\.accountId/);
  assert.match(policySource, /isCurrentEpoch\(operation\.epoch\)/);
  assert.match(policySource, /keychainOperations\.invalidateLoads\(\)/);
  assert.match(policySource, /managedIntegrations = managedIntegrations\.map/);
  assert.match(policySource, /current\.accountId === saved\.accountId \? saved : current/);
  assert.doesNotMatch(successSource, /renderConnectors\(\)/);
  assert.match(errorSource ?? "", /await renderConnectors\(\)/);
});
