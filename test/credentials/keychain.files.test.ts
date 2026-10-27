import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialHandle,
  renderKeychainManifest,
  fileCredentialEnvironment,
  KeychainError,
} from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { KEY, kc, GH } from "../support/keychain-store.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";

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
  const store = createKeychainStore(testDatabaseUrl());
  const OTHER = deriveConnectorKey("a-different-master-key");
  const writer = createKeychain({ lock: testAdvisoryLock(), store, key: OTHER });
  await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({ lock: testAdvisoryLock(), store, key: KEY });
  await reader.save(GH);

  const own = await reader.materializeOwn("U1");
  assert.deepEqual(
    own.map((m) => m.env[0]!.key),
    ["GITHUB_TOKEN"],
    "good row still materializes; undecryptable one is skipped",
  );
});

test("single-grant materialize surfaces a 422 (not a raw crypto 500) when the row doesn't decrypt", async () => {
  const store = createKeychainStore(testDatabaseUrl());
  const OTHER = deriveConnectorKey("a-different-master-key");
  const writer = createKeychain({ lock: testAdvisoryLock(), store, key: OTHER });
  const cred = await writer.save({ ownerId: "U1", service: "stripe", secret: "sk_bad", envKey: "STRIPE_KEY" });

  const reader = createKeychain({ lock: testAdvisoryLock(), store, key: KEY });
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
  assert.match(empty, /`request-access` skill/);
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
  assert.match(block, /STANDING grant .*gh for repo work here/);
  assert.match(block, /github:[a-f0-9]+.*GITHUB_TOKEN/);
  assert.match(block, /select them in execute.credentials/);
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
  const own = renderKeychainManifest({
    scopeId: "personal:U1",
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U1", displayName: "Alice" }],
    entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
    scopeGrants: [],
  });
  assert.match(own, /### Alice \(U1\) — own; no grant needed \(including background turns\)\n.*file-login/);
  assert.doesNotMatch(own, /Teammate keychains/);
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
  });
  assert.ok(
    !channel.includes("access is implied"),
    "the actor's own credentials in a shared scope keep the grant protocol",
  );
  assert.match(channel, /no grant for this conversation/);
});
