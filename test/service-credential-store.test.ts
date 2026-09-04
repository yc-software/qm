import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { createKeychain, isValidCredentialSlug, type KeychainCredential } from "../src/credentials/keychain.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const ORG = scopeId("org", "default-org");
const KEY = deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa");

function store(opts: { creds?: DurableMap<KeychainCredential> } = {}) {
  return createKeychain({
    creds: opts.creds ?? createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
  });
}

test("set → list projects WITHOUT the secret; getSecret decrypts it", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, {
    slug: "x-firehose",
    name: "X firehose",
    secret: "super-secret-bearer",
    host: "api.x.com",
    injection: { header: "Authorization", scheme: "Bearer " },
    allowedMethods: ["get"],
    allowedPathPrefixes: ["/2/tweets/search/"],
    updatedBy: "admin-alice",
  });

  const list = await cfg.listServiceCredentials(ORG);
  assert.equal(list.length, 1);
  const pub = list[0]!;
  assert.equal(pub.slug, "x-firehose");
  assert.equal(pub.name, "X firehose");
  assert.equal(pub.host, "api.x.com");
  assert.equal(pub.hasSecret, true);
  assert.equal(pub.enabled, true);
  assert.deepEqual(pub.allowedMethods, ["GET"]);
  assert.doesNotMatch(JSON.stringify(pub), /super-secret-bearer/);

  const dec = await cfg.getServiceCredentialSecret(ORG, "x-firehose");
  assert.equal(dec?.secret, "super-secret-bearer");
  assert.equal(dec?.host, "api.x.com");
  assert.deepEqual(dec?.allowedPathPrefixes, ["/2/tweets/search/"]);
});

test("the pasted secret is trimmed (a trailing newline would otherwise 401 the upstream)", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, {
    slug: "x-firehose",
    name: "X firehose",
    secret: "  super-secret-bearer\n",
    host: "api.x.com",
  });
  const dec = await cfg.getServiceCredentialSecret(ORG, "x-firehose");
  assert.equal(dec?.secret, "super-secret-bearer");
});

test("write-only update: omitting the secret keeps the stored one", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "serp", name: "SERP", secret: "key-1", host: "api.serper.dev" });
  await cfg.setServiceCredential(ORG, { slug: "serp", name: "SERP API", host: "api.serper.dev", enabled: false });
  const dec = await cfg.getServiceCredentialSecret(ORG, "serp");
  assert.equal(dec?.secret, "key-1");
  const pub = (await cfg.listServiceCredentials(ORG))[0]!;
  assert.equal(pub.name, "SERP API");
  assert.equal(pub.enabled, false);
  assert.equal(pub.hasSecret, true);
});

test("an explicit new secret REPLACES the stored one", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "k", name: "K", secret: "old", host: "h.example" });
  await cfg.setServiceCredential(ORG, { slug: "k", name: "K", secret: "new", host: "h.example" });
  assert.equal((await cfg.getServiceCredentialSecret(ORG, "k"))?.secret, "new");
});

test("conditional credential updates and deletes are atomic across store instances", async () => {
  const creds = createMemoryMap<KeychainCredential>();
  const left = store({ creds });
  const right = store({ creds });
  await left.setServiceCredential(ORG, { slug: "k", name: "K", secret: "old", host: "h.example" });
  const version = (await left.listServiceCredentials(ORG))[0]!.updatedAt;

  const writes = await Promise.all([
    left.setServiceCredentialIfCurrent(ORG, { slug: "k", name: "Left", host: "h.example" }, version),
    right.setServiceCredentialIfCurrent(ORG, { slug: "k", name: "Right", host: "h.example" }, version),
  ]);
  assert.equal(writes.filter((updatedAt) => updatedAt !== null).length, 1);
  const current = (await left.listServiceCredentials(ORG))[0]!;
  assert.ok(current.updatedAt > version);
  assert.equal(await right.deleteServiceCredentialIfCurrent(ORG, "k", version), false);
  assert.equal(await right.deleteServiceCredentialIfCurrent(ORG, "k", current.updatedAt), true);
  assert.equal((await left.listServiceCredentials(ORG)).length, 0);
});

test("conditional compensation never overwrites newer update, create, or delete state", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "updated", name: "Original", secret: "old", host: "old.example" });
  const original = (await cfg.listServiceCredentials(ORG)).find((credential) => credential.slug === "updated")!;
  const forwardVersion = await cfg.setServiceCredentialIfCurrent(
    ORG,
    { slug: "updated", name: "Forward", host: "forward.example" },
    original.updatedAt,
  );
  assert.notEqual(forwardVersion, null);
  const concurrentVersion = await cfg.setServiceCredentialIfCurrent(
    ORG,
    { slug: "updated", name: "Concurrent", host: "concurrent.example" },
    forwardVersion!,
  );
  assert.notEqual(concurrentVersion, null);
  assert.equal(
    await cfg.setServiceCredentialIfCurrent(
      ORG,
      { slug: "updated", name: "Original", host: "old.example" },
      forwardVersion!,
    ),
    null,
  );
  assert.equal(
    (await cfg.listServiceCredentials(ORG)).find((credential) => credential.slug === "updated")!.name,
    "Concurrent",
  );

  const createdVersion = await cfg.setServiceCredentialIfAbsent(ORG, {
    slug: "created",
    name: "Created",
    secret: "one",
    host: "one.example",
  });
  assert.notEqual(createdVersion, null);
  assert.notEqual(
    await cfg.setServiceCredentialIfCurrent(
      ORG,
      { slug: "created", name: "Concurrent", host: "two.example" },
      createdVersion!,
    ),
    null,
  );
  assert.equal(await cfg.deleteServiceCredentialIfCurrent(ORG, "created", createdVersion!), false);
  assert.equal(
    (await cfg.listServiceCredentials(ORG)).find((credential) => credential.slug === "created")!.name,
    "Concurrent",
  );

  await cfg.setServiceCredential(ORG, { slug: "deleted", name: "Original", secret: "old", host: "old.example" });
  const deleted = (await cfg.listServiceCredentials(ORG)).find((credential) => credential.slug === "deleted")!;
  assert.equal(await cfg.deleteServiceCredentialIfCurrent(ORG, "deleted", deleted.updatedAt), true);
  assert.notEqual(
    await cfg.setServiceCredentialIfAbsent(ORG, {
      slug: "deleted",
      name: "Concurrent",
      secret: "new",
      host: "new.example",
    }),
    null,
  );
  assert.equal(
    await cfg.setServiceCredentialIfAbsent(ORG, {
      slug: "deleted",
      name: "Original",
      secret: "old",
      host: "old.example",
    }),
    null,
  );
  assert.equal(
    (await cfg.listServiceCredentials(ORG)).find((credential) => credential.slug === "deleted")!.name,
    "Concurrent",
  );
});

test("delete removes the record (getSecret → null)", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "k", name: "K", secret: "s", host: "h.example" });
  await cfg.deleteServiceCredential(ORG, "k");
  assert.equal(await cfg.getServiceCredentialSecret(ORG, "k"), null);
  assert.equal((await cfg.listServiceCredentials(ORG)).length, 0);
});

test("records are scoped — another scope sees nothing", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "k", name: "K", secret: "s", host: "h.example" });
  assert.equal((await cfg.listServiceCredentials(scopeId("org", "other"))).length, 0);
  assert.equal(await cfg.getServiceCredentialSecret(scopeId("org", "other"), "k"), null);
});

test("getSecret returns null when a record has no secret (defensive)", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "empty", name: "Empty", host: "h.example" });
  assert.equal(await cfg.getServiceCredentialSecret(ORG, "empty"), null);
});

test("slug validation: lowercase kebab only", () => {
  for (const ok of ["x-firehose", "serp", "a", "a1-b2"]) assert.equal(isValidCredentialSlug(ok), true, ok);
  for (const bad of ["", "X", "has space", "-leading", "under_score", "slash/here", "a".repeat(64)])
    assert.equal(isValidCredentialSlug(bad), false, bad);
});

test("broker records never enter the person-facing keychain surfaces or grant flow", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, { slug: "serp", name: "SERP", secret: "k", host: "api.serper.dev" });
  assert.deepEqual(
    await cfg.listByOwner(ORG),
    [],
    "broker records are org infrastructure, not listable keychain items",
  );
  const rec = (await cfg.listServiceCredentials(ORG))[0]!;
  void rec;
  await assert.rejects(
    cfg.createGrant({
      credentialId: "0000000000000000",
      ownerId: "U1",
      audienceScopeId: ORG,
      mode: "once",
      purpose: "x",
    }),
    /unknown credential/,
  );
});

test("delivery + envKey persist and project; legacy records read as broker", async () => {
  const cfg = store();
  await cfg.setServiceCredential(ORG, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "s3",
    host: "",
  });
  const pub = (await cfg.listServiceCredentials(ORG))[0]!;
  assert.equal(pub.delivery, "env");
  assert.equal(pub.envKey, "STEEL_API_KEY");
  const dec = await cfg.getServiceCredentialSecret(ORG, "browse-steel");
  assert.equal(dec?.delivery, "env");
  assert.equal(dec?.envKey, "STEEL_API_KEY");
  assert.equal(dec?.secret, "s3");

  await cfg.setServiceCredential(ORG, { slug: "x-firehose", name: "X", secret: "bearer", host: "api.x.com" });
  const legacy = await cfg.getServiceCredentialSecret(ORG, "x-firehose");
  assert.equal(legacy?.delivery, "broker", "no delivery on the input means broker");
  assert.equal(legacy?.envKey, undefined);
});

test("env delivery validates its envKey; broker refuses one", async () => {
  const cfg = store();
  const envInput = (envKey?: string) => ({
    slug: "browse-steel",
    name: "Steel",
    delivery: "env" as const,
    ...(envKey ? { envKey } : {}),
    secret: "s",
    host: "",
  });
  await assert.rejects(() => cfg.setServiceCredential(ORG, envInput()), /needs an UPPER_SNAKE_CASE envKey/);
  await assert.rejects(() => cfg.setServiceCredential(ORG, envInput("lower_key")), /needs an UPPER_SNAKE_CASE envKey/);
  await assert.rejects(
    () => cfg.setServiceCredential(ORG, envInput("AGENT_API_TOKEN")),
    /needs an UPPER_SNAKE_CASE envKey/,
  );
  await assert.rejects(
    () => cfg.setServiceCredential(ORG, { slug: "x", name: "X", envKey: "X_KEY", secret: "s", host: "api.x.com" }),
    /must not carry an envKey/,
  );
});
