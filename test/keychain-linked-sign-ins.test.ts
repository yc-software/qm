import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const HOST = "mcp.example.test";
const PERSON = "jordan@acme.test";
const SIGN_IN = "oidc:issuer:jordan";
const OTHER = "riley@acme.test";

function setup(t: { after(fn: () => void): void }) {
  const creds = testMap<KeychainCredential>();
  const keychain = createKeychain({
    creds,
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("keychain-linked-test-key"),
    lock: testAdvisoryLock(),
  });
  const link = () =>
    installPrincipalLinks({
      canonical: (key) => (key === SIGN_IN ? PERSON : key === PERSON ? PERSON : undefined),
      aliases: (key) => (key === PERSON ? [SIGN_IN] : []),
    });
  t.after(() => installPrincipalLinks(null));
  return { creds, keychain, link };
}

const token = (accessToken: string) => ({ accessToken, expiresAt: Date.now() + 3_600_000 });

test("a login saved under one sign-in is found from every linked sign-in", async (t) => {
  const { keychain, link } = setup(t);
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-sign-in"));
  assert.equal(await keychain.connectorAccessToken(HOST, PERSON), null);
  link();
  assert.equal(await keychain.connectorAccessToken(HOST, PERSON), "at-sign-in");
  assert.equal(await keychain.connectorAccessToken(HOST, SIGN_IN), "at-sign-in");
  assert.equal((await keychain.connectorTokenStatus(HOST, PERSON)).connected, true);
  assert.equal(await keychain.connectorAccessToken(HOST, OTHER), null);
  assert.equal((await keychain.connectorTokenStatus(HOST, OTHER)).connected, false);
});

test("the sign-in in use wins, then the canonical sign-in", async (t) => {
  const { keychain, link } = setup(t);
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-sign-in"));
  await keychain.setConnectorToken(HOST, PERSON, token("at-person"));
  link();
  assert.equal(await keychain.connectorAccessToken(HOST, SIGN_IN), "at-sign-in");
  assert.equal(await keychain.connectorAccessToken(HOST, PERSON), "at-person");
  assert.equal(await keychain.connectorAccessToken(HOST, "Jordan@Acme.test"), "at-person");
});

test("reconnecting from a linked sign-in replaces the person's one login", async (t) => {
  const { creds, keychain, link } = setup(t);
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-old"));
  link();
  await keychain.setConnectorToken(HOST, PERSON, token("at-new"));
  const stored = (await creds.all()).filter((c) => c.host === HOST);
  assert.equal(stored.length, 1);
  assert.equal(await keychain.connectorAccessToken(HOST, SIGN_IN), "at-new");
});

test("a new login from a linked sign-in is stored under the canonical sign-in", async (t) => {
  const { creds, keychain, link } = setup(t);
  link();
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-new"));
  const [rec] = (await creds.all()).filter((c) => c.host === HOST);
  assert.equal(rec?.ownerId, PERSON);
  assert.equal(await keychain.connectorAccessToken(HOST, PERSON), "at-new");
});

test("disconnecting removes the login from every linked sign-in and leaves others alone", async (t) => {
  const { creds, keychain, link } = setup(t);
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-sign-in"));
  await keychain.setConnectorToken(HOST, PERSON, token("at-person"));
  await keychain.setConnectorToken(HOST, OTHER, token("at-other"));
  link();
  await keychain.deleteConnectorToken(HOST, PERSON);
  assert.equal(await keychain.connectorAccessToken(HOST, SIGN_IN), null);
  assert.equal(await keychain.connectorAccessToken(HOST, PERSON), null);
  assert.equal(await keychain.connectorAccessToken(HOST, OTHER), "at-other");
  assert.equal((await creds.all()).length, 1);
});

test("granting a connector to a scope grants the login the person actually has", async (t) => {
  const { creds, keychain, link } = setup(t);
  await keychain.setConnectorToken(HOST, SIGN_IN, token("at-sign-in"));
  link();
  const grant = await keychain.grantConnectorToScope({
    host: HOST,
    principalId: PERSON,
    audienceScopeId: "channel:C1",
    purpose: "test",
  });
  const [rec] = await creds.all();
  assert.equal(grant?.credentialId, rec?.id);
  assert.equal(grant?.ownerId, SIGN_IN);
});
