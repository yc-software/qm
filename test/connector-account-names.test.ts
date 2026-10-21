import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { isAccountType, MODEL_LOGIN_ACCOUNT_TYPE, parseAccountName } from "../src/connectors/oauth.ts";
import { connectorAccountSlots } from "../src/credentials/connector-accounts.ts";
import { tokenFor } from "../src/loops/sources/adapter.ts";

const keychain = () =>
  createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa"),
  });

test("account names: built-in slots, workspace and email names pass; unsafe, oversized or reserved names fail", () => {
  for (const name of ["default", "personal", "company", "globex", "acme-eng", "ops@example.com", "a", "x".repeat(64)])
    assert.equal(isAccountType(name), true, name);
  for (const name of [
    "",
    "x".repeat(65),
    "Ops",
    "-a",
    "a-",
    "a b",
    "a:b",
    "a/b",
    "../x",
    "a\u0000",
    "é",
    MODEL_LOGIN_ACCOUNT_TYPE,
    1,
    null,
  ])
    assert.equal(isAccountType(name), false, String(name));
  assert.equal(parseAccountName("  Ops@Example.COM "), "ops@example.com");
  assert.equal(parseAccountName("bad slot"), null);
  assert.equal(parseAccountName(undefined), null);
});

test("connectorAccountSlots lists a principal's named accounts per host from the keychain inventory", async () => {
  const kc = keychain();
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "a", accountType: "globex" }, "globex");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "b", accountType: "acme-eng" }, "acme-eng");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "c" }, "personal");
  await kc.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "d", accountType: "a@b.io" }, "a@b.io");
  await kc.setConnectorToken("slack.com", "U2", { accessToken: "e", accountType: "other" }, "other");
  await kc.setConnectorToken("claude.ai", "U1", { accessToken: "f" }, MODEL_LOGIN_ACCOUNT_TYPE);

  const slots = await connectorAccountSlots(kc, "U1");
  assert.deepEqual(slots("slack.com"), ["default", "personal", "company", "acme-eng", "globex"]);
  assert.deepEqual(slots("GMAIL.googleapis.com"), ["default", "personal", "company", "a@b.io"]);
  assert.deepEqual(slots("claude.ai"), ["default", "personal", "company"]);
  assert.deepEqual((await connectorAccountSlots({}, "U1"))("slack.com"), ["default", "personal", "company"]);
});

test("loop token selection keeps the built-in order and falls back to a named account", async () => {
  const kc = keychain();
  assert.equal(await tokenFor(kc, "slack.com", "U1"), null);
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "named", accountType: "globex" }, "globex");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "named");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "company" }, "company");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "company");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "default" });
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "default");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "personal" }, "personal");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "personal");
});
