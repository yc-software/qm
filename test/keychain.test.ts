import "./support/auto-fake-sprites.ts";

import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import {
  createKeychain,
  renderKeychainManifest,
  renderUseScript,
  KeychainError,
  type Keychain,
} from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { envKey } from "../src/credentials/connector-token.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";

const KEY = deriveConnectorKey("keychain-test-key");

function kc(): Keychain {
  return createKeychain({ creds: createMemoryMap(), grants: createMemoryMap(), asks: createMemoryMap(), key: KEY });
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
    k.materialize(grant.id, "channel:OTHER", "U2"),
    (e: KeychainError) => e.status === 403,
    "grant is audience-bound",
  );

  const m = await k.materialize(grant.id, "channel:C1", "U2");
  assert.equal(m.kind, "env");
  assert.ok(
    m.kind === "env" && m.env.length === 1 && m.env[0]!.value === "ghp_secret" && m.env[0]!.key === "GITHUB_TOKEN",
  );
  assert.equal(m.purpose, "use my gh to clone the repo");

  await assert.rejects(
    k.materialize(grant.id, "channel:C1", "U2"),
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
    k.materialize(grant.id, "channel:C1", "U2"),
    k.materialize(grant.id, "channel:C1", "U3"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason instanceof KeychainError && result.reason.status === 410,
    ).length,
    1,
  );
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
  const k = createKeychain({ creds, grants, asks: createMemoryMap(), key: KEY });
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
    k.materialize("g-broker", scopeId("channel", "C1"), "U2"),
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
    const m = await k.materialize(grant.id, G1, "carol@x");
    assert.equal(m.kind, "env");
    assert.equal(envKey(GMAIL), "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM");
    assert.deepEqual(m.kind === "env" ? m.env : null, [
      { key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.alex" },
    ]);
    assert.match(renderUseScript(m), /export VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM=/);
    await assert.rejects(
      k.materialize(grant.id, G1, "carol@x"),
      (e: KeychainError) => e.status === 410,
      "once-grant single-use",
    );
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
    const m = await k.materialize(grant.id, G1, "carol@x");
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
    await assert.rejects(k2.materialize(g2.id, G1, "carol@x"), (e: KeychainError) => e.status === 410);
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
    const m = await k.materialize(g.id, G1, "member@example.com");
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
    const m2 = await k2.materialize(g2.id, G1, "member@example.com");
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

  it("the manifest lists a participant's connected apps with credential id and grant status", async () => {
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
      injected: [],
    });
    assert.match(md, /connected app gmail\.googleapis\.com/);
    assert.match(md, /credential id/);
    assert.match(md, /no grant for this conversation/);
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
  await k.materialize(grant.id, "channel:C1", "U2");
  await k.materialize(grant.id, "channel:C1", "U3");

  assert.equal(await k.revokeGrant("U2", grant.id), false, "only the owner can revoke");
  assert.equal(await k.revokeGrant("U1", grant.id), true);
  assert.equal((await k.materializeStanding("channel:C1")).length, 0);
  await assert.rejects(k.materialize(grant.id, "channel:C1", "U2"), (e: KeychainError) => e.status === 410);

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
  const unusualScript = renderUseScript({
    kind: "file",
    credentialId: "legacy-unusual",
    ownerId: "U1",
    service: "unusual",
    files: [{ path: "$(echo injected)", contentBase64: b64("x") }],
  });
  const renderedPath = execFileSync("sh", ["-c", `${unusualScript}\nfind "$HOME" -maxdepth 1 -type f -print`], {
    encoding: "utf8",
  });
  assert.match(renderedPath, /\/\$\(echo injected\)$/m);
  const pointerScript = renderUseScript({
    kind: "file",
    credentialId: "legacy-pointer",
    ownerId: "U1",
    service: "unusual-pointer",
    files: [{ path: "$(echo injected)/.aws/config", contentBase64: b64("x") }],
  });
  const pointerPath = execFileSync(
    "sh",
    ["-c", `${pointerScript}\nprintf '%s\\n' "$AWS_CONFIG_FILE"\nfind "$__kc_dir" -type f -print`],
    { encoding: "utf8" },
  );
  assert.match(pointerPath, /\/\$\(echo injected\)\/\.aws\/config$/m);

  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "use my aws for the deploy",
  });
  const m = await k.materialize(grant.id, "channel:C1", "U2");
  assert.equal(m.kind, "file");
  const script = renderUseScript(m);
  assert.match(script, /mktemp -d/);
  assert.match(script, /chmod 600/);
  assert.match(script, /export AWS_SHARED_CREDENTIALS_FILE="\$__kc_dir\/.aws\/credentials"/);
  assert.ok(
    !script.includes("/root/") && !script.includes("$HOME"),
    "files land on ephemeral /tmp, not the durable home",
  );
});

test("file bundle materialization exports the env pointers CLIs honor from ephemeral /tmp paths", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const script = renderUseScript({
    kind: "file",
    credentialId: "cred-cli",
    ownerId: "U1",
    service: "cli-bundle",
    files: [
      { path: ".aws/config", contentBase64: b64("[default]\nregion=us-west-2\n") },
      { path: ".aws/credentials", contentBase64: b64("[default]\naws_access_key_id=AKIA\n") },
      { path: ".config/gh/hosts.yml", contentBase64: b64("github.com:\n  oauth_token: gho_x\n") },
      { path: ".config/glab-cli/config.yml", contentBase64: b64("hosts:\n  gitlab.com:\n    token: glpat_x\n") },
      { path: ".kube/config", contentBase64: b64("apiVersion: v1\n") },
      { path: ".docker/config.json", contentBase64: b64("{}\n") },
      { path: ".npmrc", contentBase64: b64("//registry.npmjs.org/:_authToken=npm_x\n") },
      { path: ".netrc", contentBase64: b64("machine example.com login u password p\n") },
      { path: ".ssh/id_ed25519", contentBase64: b64("PRIVATE KEY\n") },
    ],
  });

  assert.match(script, /\$\{TMPDIR:-\/tmp\}\/keychain\.XXXXXX/, "materialized files are rooted in ephemeral /tmp");
  assert.ok(!script.includes("/root/") && !script.includes("$HOME"), "no materialized file targets the durable home");
  assert.match(script, /export AWS_CONFIG_FILE="\$__kc_dir\/.aws\/config"/);
  assert.match(script, /export AWS_SHARED_CREDENTIALS_FILE="\$__kc_dir\/.aws\/credentials"/);
  assert.match(script, /export GH_CONFIG_DIR="\$__kc_dir\/.config\/gh"/);
  assert.match(script, /export GLAB_CONFIG_DIR="\$__kc_dir\/.config\/glab-cli"/);
  assert.match(script, /export KUBECONFIG="\$__kc_dir\/.kube\/config"/);
  assert.match(script, /export DOCKER_CONFIG="\$__kc_dir\/.docker"/);
  assert.match(script, /export NPM_CONFIG_USERCONFIG="\$__kc_dir\/.npmrc"/);
  assert.match(script, /export NETRC="\$__kc_dir\/.netrc"/);
  assert.match(script, /export GIT_SSH_COMMAND="ssh -i \$__kc_dir\/.ssh\/id_ed25519 -o IdentitiesOnly=yes"/);
});

test("glab file bundles use GLAB_CONFIG_DIR for current and legacy config locations", () => {
  const b64 = Buffer.from("token: glpat_x\n").toString("base64");
  const cases: Array<[string, string]> = [
    [".config/glab-cli/config.yml", ".config/glab-cli"],
    [".config/glab/config.yml", ".config/glab"],
    ["Library/Application Support/glab-cli/config.yml", "Library/Application Support/glab-cli"],
  ];
  for (const [path, dir] of cases) {
    const script = renderUseScript({
      kind: "file",
      credentialId: `cred-${path}`,
      ownerId: "U1",
      service: "glab",
      files: [{ path, contentBase64: b64 }],
    });
    assert.match(
      script,
      new RegExp(`export GLAB_CONFIG_DIR="\\$__kc_dir/${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
  }
});

test("a non-redirectable cred (AWS SSO token cache) overlays HOME; redirectable bundles leave it untouched", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const sso = renderUseScript({
    kind: "file",
    credentialId: "cred-sso",
    ownerId: "U1",
    service: "aws",
    files: [
      { path: ".aws/config", contentBase64: b64("[default]\nsso_session=acme\n") },
      { path: ".aws/sso/cache/abc123.json", contentBase64: b64('{"accessToken":"sso_x"}') },
    ],
  });
  assert.match(sso, /export HOME="\$__kc_dir"/, "HOME points at the bundle so ~/.aws/sso/cache resolves");
  assert.match(
    sso,
    /ln -s "\$__e" "\$__kc_dir\/\$__b"/,
    "the box's own home is mirrored in, so unrelated ~ lookups still resolve",
  );
  assert.match(
    sso,
    /export AWS_CONFIG_FILE="\$__kc_dir\/.aws\/config"/,
    "env pointers are still emitted alongside the HOME overlay",
  );
  const writes = [...sso.matchAll(/base64 -d > "([^"]+)"/g)].map((x) => x[1]!);
  assert.ok(
    writes.length > 0 && writes.every((w) => w.startsWith("$__kc_dir/")),
    "every materialized file lands under $__kc_dir, not durable home",
  );

  const gh = renderUseScript({
    kind: "file",
    credentialId: "cred-gh",
    ownerId: "U1",
    service: "gh",
    files: [{ path: ".config/gh/hosts.yml", contentBase64: b64("github.com:\n  oauth_token: gho_x\n") }],
  });
  assert.ok(!gh.includes("export HOME=") && !gh.includes("$HOME"), "redirectable creds leave HOME untouched");
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
  const first = await k.materialize(grant.id, "channel:C1", "U2");
  const second = await k.materialize(grant.id, "channel:C1", "U2");
  assert.equal(first.kind, "file");
  assert.equal(second.kind, "file", "standing file grants stay reusable for explicit /use re-fetches");
  assert.match(renderUseScript(first), /export GLAB_CONFIG_DIR="\$__kc_dir\/.config\/glab-cli"/);
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
  const writer = createKeychain({ creds, grants: createMemoryMap(), asks: createMemoryMap(), key: OTHER });
  await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({ creds, grants: createMemoryMap(), asks: createMemoryMap(), key: KEY });
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
  const writer = createKeychain({ creds, grants, asks: createMemoryMap(), key: OTHER });
  const cred = await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({ creds, grants, asks: createMemoryMap(), key: KEY });
  const grant = await reader.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use it",
  });
  await assert.rejects(
    reader.materialize(grant.id, "channel:C1", "U2"),
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
    { key: "DOORDASH_EMAIL", value: "alice@acme.co" },
    { key: "DOORDASH_PASSWORD", value: "hunter2" },
  ]);
  const script = renderUseScript({ kind: "env", ...own! });
  assert.match(script, /export DOORDASH_EMAIL='alice@acme.co'\nexport DOORDASH_PASSWORD='hunter2'/);
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
});

test("back-compat: a legacy record carrying a plaintext username still materializes the paired env var", async () => {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const k = createKeychain({ creds, grants: createMemoryMap(), asks: createMemoryMap(), key: KEY });
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
    { key: "ACME_PORTAL_USERNAME", value: "alice@acme.co" },
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
    injected: [],
  });
  assert.match(empty, /## Teammate keychains/);
  assert.match(empty, /No keychain credentials registered yet/);
  assert.match(empty, /v1\/keychain\/grants/);

  const detected = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U2",
    members: [{ id: "U2" }, { id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    injected: [],
    detectedByOwner: new Map([["U1", ["GitHub", "AWS SSO"]]]),
  });
  assert.match(detected, /Detected but NOT registered/);
  assert.match(detected, /Alice \(U1\): GitHub, AWS SSO — signed in on their own computer/);

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
    injected: [
      {
        credentialId: cred.id,
        ownerId: "U1",
        service: "github",
        env: [{ key: "GITHUB_TOKEN", value: "x" }],
        grantId: grant.id,
        purpose: grant.purpose,
      },
    ],
  });
  assert.match(block, /## Teammate keychains/);
  assert.match(block, /Alice \(U1\): github/);
  assert.match(block, new RegExp(`credential id \`${cred.id}\``));
  assert.match(block, /STANDING grant .*gh for repo work here/);
  assert.match(block, /GITHUB_TOKEN.*Act within that purpose/);
  assert.match(block, /v1\/keychain\/grants/);

  const login = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U2",
    members: [{ id: "U2" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    injected: [
      {
        credentialId: "c1",
        ownerId: "U1",
        service: "doordash",
        env: [
          { key: "DOORDASH_EMAIL", value: "x" },
          { key: "DOORDASH_PASSWORD", value: "y" },
        ],
        grantId: "g1",
        purpose: "billing",
      },
    ],
  });
  assert.match(login, /`DOORDASH_EMAIL` \+ `DOORDASH_PASSWORD`/);
  assert.ok(!block.includes("ghp_secret"), "the manifest is metadata-only");
});

test("manifest: in the owner's personal scope their own credentials need no grant and load by id", async () => {
  const k = kc();
  await k.save(GH);
  await k.save({ ownerId: "U1", service: "npm", secret: "npm_x", envKey: "NPM_TOKEN", expiresAt: Date.now() - 1 });
  const own = renderKeychainManifest({
    scopeId: "personal:U1",
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
    injected: [],
  });
  assert.match(own, /their own — no grant needed in this personal conversation/);
  assert.match(own, /access is implied/);
  assert.match(own, /"credential":"<credential id>"/);
  assert.match(own, /works only here, in their personal conversation/);
  assert.ok(!own.includes("no grant for this conversation"));
  assert.match(
    own,
    /EXPIRED — they must re-auth before it can be used/,
    "an expired own credential points at re-auth, not the grant flow",
  );
  assert.ok(!own.includes("before requesting a grant"));

  const other = renderKeychainManifest({
    scopeId: "personal:U2",
    conversationKind: "dm",
    actorId: "U2",
    members: [{ id: "U2" }, { id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
    injected: [],
  });
  assert.match(other, /no grant for this conversation/);
  assert.match(other, /EXPIRED — ask the owner to re-auth before requesting a grant/);
  assert.ok(!other.includes("their own — no grant needed"), "a teammate's credential never reads as implied");

  const channel = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U1",
    members: [{ id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
    injected: [],
  });
  assert.ok(
    !channel.includes("access is implied"),
    "the actor's own credentials in a shared scope keep the grant protocol",
  );
  assert.match(channel, /no grant for this conversation/);
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

  it("saves to the TOKEN's actor and lists only the caller's own credentials", async () => {
    const res = await post(
      "/v1/keychain/credentials",
      { service: "github", secret: "ghp_u1", envKey: "GITHUB_TOKEN", accountLabel: "AliceBell" },
      await capFor("U1"),
    );
    assert.equal(res.status, 200);
    const { credential } = (await res.json()) as any;
    assert.equal(credential.ownerId, "U1");
    assert.ok(!JSON.stringify(credential).includes("ghp_u1"));

    const mine = (await (await get("/v1/keychain/credentials", await capFor("U1"))).json()) as any;
    assert.equal(mine.credentials.length, 1);
    const other = (await (await get("/v1/keychain/credentials", await capFor("U2"))).json()) as any;
    assert.deepEqual(other.credentials, []);
  });

  it("a participant's connector is grantable by its owner, then materialized under the host env var", async () => {
    const GROUP = scopeId("group", "G_CONN");
    await built.keychain!.setConnectorToken("gmail.googleapis.com", "alex@conn", {
      accessToken: "ya29.alex",
      expiresAt: Date.now() + 3_600_000,
    });
    const cid = (await built.keychain!.listConnectorsByOwners(["alex@conn"])).get("alex@conn")![0]!.credentialId;

    const denied = await post(
      "/v1/keychain/grants",
      { credential: cid, mode: "once", purpose: "x" },
      await capFor("carol@conn", GROUP),
    );
    assert.equal(denied.status, 403, "only the owner can grant their connector");

    const granted = await post(
      "/v1/keychain/grants",
      { credential: cid, mode: "once", purpose: "check my signature emails" },
      await capFor("alex@conn", GROUP),
    );
    assert.equal(granted.status, 200);
    const { grant } = (await granted.json()) as any;
    const used = await post("/v1/keychain/use", { grant: grant.id }, await capFor("carol@conn", GROUP));
    assert.equal(used.status, 200);
    assert.equal(await used.text(), "export VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM='ya29.alex'\n");
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

    const granted = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "once", purpose: "use the seconds-normalized credential" },
      await capFor("U_SECONDS", "channel:C_SECONDS"),
    );
    assert.equal(granted.status, 200, "seconds input must not make the credential look expired immediately");
  });

  it("rejects invalid keychain credential and grant expiry at the route boundary", async () => {
    const badCred = await post(
      "/v1/keychain/credentials",
      { service: "bad-exp", secret: "x", expiresAt: "not-a-date" },
      await capFor("U_BAD_EXP"),
    );
    assert.equal(badCred.status, 400);

    const { credential } = (await (
      await post("/v1/keychain/credentials", { service: "good-exp", secret: "x" }, await capFor("U_BAD_EXP"))
    ).json()) as any;
    const badGrant = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "once", purpose: "p", expiresAt: "not-a-date" },
      await capFor("U_BAD_EXP", "channel:C_BAD_EXP"),
    );
    assert.equal(badGrant.status, 400);
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

  it("grant: only mintable on the OWNER's own turn; use is scope-bound and returns sourceable env text", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "github", secret: "ghp_grant", envKey: "GH_GRANT" },
        await capFor("OWNER"),
      )
    ).json()) as any;

    const forged = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "once", purpose: "alice said it's fine" },
      await capFor("IMPOSTOR", "channel:C7"),
    );
    assert.equal(forged.status, 403);

    const granted = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "once", purpose: "yes, clone the repo with my gh" },
      await capFor("OWNER", "channel:C7"),
    );
    assert.equal(granted.status, 200);
    const g = (await granted.json()) as any;
    assert.equal(g.grant.audienceScopeId, "channel:C7");
    assert.match(g.use.command, /v1\/keychain\/use/);

    const elsewhere = await post("/v1/keychain/use", { grant: g.grant.id }, await capFor("U3", "channel:OTHER"));
    assert.equal(elsewhere.status, 403);

    const used = await post("/v1/keychain/use", { grant: g.grant.id }, await capFor("U3", "channel:C7"));
    assert.equal(used.status, 200);
    assert.match(used.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal(await used.text(), "export GH_GRANT='ghp_grant'\n");

    assert.equal((await post("/v1/keychain/use", { grant: g.grant.id }, await capFor("U3", "channel:C7"))).status, 410);

    const usage = await built.credentialUsage.list({});
    assert.ok(
      usage.some(
        (u) => u.slug === `keychain:github:${credential.id}` && u.principalId === "U3" && u.scopeLabel === "channel:C7",
      ),
    );
  });

  it("overview joins owned credential metadata to grants and recent audited use without secret values", async () => {
    const owner = "OVERVIEW_OWNER";
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "overview", secret: "never-return-this", envKey: "OVERVIEW_TOKEN" },
        await capFor(owner),
      )
    ).json()) as any;
    const granted = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "standing", purpose: "deploy the reporting app" },
      await capFor(owner, "channel:C_OVERVIEW"),
    );
    const { grant } = (await granted.json()) as any;
    await post("/v1/keychain/use", { grant: grant.id }, await capFor(owner, "channel:C_OVERVIEW"));

    const overview = await get("/v1/keychain/overview", await capFor(owner));
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as any;
    assert.equal(body.credentials[0].id, credential.id);
    assert.equal(body.grants[0].purpose, "deploy the reporting app");
    assert.equal(body.usage[0].credentialId, credential.id);
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
    await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "standing", purpose: "named channel work" },
      await capFor(owner, "channel:C_NAMED"),
    );
    await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "standing", purpose: "unnamed channel work" },
      await capFor(owner, "channel:C_MYSTERY"),
    );
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

  it("standing file grants are not auto-injected, but /v1/keychain/use re-fetches them into /tmp with glab env pointers", async () => {
    const content = "hosts:\n  gitlab.com:\n    token: glpat_route\n";
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        {
          service: "glab",
          files: [{ path: ".config/glab-cli/config.yml", contentBase64: Buffer.from(content).toString("base64") }],
        },
        await capFor("OWNER"),
      )
    ).json()) as any;

    const granted = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "standing", purpose: "yes, use my glab in this channel" },
      await capFor("OWNER", "channel:C8"),
    );
    assert.equal(granted.status, 200);
    const g = (await granted.json()) as any;
    assert.deepEqual(
      await built.keychain!.materializeStanding("channel:C8"),
      [],
      "standing file grants do not ride provision env injection",
    );

    for (let i = 0; i < 2; i++) {
      const used = await post("/v1/keychain/use", { grant: g.grant.id }, await capFor("U3", "channel:C8"));
      assert.equal(used.status, 200);
      const script = await used.text();
      assert.match(script, /\$\{TMPDIR:-\/tmp\}\/keychain\.XXXXXX/);
      assert.match(script, /export GLAB_CONFIG_DIR="\$__kc_dir\/.config\/glab-cli"/);
      assert.ok(
        !script.includes("/root/") && !script.includes("$HOME"),
        "file grant materialization must stay off durable home",
      );
      assert.ok(!script.includes("glpat_route"), "raw file contents stay base64-encoded in the sourceable script");
    }
  });

  const liveOwn = async (actorId: string) => await capFor(actorId, scopeId("personal", actorId), { liveActor: true });

  it("use by credential id: the caller's own, in their personal conversation only — no grant needed", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "npm", secret: "npm_own", envKey: "NPM_OWN" },
        await capFor("U_OWN"),
      )
    ).json()) as any;

    const used = await post("/v1/keychain/use", { credential: credential.id }, await liveOwn("U_OWN"));
    assert.equal(used.status, 200);
    assert.equal(await used.text(), "export NPM_OWN='npm_own'\n");
    assert.equal(
      (await post("/v1/keychain/use", { credential: credential.id }, await liveOwn("U_OWN"))).status,
      200,
      "nothing is consumed",
    );

    assert.equal(
      (
        await post(
          "/v1/keychain/use",
          { credential: credential.id },
          await capFor("U_OWN", "channel:C9", { liveActor: true }),
        )
      ).status,
      403,
      "own-use never crosses into a shared scope, even on a live turn",
    );
    assert.equal(
      (await post("/v1/keychain/use", { credential: credential.id }, await capFor("U_OWN"))).status,
      403,
      "a non-live personal turn (unprompted/detection — no liveActor) cannot pull own credentials by id",
    );
    assert.equal(
      (
        await post(
          "/v1/keychain/use",
          { credential: credential.id },
          await capFor("U_OWN", "personal:U_OWN", { triggered: true }),
        )
      ).status,
      403,
      "a trigger-fired turn runs as the owner without them speaking — refused",
    );
    assert.equal(
      (await post("/v1/keychain/use", { credential: credential.id }, await liveOwn("U_ELSE"))).status,
      404,
      "someone else's credential id reads as unknown",
    );

    const usage = await built.credentialUsage.list({});
    assert.ok(
      usage.some(
        (u) =>
          u.slug === `keychain:npm:${credential.id}` && u.principalId === "U_OWN" && u.scopeLabel === "personal:U_OWN",
      ),
    );
  });

  it("use by credential id loads the caller's own file bundle into /tmp with env pointers", async () => {
    const content = "hosts:\n  gitlab.com:\n    token: glpat_own\n";
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        {
          service: "glab",
          files: [{ path: ".config/glab-cli/config.yml", contentBase64: Buffer.from(content).toString("base64") }],
        },
        await capFor("U_OWN_FILE"),
      )
    ).json()) as any;
    const used = await post("/v1/keychain/use", { credential: credential.id }, await liveOwn("U_OWN_FILE"));
    assert.equal(used.status, 200);
    const script = await used.text();
    assert.match(script, /export GLAB_CONFIG_DIR="\$__kc_dir\/.config\/glab-cli"/);
    assert.ok(!script.includes("glpat_own"), "raw file contents stay base64-encoded in the sourceable script");
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

test("turn e2e: manifest in the prompt, no secret without a grant, standing grant injects env", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "kc-e2e-")),
      signingSecret: SECRET,
      apiBaseUrl: "http://core.test",
    }),
  );
  assert.ok(built.keychain, "buildApp with a signing secret wires the keychain");
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
  assert.match(sys.reply ?? "", /## Teammate keychains/);
  assert.match(sys.reply ?? "", /Alice \(U_OWNER\): github/);
  assert.match(sys.reply ?? "", /no grant for this conversation/);
  assert.ok(!(sys.reply ?? "").includes("ghp_e2e"), "prompt never carries the secret");

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
  mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(channelTurn("!run true", "U_ASKER", audience))).status, "ok");
  assert.ok(execScriptsMention("export GITHUB_TOKEN=", mark), "standing grant materializes the env key");
  assert.ok(execScriptsMention("ghp_e2e", mark), "standing grant carries the secret into the sandbox env");

  const sys2 = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.match(sys2.reply ?? "", /STANDING grant .*use my gh here for repo work/);

  mark = fakeSprites.execScripts().length;
  const dm: TurnRequest = {
    surface: "test",
    actor: { externalId: "U_OWNER" },
    conversation: { kind: "dm", threadRef: "dm:U_OWNER" },
    text: "!run true",
  } as TurnRequest;
  assert.equal((await built.app.turn(dm)).status, "ok");
  assert.ok(execScriptsMention("ghp_e2e", mark), "owner's personal scope gets their own keychain creds");
});
