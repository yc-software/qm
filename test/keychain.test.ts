import "./support/auto-fake-sprites.ts";

import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import {
  createKeychain,
  credentialHandle,
  renderAskLedger,
  renderKeychainManifest,
  fileCredentialEnvironment,
  KeychainError,
  type Keychain,
  type KeychainGrant,
} from "../src/credentials/keychain.ts";
import { createMemoryMap, type DurableMap, type DurableMapSelect } from "../src/persistence/durable-map.ts";
import { envKey } from "../src/credentials/connector-token.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { materializeGrant } from "./support/materialize-grant.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const KEY = deriveConnectorKey("keychain-test-key");

function kc(now?: () => number): Keychain {
  return createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
    ...(now ? { now } : {}),
  });
}

const GH = {
  ownerId: "U1",
  service: "github",
  secret: "ghp_secret",
  envKey: "GITHUB_TOKEN",
  accountLabel: "AliceBell",
};

test("save → list returns metadata only (no secret material), and re-save upserts the same slot", async () => {
  const k = kc();
  const meta = await k.save(GH);
  assert.equal(meta.envKey, "GITHUB_TOKEN");
  assert.ok(!("secretEnc" in meta), "metadata view must not carry the encrypted secret");
  assert.ok(!JSON.stringify(meta).includes("ghp_secret"));

  const again = await k.save({ ...GH, secret: "ghp_rotated" });
  assert.equal(again.id, meta.id, "same owner+service+envKey is one record");
  assert.notEqual(again.fingerprint, meta.fingerprint, "rotation changes the fingerprint");
  assert.equal((await k.listByOwner("U1")).length, 1);
  assert.deepEqual(await k.listByOwner("U9"), []);
});

test("listAllMetadata returns person-facing metadata only", async () => {
  const k = kc();
  const meta = await k.save(GH);
  await k.setConnectorToken("github.com", "U1", { accessToken: "gho_managed" });
  await k.setServiceCredential(scopeId("org", "default-org"), {
    slug: "serp",
    name: "SERP",
    secret: "s3",
    host: "api.serper.dev",
  });

  const all = await k.listAllMetadata();
  assert.deepEqual(
    all.map((c) => c.id),
    [meta.id],
  );
  assert.ok(!JSON.stringify(all).includes("ghp_secret"));
  assert.ok(!JSON.stringify(all).includes("gho_managed"));
  assert.ok(!JSON.stringify(all).includes("s3"));
});

test("listing and per-owner reads use the store's projected select and never a full all() scan", async () => {
  type Rec = import("../src/credentials/keychain.ts").KeychainCredential;
  const backing = createMemoryMap<Rec>();
  const calls: string[] = [];
  const creds: DurableMap<Rec> = {
    ...backing,
    async all() {
      calls.push("all");
      return backing.all();
    },
    async select<K extends Extract<keyof Rec, string> = never>(query: DurableMapSelect<Rec, K>) {
      calls.push(`select:${(query.omit ?? []).join(",") || "full"}:${query.where ? "byOwner" : "unfiltered"}`);
      return backing.select(query);
    },
  };
  const k = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
  });
  const org = scopeId("org", "default-org");
  await k.save({ ...GH, ownerId: "Alice@X.com" });
  await k.save(GH);
  await k.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "ya29.u1" });
  await k.setServiceCredential(org, { slug: "stripe", name: "Stripe", secret: "sk_live", host: "api.stripe.com" });

  const mine = await k.listByOwner("alice@x.COM");
  assert.equal(mine.length, 1, "owner matching stays samePerson-compatible across email casing");
  assert.ok(mine.every((c) => !("secretEnc" in c)));

  const all = await k.listAllMetadata();
  assert.deepEqual(all.map((c) => c.ownerId).sort(), ["Alice@X.com", "U1"]);
  assert.ok(all.every((c) => !("secretEnc" in c)));

  const grouped = await k.listByOwners(["ALICE@x.com", "U1"]);
  assert.equal(grouped.get("ALICE@x.com")!.length, 1);
  assert.equal(grouped.get("U1")!.length, 1);

  const connectors = await k.listConnectorsByOwners(["U1"]);
  assert.equal(connectors.get("U1")!.length, 1);

  const services = await k.listServiceCredentials(org);
  assert.equal(services.length, 1);
  assert.equal(services[0]!.hasSecret, true, "hasSecret still sees the stored secret");

  const own = await k.materializeOwn("U1");
  assert.deepEqual(
    own.flatMap((m) => m.env),
    [{ key: "GITHUB_TOKEN", value: "ghp_secret" }],
  );
  await k.materializeOwnFiles("U1");

  assert.ok(!calls.includes("all"), `no listing path may scan the whole table (calls: ${calls.join(" ")})`);
  assert.ok(calls.includes("select:secretEnc:byOwner"));
  assert.ok(calls.includes("select:secretEnc:unfiltered"), "listAllMetadata projects the secret away");
});

test("envKey defaults from the service name (github → GITHUB_TOKEN)", async () => {
  const k = kc();
  const meta = await k.save({ ownerId: "U1", service: "GitHub", secret: "x" });
  assert.equal(meta.envKey, "GITHUB_TOKEN");
  assert.equal(meta.service, "github");
});

test("only the owner can grant; materialize is scope-checked; once-grants are consumed", async () => {
  const k = kc();
  const cred = await k.save(GH);

  await assert.rejects(
    k.createGrant({
      credentialId: cred.id,
      ownerId: "U2",
      audienceScopeId: "channel:C1",
      mode: "once",
      purpose: "go ahead",
    }),
    (e: KeychainError) => e.status === 403,
    "a non-owner actor must not be able to mint a grant",
  );

  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "use my gh to clone the repo",
  });

  await assert.rejects(
    materializeGrant(k, grant.id, "channel:OTHER", "U2"),
    (e: KeychainError) => e.status === 403,
    "grant is audience-bound",
  );

  const m = await materializeGrant(k, grant.id, "channel:C1", "U2");
  assert.equal(m.kind, "env");
  assert.ok(
    m.kind === "env" && m.env.length === 1 && m.env[0]!.value === "ghp_secret" && m.env[0]!.key === "GITHUB_TOKEN",
  );
  assert.equal(m.purpose, "use my gh to clone the repo");

  await assert.rejects(
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    (e: KeychainError) => e.status === 410,
    "a once-grant is single-use",
  );
});

test("concurrent materialization consumes a once grant exactly once", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "single use",
  });
  const results = await Promise.allSettled([
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    materializeGrant(k, grant.id, "channel:C1", "U3"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason instanceof KeychainError && result.reason.status === 410,
    ).length,
    2,
  );
});

test("legacy retry grants remain consumed and invalidate prepared uses", async () => {
  const grants = createMemoryMap<KeychainGrant>();
  const k = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap(),
    grants,
    asks: createMemoryMap(),
    key: KEY,
  });
  const credential = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: credential.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "one use",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  await grants.put(grant.id, { ...grant, status: "active", usedAt: Date.now(), usedBy: "U2" });
  assert.equal((await k.grantsForScope("channel:C1")).length, 0);
  for (const actor of ["U2", "U3"])
    await assert.rejects(materializeGrant(k, grant.id, "channel:C1", actor), (e: KeychainError) => e.status === 410);
  await assert.rejects(prepared.commit(), (e: KeychainError) => e.status === 410);
});

test("materializeOwnById: the owner's own credential needs no grant — scope, ownership, expiry, and connectors enforced", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const own = await k.materializeOwnById("U1", cred.id, "personal:U1");
  assert.ok(own.kind === "env" && own.env[0]!.value === "ghp_secret");
  assert.equal(own.grantId, undefined, "own use carries no grant");

  await assert.rejects(
    k.materializeOwnById("U1", cred.id, "channel:C1"),
    (e: KeychainError) => e.status === 403,
    "own use never crosses into a shared scope",
  );
  await assert.rejects(
    k.materializeOwnById("U2", cred.id, "personal:U2"),
    (e: KeychainError) => e.status === 404,
    "someone else's credential id reads as unknown",
  );

  const stale = await k.save({
    ownerId: "U1",
    service: "npm",
    secret: "npm_x",
    envKey: "NPM_TOKEN",
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(
    k.materializeOwnById("U1", stale.id, "personal:U1"),
    (e: KeychainError) => e.status === 410,
    "an expired credential does not materialize",
  );

  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "ya29.own",
    expiresAt: Date.now() + 3_600_000,
  });
  const cid = (await k.listConnectorsByOwners(["U1"])).get("U1")![0]!.credentialId;
  const conn = await k.materializeOwnById("U1", cid, "personal:U1");
  assert.ok(
    conn.kind === "env" && conn.env[0]!.key === envKey("gmail.googleapis.com") && conn.env[0]!.value === "ya29.own",
  );
});

test("a grant row pointing at a broker credential cannot materialize (defense in depth)", async () => {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const grants = createMemoryMap<import("../src/credentials/keychain.ts").KeychainGrant>();
  const k = createKeychain({ lock: createMemoryAdvisoryLock(), creds, grants, asks: createMemoryMap(), key: KEY });
  const ORG = scopeId("org", "default-org");
  await k.setServiceCredential(ORG, { slug: "serp", name: "SERP", secret: "s3", host: "api.serper.dev" });
  const broker = (await creds.all()).find((c) => c.kind === "broker")!;
  await grants.put("g-broker", {
    id: "g-broker",
    credentialId: broker.id,
    ownerId: ORG,
    audienceScopeId: scopeId("channel", "C1"),
    mode: "once",
    purpose: "x",
    status: "active",
    createdAt: Date.now(),
  });
  await assert.rejects(
    materializeGrant(k, "g-broker", scopeId("channel", "C1"), "U2"),
    (e: KeychainError) => e.status === 403,
  );
  await assert.rejects(
    k.materializeOwnById(ORG, broker.id, `personal:${ORG}`),
    (e: KeychainError) => e.status === 403,
    "own-use refuses broker records too",
  );
});

describe("connectors are grantable like any keychain record", () => {
  const GMAIL = "gmail.googleapis.com";
  const G1 = scopeId("group", "G1");
  type Rec = import("../src/credentials/keychain.ts").KeychainCredential;
  function kcWithRefresh(freshToken: string): Keychain {
    return createKeychain({
      lock: createMemoryAdvisoryLock(),
      creds: createMemoryMap<Rec>(),
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: KEY,
      refreshConnector: async () => ({ accessToken: freshToken, expiresAt: Date.now() + 3_600_000 }),
    });
  }
  const cidOf = async (k: Keychain, owner: string, host = GMAIL) =>
    (await k.listConnectorsByOwners([owner])).get(owner)!.find((c) => c.host === host)!.credentialId;

  it("listConnectorsByOwners returns metadata only (never the token), grouped by requested owner", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    await k.setConnectorToken("slack.com", "alex@x", { accessToken: "xoxp.alex" });
    await k.setConnectorToken(GMAIL, "carol@x", { accessToken: "ya29.carol", expiresAt: Date.now() + 3_600_000 });
    const map = await k.listConnectorsByOwners(["alex@x"]);
    assert.equal(map.has("carol@x"), false, "only the owners asked for");
    const alex = map.get("alex@x")!;
    assert.equal(alex.length, 2);
    assert.equal(alex.find((c) => c.host === GMAIL)!.connected, true);
    assert.equal(JSON.stringify(alex).includes("ya29"), false, "no access token in discovery metadata");
    assert.equal(
      (await k.listByOwners(["alex@x"])).get("alex@x"),
      undefined,
      "connectors stay out of the regular keychain listing",
    );
  });

  it("only the owner can grant a connector; materialize hands back the token under the host env var; once is consumed", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    const cid = await cidOf(k, "alex@x");
    await assert.rejects(
      k.createGrant({ credentialId: cid, ownerId: "carol@x", audienceScopeId: G1, mode: "once", purpose: "x" }),
      (e: KeychainError) => e.status === 403,
      "a non-owner cannot grant Alex's connector",
    );
    const grant = await k.createGrant({
      credentialId: cid,
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "once",
      purpose: "check my signature emails",
    });
    const m = await materializeGrant(k, grant.id, G1, "carol@x");
    assert.equal(m.kind, "env");
    assert.equal(envKey(GMAIL), "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM");
    assert.deepEqual(m.kind === "env" ? m.env : null, [
      { key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.alex" },
    ]);
    await assert.rejects(materializeGrant(k, grant.id, G1, "carol@x"), (e: KeychainError) => e.status === 410);
  });

  it("an expired connector token is refreshed on materialize; with no refresh it 410s for reconnect", async () => {
    const past = Date.now() - 10_000;
    const k = kcWithRefresh("ya29.fresh");
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.stale", refreshToken: "rt", expiresAt: past });
    const cid = await cidOf(k, "alex@x");
    const grant = await k.createGrant({
      credentialId: cid,
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    const m = await materializeGrant(k, grant.id, G1, "carol@x");
    assert.deepEqual(m.kind === "env" ? m.env : null, [
      { key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.fresh" },
    ]);

    const k2 = kc();
    await k2.setConnectorToken(GMAIL, "bob@x", { accessToken: "ya29.stale", expiresAt: past });
    assert.equal((await k2.listConnectorsByOwners(["bob@x"])).get("bob@x")![0]!.needsReconnect, true);
    const g2 = await k2.createGrant({
      credentialId: await cidOf(k2, "bob@x"),
      ownerId: "bob@x",
      audienceScopeId: G1,
      mode: "once",
      purpose: "p",
    });
    await assert.rejects(materializeGrant(k2, g2.id, G1, "carol@x"), (e: KeychainError) => e.status === 410);
  });

  it("a still-valid token within the refresh margin is refreshed; one with ample life is reused", async () => {
    const k = kcWithRefresh("ya29.fresh");
    await k.setConnectorToken(GMAIL, "alex@x", {
      accessToken: "ya29.aging",
      refreshToken: "rt",
      expiresAt: Date.now() + 5 * 60_000,
    });
    const g = await k.createGrant({
      credentialId: await cidOf(k, "alex@x"),
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    const m = await materializeGrant(k, g.id, G1, "member@example.com");
    assert.deepEqual(m.kind === "env" ? m.env : null, [
      { key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.fresh" },
    ]);

    const k2 = kcWithRefresh("ya29.fresh");
    await k2.setConnectorToken(GMAIL, "bob@x", {
      accessToken: "ya29.plenty",
      refreshToken: "rt",
      expiresAt: Date.now() + 30 * 60_000,
    });
    const g2 = await k2.createGrant({
      credentialId: await cidOf(k2, "bob@x"),
      ownerId: "bob@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    const m2 = await materializeGrant(k2, g2.id, G1, "member@example.com");
    assert.deepEqual(m2.kind === "env" ? m2.env : null, [
      { key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.plenty" },
    ]);
  });

  it("a standing connector grant auto-injects the host token; a once grant does not", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    await k.createGrant({
      credentialId: await cidOf(k, "alex@x"),
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "ongoing",
    });
    const injected = await k.materializeStanding(G1);
    assert.deepEqual(
      injected.map((m) => m.env),
      [[{ key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.alex" }]],
    );

    const k2 = kc();
    await k2.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    await k2.createGrant({
      credentialId: await cidOf(k2, "alex@x"),
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "once",
      purpose: "p",
    });
    assert.equal((await k2.materializeStanding(G1)).length, 0);
  });

  it("the manifest lists a participant's ungranted connected apps as requestable by credential id", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    const connectorsByOwner = await k.listConnectorsByOwners(["alex@x"]);
    const md = renderKeychainManifest({
      scopeId: G1,
      conversationKind: "group",
      actorId: "carol@x",
      members: [{ id: "alex@x", displayName: "Alex" }, { id: "carol@x" }],
      entriesByOwner: new Map(),
      connectorsByOwner,
      scopeGrants: [],
    });
    assert.match(
      md,
      /### Alex \(alex@x\)\n- Not granted here; ask with the `request-access` skill: gmail\.googleapis\.com connector `[a-f0-9]+`$/,
    );
  });
});

test("standing grants are reusable, revocable, and die with the credential", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "gh in this channel for qm PRs",
  });

  assert.equal((await k.materializeStanding("channel:C1")).length, 1);
  assert.equal((await k.materializeStanding("channel:C2")).length, 0);
  await materializeGrant(k, grant.id, "channel:C1", "U2");
  await materializeGrant(k, grant.id, "channel:C1", "U3");

  assert.equal(await k.revokeGrant("U2", grant.id), false, "only the owner can revoke");
  assert.equal(await k.revokeGrant("U1", grant.id), true);
  assert.equal((await k.materializeStanding("channel:C1")).length, 0);
  await assert.rejects(materializeGrant(k, grant.id, "channel:C1", "U2"), (e: KeychainError) => e.status === 410);

  const grant2 = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "again",
  });
  await k.remove("U1", cred.id);
  assert.equal(
    (await k.listGrants({ ownerId: "U1" })).find((g) => g.id === grant2.id)?.status,
    "revoked",
    "deleting a credential revokes its grants",
  );
});

test("grantConnectorToScope opens a connector to a channel, is idempotent, and no-ops with no connector", async () => {
  const k = kc();
  assert.equal(
    await k.grantConnectorToScope({
      host: "gmail.googleapis.com",
      principalId: "alex@x",
      audienceScopeId: "channel:C1",
      purpose: "shared link",
    }),
    null,
    "no connector → null",
  );

  await k.setConnectorToken("gmail.googleapis.com", "alex@x", {
    accessToken: "ya29.alex",
    expiresAt: Date.now() + 3_600_000,
  });
  const g1 = await k.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "alex@x",
    audienceScopeId: "channel:C1",
    purpose: "shared link",
  });
  assert.ok(g1 && g1.mode === "standing" && g1.ownerId === "alex@x");
  assert.equal((await k.materializeStanding("channel:C1")).length, 1, "the channel can now use Alex's gmail");

  const g2 = await k.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "alex@x",
    audienceScopeId: "channel:C1",
    purpose: "shared link",
  });
  assert.equal(g2?.id, g1.id, "re-connecting returns the existing grant, not a duplicate");
  assert.equal(
    (await k.listGrants({ ownerId: "alex@x" })).filter((g) => g.status === "active").length,
    1,
    "no duplicate grant rows",
  );
});

test("file bundles: one item per service, materialize to a /tmp script with env pointers, never the home volume", async () => {
  const k = kc();
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const cred = await k.save({
    ownerId: "U1",
    service: "aws",
    files: [
      { path: "~/.aws/config", contentBase64: b64("[default]\nregion=us-west-2\n") },
      { path: "./.aws/credentials", contentBase64: b64("[default]\naws_access_key_id=AKIA\n") },
    ],
  });
  assert.equal(cred.kind, "file");
  assert.deepEqual(cred.targets, [".aws/config", ".aws/credentials"]);
  assert.ok(!JSON.stringify(cred).includes("AKIA"), "metadata never carries file contents");

  const again = await k.save({
    ownerId: "U1",
    service: "aws",
    files: [{ path: "~/.aws/credentials", contentBase64: b64("rotated") }],
  });
  assert.equal(again.id, cred.id);
  assert.deepEqual(again.targets, [".aws/credentials"]);

  await assert.rejects(
    k.save({ ownerId: "U1", service: "evil", files: [{ path: "../../etc/passwd", contentBase64: b64("x") }] }),
    (e: KeychainError) => e.status === 400,
    "paths must be home-relative",
  );
  const unusual = await k.save({
    ownerId: "U1",
    service: "unusual",
    files: [{ path: "$(echo injected)", contentBase64: b64("x") }],
  });
  assert.deepEqual(unusual.targets, ["$(echo injected)"]);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "use my aws for the deploy",
  });
  const m = await materializeGrant(k, grant.id, "channel:C1", "U2");
  assert.equal(m.kind, "file");
});

test("file credentials point CLIs at their staged home", () => {
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  const env = fileCredentialEnvironment(
    [
      ".aws/config",
      ".aws/credentials",
      ".config/gh/hosts.yml",
      ".config/glab/config.yml",
      ".kube/config",
      ".docker/config.json",
      ".npmrc",
      ".netrc",
      ".ssh/id_ed25519",
    ].map((path) => ({ path, contentBase64: b64("x") })),
    "/tmp/staged",
  );
  assert.deepEqual(env, {
    HOME: "/tmp/staged",
    AWS_CONFIG_FILE: "/tmp/staged/.aws/config",
    AWS_SHARED_CREDENTIALS_FILE: "/tmp/staged/.aws/credentials",
    GH_CONFIG_DIR: "/tmp/staged/.config/gh",
    GLAB_CONFIG_DIR: "/tmp/staged/.config/glab",
    KUBECONFIG: "/tmp/staged/.kube/config",
    DOCKER_CONFIG: "/tmp/staged/.docker",
    NPM_CONFIG_USERCONFIG: "/tmp/staged/.npmrc",
    NETRC: "/tmp/staged/.netrc",
    GIT_SSH_COMMAND: "ssh -i '/tmp/staged/.ssh/id_ed25519' -o IdentitiesOnly=yes",
  });
});

test("standing file grants are not auto-injected, but remain re-fetchable by use", async () => {
  const k = kc();
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const cred = await k.save({
    ownerId: "U1",
    service: "glab",
    files: [
      { path: ".config/glab-cli/config.yml", contentBase64: b64("hosts:\n  gitlab.com:\n    token: glpat_standing\n") },
    ],
  });
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use my glab here",
  });

  assert.deepEqual(
    await k.materializeStanding("channel:C1"),
    [],
    "standing file grants are not injected into provision env",
  );
  const first = await materializeGrant(k, grant.id, "channel:C1", "U2");
  const second = await materializeGrant(k, grant.id, "channel:C1", "U2");
  assert.equal(first.kind, "file");
  assert.equal(second.kind, "file", "standing file grants stay reusable for explicit re-fetches");
});

test("materializeOwn round-trips the owner's env creds; expired creds are skipped", async () => {
  const k = kc();
  await k.save(GH);
  await k.save({ ownerId: "U1", service: "npm", secret: "npm_x", envKey: "NPM_TOKEN", expiresAt: Date.now() - 1 });
  const own = await k.materializeOwn("U1");
  assert.deepEqual(
    own.map((m) => m.env[0]!.key),
    ["GITHUB_TOKEN"],
    "expired creds never materialize",
  );
  assert.equal(own[0]!.env[0]!.value, "ghp_secret");
});

test("materializeOwn skips a row that doesn't decrypt under the current key instead of throwing", async () => {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const OTHER = deriveConnectorKey("a-different-master-key");
  const writer = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: OTHER,
  });
  await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
  });
  await reader.save(GH);

  const own = await reader.materializeOwn("U1");
  assert.deepEqual(
    own.map((m) => m.env[0]!.key),
    ["GITHUB_TOKEN"],
    "good row still materializes; undecryptable one is skipped",
  );
});

test("single-grant materialize surfaces a 422 (not a raw crypto 500) when the row doesn't decrypt", async () => {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const grants = createMemoryMap<import("../src/credentials/keychain.ts").KeychainGrant>();
  const OTHER = deriveConnectorKey("a-different-master-key");
  const writer = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds,
    grants,
    asks: createMemoryMap(),
    key: OTHER,
  });
  const cred = await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({ lock: createMemoryAdvisoryLock(), creds, grants, asks: createMemoryMap(), key: KEY });
  const grant = await reader.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use it",
  });
  await assert.rejects(
    materializeGrant(reader, grant.id, "channel:C1", "U2"),
    (e: KeychainError) => e.status === 422,
    "an undecryptable row yields a clean 422, not a crash",
  );
});

test("multi-input login: each field becomes its own env var, values never in metadata, materializes in order", async () => {
  const k = kc();
  const meta = await k.save({
    ownerId: "U1",
    service: "doordash",
    fields: [
      { envKey: "DOORDASH_EMAIL", value: "alice@acme.co", secret: false },
      { envKey: "DOORDASH_PASSWORD", value: "hunter2" },
    ],
  });
  assert.equal(meta.kind, "env");
  assert.deepEqual(meta.fields, [
    { envKey: "DOORDASH_EMAIL", secret: false },
    { envKey: "DOORDASH_PASSWORD", secret: true },
  ]);
  assert.ok(
    !JSON.stringify(meta).includes("hunter2") && !JSON.stringify(meta).includes("alice@acme.co"),
    "no field values in metadata",
  );

  const [own] = await k.materializeOwn("U1");
  assert.deepEqual(own!.env, [
    { key: "DOORDASH_EMAIL", value: "alice@acme.co", secret: false },
    { key: "DOORDASH_PASSWORD", value: "hunter2", secret: true },
  ]);
});

test("multi-input login: re-save upserts the same slot, and unique/non-empty fields are enforced", async () => {
  const k = kc();
  const f = [
    { envKey: "DB_USER", value: "admin", secret: false },
    { envKey: "DB_PASS", value: "pw" },
  ];
  const a = await k.save({ ownerId: "U1", service: "db", fields: f });
  const b = await k.save({
    ownerId: "U1",
    service: "db",
    fields: [
      { envKey: "DB_USER", value: "root", secret: false },
      { envKey: "DB_PASS", value: "pw2" },
    ],
  });
  assert.equal(a.id, b.id, "same owner+service+field-set is one record");
  const c = await k.save({
    ownerId: "U1",
    service: "db",
    fields: [
      { envKey: "DB_PASS", value: "pw3" },
      { envKey: "DB_USER", value: "root", secret: false },
    ],
  });
  assert.equal(c.id, a.id, "field order does not change the slot identity");
  assert.equal((await k.listByOwner("U1")).length, 1);

  await assert.rejects(
    k.save({
      ownerId: "U1",
      service: "x",
      fields: [
        { envKey: "A", value: "1" },
        { envKey: "A", value: "2" },
      ],
    }),
    (e: KeychainError) => e.status === 400,
    "duplicate envKeys rejected",
  );
  await assert.rejects(
    k.save({ ownerId: "U1", service: "x", fields: [{ envKey: "A", value: " " }] }),
    (e: KeychainError) => e.status === 400,
    "empty value rejected",
  );
  await assert.rejects(
    k.save({ ownerId: "U1", service: "x", fields: [{ envKey: "not a key", value: "1" }] }),
    (e: KeychainError) => e.status === 400,
    "non-env-var envKey rejected",
  );
  await assert.rejects(
    k.save({ ownerId: "U1", service: "x", secret: "s", envKey: "not a key" }),
    (e: KeychainError) => e.status === 400,
    "a bad single envKey is rejected too",
  );
  await assert.rejects(
    k.save({ ownerId: "U1", service: "x", secret: "s", envKey: "AGENT_API_URL" }),
    (e: KeychainError) => e.status === 400 && /AGENT_\*/.test(e.message),
    "a single envKey in the harness namespace is rejected",
  );
  await assert.rejects(
    k.save({ ownerId: "U1", service: "x", fields: [{ envKey: "AGENT_API_TOKEN", value: "t" }] }),
    (e: KeychainError) => e.status === 400 && /AGENT_\*/.test(e.message),
    "a field envKey in the harness namespace is rejected",
  );
});

test("back-compat: a legacy record carrying a plaintext username still materializes the paired env var", async () => {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const k = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
  });
  const meta = await k.save({
    ownerId: "U1",
    service: "acme-portal",
    secret: "hunter2",
    envKey: "ACME_PORTAL_PASSWORD",
  });
  await creds.merge(meta.id, { username: "alice@acme.co" } as never);
  const [own] = await k.materializeOwn("U1");
  assert.deepEqual(own!.env, [
    { key: "ACME_PORTAL_PASSWORD", value: "hunter2" },
    { key: "ACME_PORTAL_USERNAME", value: "alice@acme.co", secret: false },
  ]);
});

test("manifest: explains itself in a bare channel, lists credentials + protocol when present, flags standing grants", async () => {
  const empty = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U1",
    members: [{ id: "U1" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
  });
  assert.match(empty, /## Credentials/);
  assert.match(empty, /No credentials available/);
  assert.doesNotMatch(empty, /Teammate keychains/);
  assert.ok(!empty.includes("/v1/keychain/grants"), "no chat-driven approval route");

  const detected = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U2",
    members: [{ id: "U2" }, { id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    detectedByOwner: new Map([["U1", ["GitHub", "AWS SSO"]]]),
  });
  assert.match(detected, /NOT registered or grantable/);
  assert.match(detected, /### Alice \(U1\)/);
  assert.match(detected, /AWS SSO — detected/);

  const k = kc();
  const cred = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "gh for repo work here",
  });
  const block = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U2",
    members: [{ id: "U2" }, { id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [{ grant, credential: cred }],
    execution: [
      {
        credentialId: cred.id,
        ownerId: "U1",
        handle: credentialHandle(cred),
        description: "github",
      },
    ],
  });
  assert.match(block, /## Credentials/);
  assert.match(block, /### Alice \(U1\)/);
  assert.match(block, new RegExp(`github:${cred.id}`));
  assert.doesNotMatch(block, /STANDING|gh for repo work here|grant `/);
  assert.match(block, /`github:[a-f0-9]+` — github \(AliceBell\); env `GITHUB_TOKEN`/);
  assert.match(block, /Select handles in execute.credentials/);
  assert.ok(!block.includes("/v1/keychain/grants"));

  const login = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U2",
    members: [{ id: "U2" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    execution: [
      {
        credentialId: "c1",
        ownerId: "U1",
        handle: "doordash:c1",
        description: "provides `DOORDASH_EMAIL` + `DOORDASH_PASSWORD`",
      },
    ],
  });
  assert.match(login, /`DOORDASH_EMAIL` \+ `DOORDASH_PASSWORD`/);
  assert.ok(!block.includes("ghp_secret"), "the manifest is metadata-only");
});

test("manifest: own credentials need no grant but require explicit execution requests", async () => {
  const k = kc();
  await k.save(GH);
  await k.save({ ownerId: "U1", service: "npm", secret: "npm_x", envKey: "NPM_TOKEN", expiresAt: Date.now() - 1 });
  await k.save({
    ownerId: "U1",
    service: "file-login",
    files: [{ path: ".qa/token", contentBase64: Buffer.from("file-secret").toString("base64") }],
  });
  const entries = await k.listByOwner("U1");
  const own = renderKeychainManifest({
    scopeId: "personal:U1",
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", entries]]),
    scopeGrants: [],
    execution: entries.map((c) => ({
      credentialId: c.id,
      ownerId: "U1",
      handle: credentialHandle(c),
      description: "",
    })),
  });
  assert.match(own, /### Alice \(U1\)\n/);
  assert.match(own, /`file-login:[a-f0-9]+` — file-login; files in \$HOME/);
  assert.match(own, /`npm:[a-f0-9]+` — npm; expired$/m);
  assert.doesNotMatch(own, /request-access|grant/);
  assert.equal(
    renderKeychainManifest({
      scopeId: "personal:U1",
      conversationKind: "dm",
      actorId: "U1",
      scopeGrants: [],
      members: [{ id: "U1" }],
      entriesByOwner: new Map([["U1", entries]]),
    }),
    renderKeychainManifest({
      scopeId: "personal:U1",
      conversationKind: "dm",
      actorId: "U1",
      scopeGrants: [],
      members: [{ id: "U1" }],
      entriesByOwner: new Map(),
    }),
    "own credentials without an execution handle are not listed",
  );

  const other = renderKeychainManifest({
    scopeId: "personal:U2",
    conversationKind: "dm",
    actorId: "U2",
    members: [{ id: "U2" }, { id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
  });
  assert.match(other, /Not granted here; ask with the `request-access` skill: .*npm \(expired\) `[a-f0-9]+`/);

  const channel = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U1",
    members: [{ id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
  });
  assert.match(channel, /Not granted here; ask with the `request-access` skill/);
});

const SECRET = "keychain-route-secret".repeat(3);

describe("/v1/keychain routes (capability-authed)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = async (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    await mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra }, SECRET);

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "kc-routes-")), signingSecret: SECRET }));
    await built.directory.replaceChannels(
      [
        { channelId: "C_SECONDS", name: "seconds", isPrivate: false },
        { channelId: "C_BAD_EXP", name: "bad-exp", isPrivate: false },
        { channelId: "C7", name: "grants", isPrivate: false },
        { channelId: "C_OVERVIEW", name: "overview", isPrivate: false },
        { channelId: "C_NAMED", name: "pilot-portal", isPrivate: false },
        { channelId: "C_MYSTERY", name: "", isPrivate: false },
        { channelId: "C8", name: "file-grants", isPrivate: false },
      ],
      [
        { channelId: "C_SECONDS", principalId: "U_SECONDS" },
        { channelId: "C_BAD_EXP", principalId: "U_BAD_EXP" },
        { channelId: "C7", principalId: "OWNER" },
        { channelId: "C7", principalId: "U3" },
        { channelId: "C_OVERVIEW", principalId: "OVERVIEW_OWNER" },
        { channelId: "C_NAMED", principalId: "SCOPENAME_OWNER" },
        { channelId: "C_MYSTERY", principalId: "SCOPENAME_OWNER" },
        { channelId: "C8", principalId: "OWNER" },
        { channelId: "C8", principalId: "U3" },
      ],
    );
    await built.directory.replaceGroups([
      { groupId: "G_CONN", principalId: "alex@conn" },
      { groupId: "G_CONN", principalId: "carol@conn" },
    ]);
    server = createServer(built.app, {
      signingSecret: SECRET,
      keychain: built.keychain,
      workspace: built.workspace,
      auditLog: built.auditLog,
      credentialUsage: built.credentialUsage,
      sessions: built.sessions,
      runs: built.runs,
      signals: built.signals,
      identity: built.identity,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown, cap: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify(body),
    });
  const get = (path: string, cap: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });
  const grantHere = (
    credentialId: string,
    ownerId: string,
    audienceScopeId: CapabilityClaims["scopeId"],
    mode: "once" | "standing",
    purpose: string,
  ) => built.keychain!.createGrant({ credentialId, ownerId, audienceScopeId, mode, purpose });

  it("saves to the TOKEN's actor and lists only the caller's own credentials", async () => {
    const res = await post(
      "/v1/keychain/credentials",
      { service: "github", secret: "ghp_u1", envKey: "GITHUB_TOKEN", accountLabel: "AliceBell" },
      await capFor("U1"),
    );
    assert.equal(res.status, 200);
    const { credential } = (await res.json()) as any;
    assert.equal(credential.ownerId, "U1");
    assert.equal(credential.credentialHandle, credentialHandle(credential));
    assert.ok(!JSON.stringify(credential).includes("ghp_u1"));

    const mine = (await (await get("/v1/keychain/credentials", await capFor("U1"))).json()) as any;
    assert.equal(mine.credentials.length, 1);
    assert.equal(mine.credentials[0].credentialHandle, credential.credentialHandle);
    assert.ok(!JSON.stringify(mine).includes("ghp_u1"));
    const other = (await (await get("/v1/keychain/credentials", await capFor("U2"))).json()) as any;
    assert.deepEqual(other.credentials, []);
  });

  it("env grants expose the credential's execution handle; committing a once grant consumes it", async () => {
    const owner = "HANDLE_OWNER";
    const cap = await capFor(owner, scopeId("personal", owner), { liveActor: true });
    const saved = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "handle-test", envKey: "HANDLE_TOKEN", secret: "synthetic-handle-secret" },
        cap,
      )
    ).json()) as any;
    const metadata = (await (await get("/v1/keychain/credentials", cap)).json()) as any;
    assert.equal(saved.credential.credentialHandle, metadata.credentials[0].credentialHandle);
    assert.ok(!JSON.stringify([saved, metadata]).includes("synthetic-handle-secret"));
    const grant = await grantHere(saved.credential.id, owner, scopeId("personal", owner), "once", "use the handle");
    const current = (await built.keychain!.grantsForScope(scopeId("personal", owner))).find(
      ({ grant: g }) => g.id === grant.id,
    );
    assert.equal(current?.credential.credentialHandle, saved.credential.credentialHandle);
    const prepared = await built.keychain!.prepareMaterialize(grant.id, scopeId("personal", owner), owner);
    assert.equal(prepared.materialized.kind, "env");
    await prepared.commit();
    const claimed = (await built.keychain!.getGrant(grant.id))!;
    assert.equal(claimed.status, "used");
    assert.ok(claimed.usedAt !== undefined);
    await assert.rejects(prepared.commit(), (e: KeychainError) => e.status === 410);
  });

  it("a participant's granted connector is materialized under the host env var", async () => {
    const GROUP = scopeId("group", "G_CONN");
    await built.keychain!.setConnectorToken("gmail.googleapis.com", "alex@conn", {
      accessToken: "ya29.alex",
      expiresAt: Date.now() + 3_600_000,
    });
    const cid = (await built.keychain!.listConnectorsByOwners(["alex@conn"])).get("alex@conn")![0]!.credentialId;

    const grant = await grantHere(cid, "alex@conn", GROUP, "once", "check my signature emails");
    assert.equal((await built.keychain!.getGrant(grant.id))?.status, "active");
    const prepared = await built.keychain!.prepareMaterialize(grant.id, GROUP, "carol@conn");
    assert.equal(prepared.materialized.kind, "env");
    if (prepared.materialized.kind === "env") assert.equal(prepared.materialized.env[0]?.value, "ya29.alex");
  });

  it("normalizes keychain credential expiry seconds to milliseconds before storing", async () => {
    const expiresAt = Math.floor((Date.now() + 3_600_000) / 1000);
    const res = await post(
      "/v1/keychain/credentials",
      { service: "npm-seconds", secret: "npm_seconds", envKey: "NPM_SECONDS", expiresAt },
      await capFor("U_SECONDS"),
    );
    assert.equal(res.status, 200);
    const { credential } = (await res.json()) as any;
    assert.equal(credential.expiresAt, expiresAt * 1000);

    const grant = await grantHere(credential.id, "U_SECONDS", "channel:C_SECONDS", "once", "seconds check");
    await built.keychain!.prepareMaterialize(grant.id, "channel:C_SECONDS", "U_SECONDS");
  });

  it("rejects invalid keychain credential expiry at the route boundary", async () => {
    const badCred = await post(
      "/v1/keychain/credentials",
      { service: "bad-exp", secret: "x", expiresAt: "not-a-date" },
      await capFor("U_BAD_EXP"),
    );
    assert.equal(badCred.status, 400);
  });

  it("saves a multi-field login via fields[], and rejects a malformed fields[] rather than storing a partial one", async () => {
    const ok = await post(
      "/v1/keychain/credentials",
      {
        service: "doordash",
        fields: [
          { envKey: "DOORDASH_EMAIL", value: "r@acme.co", secret: false },
          { envKey: "DOORDASH_PASSWORD", value: "pw" },
        ],
      },
      await capFor("U_FIELDS"),
    );
    assert.equal(ok.status, 200);
    const { credential } = (await ok.json()) as any;
    assert.deepEqual(credential.fields, [
      { envKey: "DOORDASH_EMAIL", secret: false },
      { envKey: "DOORDASH_PASSWORD", secret: true },
    ]);

    const bad = await post(
      "/v1/keychain/credentials",
      { service: "x", fields: [{ envKey: "OK", value: "v" }, { envKey: "NOPE" }] },
      await capFor("U_FIELDS"),
    );
    assert.equal(bad.status, 400, "a malformed field rejects the whole request");
  });

  it("rejects keychain calls without a capability token (no source-auth fallback identity)", async () => {
    const res = await fetch(`${base}/v1/keychain/credentials`, { method: "GET" });
    assert.notEqual(res.status, 200);
  });

  it("one-time grants materialize only in their scope, once", async () => {
    const credential = await built.keychain!.save({
      ownerId: "OWNER",
      service: "github",
      secret: "ghp_grant",
      envKey: "GH_GRANT",
    });
    const grant = await grantHere(credential.id, "OWNER", "channel:C7", "once", "clone the repo");
    await assert.rejects(
      built.keychain!.prepareMaterialize(grant.id, "channel:OTHER", "U3"),
      (e: KeychainError) => e.status === 403,
    );
    const prepared = await built.keychain!.prepareMaterialize(grant.id, "channel:C7", "U3");
    await prepared.commit();
    await assert.rejects(
      built.keychain!.prepareMaterialize(grant.id, "channel:C7", "U3"),
      (e: KeychainError) => e.status === 410,
    );
  });

  it("overview returns metadata and grants without querying usage history or exposing secrets", async (t) => {
    const owner = "OVERVIEW_OWNER";
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "overview", secret: "never-return-this", envKey: "OVERVIEW_TOKEN" },
        await capFor(owner),
      )
    ).json()) as any;
    await grantHere(credential.id, owner, "channel:C_OVERVIEW", "standing", "deploy the reporting app");

    const usage = t.mock.method(built.credentialUsage, "list", async () => {
      throw new Error("usage history is unavailable");
    });

    const overview = await get("/v1/keychain/overview", await capFor(owner));
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as any;
    assert.equal(body.credentials[0].id, credential.id);
    assert.equal(body.grants[0].purpose, "deploy the reporting app");
    assert.equal(usage.mock.callCount(), 0);
    assert.ok(!Object.hasOwn(body, "usage"));
    assert.ok(!JSON.stringify(body).includes("never-return-this"));
  });

  it("overview resolves grant scope ids to human-readable names when known", async () => {
    const owner = "SCOPENAME_OWNER";
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "scopenames", secret: "shh", envKey: "SCOPENAME_TOKEN" },
        await capFor(owner),
      )
    ).json()) as any;
    await built.sessions.getOrCreateByThread("slack:C_NAMED:1", "channel", "channel:C_NAMED", "pilot-portal");
    await grantHere(credential.id, owner, "channel:C_NAMED", "standing", "named channel work");
    await grantHere(credential.id, owner, "channel:C_MYSTERY", "standing", "unnamed channel work");
    const body = (await (await get("/v1/keychain/overview", await capFor(owner))).json()) as any;
    assert.equal(body.scopeNames["channel:C_NAMED"], "#pilot-portal");
    assert.equal(body.scopeNames["channel:C_MYSTERY"], undefined);
  });

  it("overview includes safe connector metadata so its grants remain visible and revocable", async () => {
    const owner = "CONNECTOR_OVERVIEW_OWNER";
    await built.keychain!.setConnectorToken("gmail.googleapis.com", owner, {
      accessToken: "never-return-this-connector",
    });
    const connector = (await built.keychain!.listConnectorsByOwners([owner])).get(owner)![0]!;
    const grant = await built.keychain!.grantConnectorToScope({
      host: connector.host,
      principalId: owner,
      audienceScopeId: "channel:C_CONNECTOR_OVERVIEW",
      purpose: "read mail here",
    });

    const overview = await get("/v1/keychain/overview", await capFor(owner));
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as any;
    assert.equal(body.connectorCredentials[0].credentialId, connector.credentialId);
    assert.equal(body.grants.find((entry: any) => entry.id === grant!.id)?.status, "active");
    assert.ok(!JSON.stringify(body).includes("never-return-this-connector"));
  });
});

function channelTurn(
  text: string,
  actorId: string,
  audience: Array<{ externalId: string; displayName?: string }>,
): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: actorId },
    conversation: { kind: "channel", threadRef: "ch:C1", channelRef: "C1", audience },
    text,
  } as TurnRequest;
}

function execScriptsMention(needle: string, since = 0): boolean {
  return fakeSprites
    .execScripts()
    .slice(since)
    .some((script) => script.includes(needle));
}

test("turn e2e: prompt lists exact handles and keychain env credentials are never ambient", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "kc-e2e-")),
      signingSecret: SECRET,
      apiBaseUrl: "http://core.test",
    }),
  );
  assert.ok(built.keychain, "buildApp with a signing secret wires the keychain");
  built.keychain.materializeOwn = async () => {
    throw new Error("eager owner materialization is forbidden");
  };
  built.keychain.materializeStanding = async () => {
    throw new Error("eager standing materialization is forbidden");
  };
  const resolved: string[] = [];
  const materializeOwnById = built.keychain.materializeOwnById.bind(built.keychain);
  built.keychain.materializeOwnById = async (...args) => {
    resolved.push(args[1]);
    return materializeOwnById(...args);
  };
  const cred = await built.keychain!.save({
    ownerId: "U_OWNER",
    service: "github",
    secret: "ghp_e2e",
    envKey: "GITHUB_TOKEN",
    accountLabel: "AliceBell",
  });

  const audience = [{ externalId: "U_ASKER" }, { externalId: "U_OWNER", displayName: "Alice" }];
  const sys = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.equal(sys.status, "ok");
  assert.match(sys.reply ?? "", /## Credentials/);
  assert.match(
    sys.reply ?? "",
    /### Alice \(U_OWNER\)\n- Not granted here; ask with the `request-access` skill: github \(AliceBell\) `/,
  );
  assert.ok(!(sys.reply ?? "").includes("ghp_e2e"), "prompt never carries the secret");
  await selectDefaultSandbox(built, "U_ASKER", "channel:C1");

  let mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(channelTurn("!run true", "U_ASKER", audience))).status, "ok");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "no grant → no secret in the channel sandbox");

  await built.keychain!.createGrant({
    credentialId: cred.id,
    ownerId: "U_OWNER",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use my gh here for repo work",
  });
  const sys2 = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.match(sys2.reply ?? "", new RegExp(`\`github:${cred.id}\` — github \\(AliceBell\\); env \`GITHUB_TOKEN\``));
  assert.doesNotMatch(sys2.reply ?? "", /use my gh here for repo work|Not granted here/);

  mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(channelTurn("!run true", "U_ASKER", audience))).status, "ok");
  assert.ok(!execScriptsMention("export GITHUB_TOKEN=", mark), "standing grants are not ambient");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "an unrequested command never receives the secret");
  const unchanged = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  const system = (reply?: string) => (reply ?? "").split("<environment>")[0];
  assert.equal(system(unchanged.reply), system(sys2.reply));

  await selectDefaultSandbox(built, "U_OWNER", "personal:U_OWNER");
  mark = fakeSprites.execScripts().length;
  const dm: TurnRequest = {
    surface: "test",
    actor: { externalId: "U_OWNER" },
    conversation: { kind: "dm", threadRef: "dm:U_OWNER", audience: [{ externalId: "U_OWNER" }] },
    origin: { kind: "human" },
    text: "!run true",
  } as TurnRequest;
  assert.equal((await built.app.turn(dm)).status, "ok");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "unrequested secrets are never materialized");
  const selected = await built.app.turn({
    ...dm,
    text: `!execute ${JSON.stringify({ command: 'test "$GITHUB_TOKEN" = ghp_e2e && echo selected', credentials: [credentialHandle(cred)] })}`,
  });
  assert.equal(selected.reply, "selected");
  assert.deepEqual(resolved, [cred.id]);
});

test("prepared grants reject credential rotation without consuming a single use", async () => {
  const k = kc();
  const credential = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: credential.id,
    ownerId: GH.ownerId,
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "rotation regression",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  await k.save({ ...GH, secret: "rotated-execution-token" });
  await assert.rejects(prepared.commit(), /credential changed/);
  assert.equal((await k.getGrant(grant.id))?.status, "active");
  const fresh = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  assert.equal(fresh.materialized.kind, "env");
  if (fresh.materialized.kind === "env") assert.equal(fresh.materialized.env[0]?.value, "rotated-execution-token");
  await fresh.commit();
  const committed = (await k.getGrant(grant.id))!;
  assert.equal(committed.status, "used");
  assert.equal(committed.usedBy, "U2", "only the committed materialization claims the once grant");
});

test("connector refresh during preparation binds the refreshed version and later rotation invalidates it", async () => {
  let refreshes = 0;
  const k = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
    refreshConnector: async () => {
      refreshes++;
      return { accessToken: "refreshed-token", expiresAt: Date.now() + 3600000 };
    },
  });
  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "expired-token",
    refreshToken: "refresh",
    expiresAt: Date.now() - 1000,
  });
  const connector = (await k.listConnectorsByOwners(["U1"])).get("U1")![0]!;
  const grant = await k.createGrant({
    credentialId: connector.credentialId,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "refresh regression",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  assert.equal(refreshes, 1);
  await prepared.commit();
  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "replacement-token",
    expiresAt: Date.now() + 3600000,
  });
  await assert.rejects(prepared.commit(), /credential changed/);
  await (await k.prepareMaterialize(grant.id, "channel:C1", "U2")).commit();
});

test("Composio keys remain backend-only across all materialization paths including multi-field records", async () => {
  for (const input of [
    { secret: "project-key", envKey: "COMPOSIO_API_KEY" },
    {
      fields: [
        { envKey: "COMPOSIO_API_KEY", value: "project-key" },
        { envKey: "OTHER", value: "other" },
      ],
    },
  ]) {
    const k = kc();
    const c = await k.save({ ownerId: "U1", service: "composio", ...input });
    assert.equal(c.credentialHandle, undefined);
    assert.equal((await k.getCredential(c.id))?.credentialHandle, undefined);
    const grant = await k.createGrant({
      credentialId: c.id,
      ownerId: "U1",
      audienceScopeId: "channel:C1",
      mode: "standing",
      purpose: "apps",
    });
    assert.deepEqual(await k.materializeOwn("U1"), []);
    assert.deepEqual(await k.materializeStanding("channel:C1"), []);
    await assert.rejects(k.materializeOwnById("U1", c.id, "personal:U1"), /keys stay in the backend/);
    await assert.rejects(materializeGrant(k, grant.id, "channel:C1", "U1"), /keys stay in the backend/);
    assert.equal(await k.composioKey("U1", c.id), "project-key");
    assert.equal(await k.composioKey("U2", c.id), null);
  }
});

test("manifest timestamps stay stable until credentials and pending asks actually expire", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const k = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
    now: () => now,
  });
  const expiresAt = now + 50 * 3_600_000;
  const credential = await k.save({ ...GH, expiresAt });
  const { ask } = await k.createAsk({
    credentialId: credential.id,
    requesterId: "U2",
    requesterScopeId: "channel:C1",
    purpose: "test access",
  });
  const manifest = async () =>
    renderKeychainManifest(
      {
        scopeId: "personal:U1",
        conversationKind: "dm",
        actorId: "U1",
        members: [{ id: "U1" }],
        entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
        scopeGrants: [],
        execution: [
          { credentialId: credential.id, ownerId: "U1", handle: credentialHandle(credential), description: "" },
        ],
      },
      now,
    );
  const ledger = async () => renderAskLedger(await k.listAsks({ requesterScopeId: "channel:C1" }), now);
  const first = await manifest();
  const pendingLedger = await ledger();
  for (const advance of [61_000, 3 * 3_600_000]) {
    now += advance;
    assert.equal(await manifest(), first);
    assert.equal(await ledger(), pendingLedger);
  }
  assert.doesNotMatch(first, /expires at|\d{4}-\d{2}-\d{2}T|approval card/);
  assert.match(pendingLedger, /waiting on U1's approval card/);
  now = ask.expiresAt;
  assert.equal(await ledger(), pendingLedger);
  now++;
  const expiredAsk = await ledger();
  assert.match(expiredAsk, /request to U1: expired/);
  assert.doesNotMatch(expiredAsk, /waiting on U1's approval card/);
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U1", mode: "once", purpose: "test access" }),
    (e: KeychainError) => e.status === 410,
  );
  now = expiresAt;
  assert.doesNotMatch(await manifest(), /; expired/);
  await k.materializeOwnById("U1", credential.id, "personal:U1");
  now++;
  assert.match(await manifest(), /; expired/);
  await assert.rejects(
    k.materializeOwnById("U1", credential.id, "personal:U1"),
    (e: KeychainError) => e.status === 410,
  );
});

test("manifest inventories are canonical across discovery order without mutating inputs", async () => {
  const k = kc();
  for (const ownerId of ["U2", "U1"]) {
    await k.save({ ...GH, ownerId });
    await k.save({
      ownerId,
      service: "files",
      files: [
        { path: ".config/z", contentBase64: "eg==" },
        { path: ".config/a", contentBase64: "YQ==" },
      ],
    });
    await k.save({
      ownerId,
      service: "custom",
      fields: [
        { envKey: "Z_KEY", value: "z" },
        { envKey: "A_KEY", value: "a" },
      ],
    });
    await k.setConnectorToken("github.com", ownerId, { accessToken: "token" });
    await k.setConnectorToken("gmail.googleapis.com", ownerId, { accessToken: "token" });
  }
  for (const credential of await k.listByOwner("U1")) {
    await k.createAsk({
      credentialId: credential.id,
      requesterId: "U2",
      requesterScopeId: "channel:C1",
      purpose: "access",
    });
  }
  const input: Parameters<typeof renderKeychainManifest>[0] = {
    scopeId: "personal:U1",
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U2" }, { id: "U1" }],
    entriesByOwner: await k.listByOwners(["U2", "U1"]),
    connectorsByOwner: await k.listConnectorsByOwners(["U2", "U1"]),
    scopeGrants: [],
    execution: ["z", "a"].map((id) => ({
      credentialId: id,
      ownerId: "U1",
      handle: `${id}:${id}`,
      description: id,
      scope: "scoped",
    })),
    detectedByOwner: new Map([
      ["U1", ["zsh", "aws"]],
      ["U2", ["gcloud", "aws"]],
    ]),
  };
  const before = structuredClone(input);
  const first = renderKeychainManifest(input, 1000);
  const reversed = structuredClone(input);
  reversed.members.reverse();
  reversed.execution!.reverse();
  for (const entries of reversed.entriesByOwner.values()) {
    entries.reverse();
    for (const entry of entries) {
      entry.fields?.reverse();
      entry.targets?.reverse();
    }
  }
  for (const entries of reversed.connectorsByOwner!.values()) entries.reverse();
  for (const entries of reversed.detectedByOwner!.values()) entries.reverse();
  assert.equal(renderKeychainManifest(reversed, 1000), first);
  assert.deepEqual(input, before);
  reversed.connectorsByOwner!.get("U1")![0]!.needsReconnect = true;
  assert.notEqual(renderKeychainManifest(reversed, 1000), first);
});

test("manifest merges credential representations without conflating login identities or execution scopes", async () => {
  const k = kc();
  const ownerId = "ALICE@example.com";
  await k.setConnectorToken("gmail.googleapis.com", ownerId, { accessToken: "private-token", expiresAt: 5000 });
  const connector = (await k.listConnectorsByOwners([ownerId])).get(ownerId)![0]!;
  const credential = (await k.getCredential(connector.credentialId))!;
  const grant = await k.createGrant({
    ownerId,
    credentialId: credential.id,
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "mail",
  });
  const first = await k.save({
    ownerId,
    service: "aws",
    envKey: "AWS_TOKEN",
    secret: "first-secret",
    accountLabel: "work",
    expiresAt: 900,
  });
  const second = await k.save({
    ownerId,
    service: "aws",
    envKey: "OTHER_AWS_TOKEN",
    secret: "second-secret",
    accountLabel: "personal",
    expiresAt: 5000,
  });
  const input: Parameters<typeof renderKeychainManifest>[0] = {
    scopeId: "channel:C1",
    conversationKind: "channel",
    openSpeakerKeychain: true,
    actorId: "alice@example.com",
    members: [{ id: "alice@example.com", displayName: "Alice" }],
    entriesByOwner: new Map([["alice@example.com", [first, second]]]),
    connectorsByOwner: new Map([["alice@example.com", [{ ...connector, needsReconnect: true }]]]),
    scopeGrants: [{ grant, credential }],
    execution: [
      {
        handle: credentialHandle(credential),
        ownerId,
        credentialId: credential.id,
        description: "mail grant",
      },
      {
        handle: "connector:gmail.googleapis.com:default",
        ownerId,
        credentialId: credential.id,
        description: "own mail",
      },
      ...[first, second].map((c) => ({
        handle: credentialHandle(c),
        ownerId,
        credentialId: c.id,
        description: "aws",
      })),
    ],
  };
  const rendered = renderKeychainManifest(input, 1000);
  assert.equal(rendered.split("### ").length - 1, 1);
  assert.equal(rendered.split("gmail.googleapis.com connector").length - 1, 1);
  assert.match(
    rendered,
    /`connector:gmail\.googleapis\.com:default`, `[^`]+` — gmail\.googleapis\.com connector; expired/,
  );
  assert.match(rendered, /aws \(work\); expired/);
  assert.match(rendered, /aws \(personal\); env `OTHER_AWS_TOKEN`/);
  assert.doesNotMatch(rendered, /expires at|\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(credentialHandle(first), credentialHandle(second));
  for (const secret of ["private-token", "first-secret", "second-secret"]) assert.ok(!rendered.includes(secret));
  input.execution!.reverse();
  assert.equal(renderKeychainManifest(input, 1000), rendered);
});

test("granted connector keeps account and refresh semantics when owner is absent from roster", async () => {
  const k = kc(() => 1000);
  await k.setConnectorToken("gmail.googleapis.com", "U_OWNER", {
    accessToken: "old-token",
    refreshToken: "refresh-token",
    expiresAt: 900,
    accountType: "company",
  });
  const connector = (await k.listConnectorsByOwners(["U_OWNER"])).get("U_OWNER")![0]!;
  const credential = (await k.getCredential(connector.credentialId))!;
  const grant = await k.createGrant({
    ownerId: "U_OWNER",
    credentialId: credential.id,
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "mail",
  });
  const rendered = renderKeychainManifest(
    {
      scopeId: "channel:C1",
      conversationKind: "channel",
      actorId: "U_ACTOR",
      members: [{ id: "U_ACTOR" }],
      entriesByOwner: new Map(),
      scopeGrants: [{ grant, credential }],
      execution: [
        { handle: credentialHandle(credential), ownerId: "U_OWNER", credentialId: credential.id, description: "" },
      ],
    },
    1000,
  );
  assert.match(
    rendered,
    /### U_OWNER\n- `[^`]+` — gmail\.googleapis\.com connector \(company\); env `VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM`$/,
  );
  assert.doesNotMatch(rendered, /expired|Not granted|refresh-token|old-token/);
});
