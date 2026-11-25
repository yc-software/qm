import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConnectorKey, encryptSecret } from "../src/connectors/connector-client-store.ts";
import { loadConfig } from "../src/config.ts";
import { createEncryptedSecretStore } from "../src/credentials/secret-store.ts";
import { createVaultSecretStores, type VaultAuth } from "../src/credentials/vault-secret-store.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";

const TENANT_A = "0b6f5c1e-8d2a-4f3b-9c47-1a2b3c4d5e6f";
const TENANT_B = "7c9d2e4f-1a3b-4c5d-8e6f-9a0b1c2d3e4f";
const key = deriveConnectorKey("vault-secret-store-test-key", "keychain");

function fakeVault() {
  const values = new Map<string, unknown>();
  const sessions = new Set<string>();
  const requests: { method: string; path: string; token: string | null; namespace: string | null }[] = [];
  let logins = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const token = headers.get("x-vault-token");
    requests.push({ method, path: url.pathname, token, namespace: headers.get("x-vault-namespace") });
    if (url.pathname.endsWith("/login")) {
      const body = JSON.parse(String(init?.body)) as { role: string; jwt: string };
      if (body.role !== "qm" || body.jwt !== "projected-jwt")
        return Response.json({ errors: ["permission denied"] }, { status: 403 });
      const issued = `session-${++logins}`;
      sessions.add(issued);
      return Response.json({ auth: { client_token: issued, lease_duration: 3600 } });
    }
    if (!token || (!sessions.has(token) && token !== "static-token")) {
      return Response.json({ errors: ["permission denied"] }, { status: 403 });
    }
    const [, , mount, kind, ...rest] = url.pathname.split("/");
    const path = `${mount}/${rest.map(decodeURIComponent).join("/")}`;
    if (kind === "data" && method === "POST") {
      values.set(path, (JSON.parse(String(init?.body)) as { data: unknown }).data);
      return Response.json({ data: { version: 1 } });
    }
    if (kind === "data" && method === "GET") {
      return values.has(path)
        ? Response.json({ data: { data: values.get(path), metadata: { version: 1 } } })
        : Response.json({ errors: [] }, { status: 404 });
    }
    if (kind === "metadata" && method === "DELETE") {
      values.delete(path);
      return new Response(null, { status: 204 });
    }
    return Response.json({ errors: ["unsupported"] }, { status: 405 });
  };
  return { fetch, values, sessions, requests };
}

function file(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "qm-vault-")), "token");
  writeFileSync(path, `${contents}\n`);
  return path;
}

const kubernetes = (): VaultAuth => ({
  method: "kubernetes",
  mount: "kubernetes",
  role: "qm",
  jwtFile: file("projected-jwt"),
});

test("vault store: logs in once, then writes, reads and deletes KV v2 data under the bound tenant", async () => {
  const vault = fakeVault();
  const store = createVaultSecretStores(
    { addr: "http://vault:8200", kvMount: "secret", namespace: "team", auth: kubernetes() },
    vault.fetch,
  )(key);
  const ref = await withTenant(TENANT_A, () => store.put("keychain:github", "ghp_one"));
  assert.match(ref, /^vault:keychain-github@[0-9a-f-]{36}$/);
  assert.equal(await withTenant(TENANT_A, () => store.get(ref)), "ghp_one");
  await assert.rejects(
    withTenant(TENANT_B, () => store.get(ref)),
    /404/,
  );
  await withTenant(TENANT_A, () => store.delete(ref));
  await withTenant(TENANT_A, () => store.delete(ref));
  assert.equal(vault.values.size, 0);

  const secretKey = encodeURIComponent(ref.slice("vault:".length));
  assert.deepEqual(
    vault.requests.map((r) => [r.method, r.path, r.token, r.namespace]),
    [
      ["POST", "/v1/auth/kubernetes/login", null, "team"],
      ["POST", `/v1/secret/data/${TENANT_A}/${secretKey}`, "session-1", "team"],
      ["GET", `/v1/secret/data/${TENANT_A}/${secretKey}`, "session-1", "team"],
      ["GET", `/v1/secret/data/${TENANT_B}/${secretKey}`, "session-1", "team"],
      ["DELETE", `/v1/secret/metadata/${TENANT_A}/${secretKey}`, "session-1", "team"],
      ["DELETE", `/v1/secret/metadata/${TENANT_A}/${secretKey}`, "session-1", "team"],
    ],
  );
});

test("vault store: logs in again when Vault forgets the client token", async () => {
  const vault = fakeVault();
  const store = createVaultSecretStores(
    { addr: "http://vault:8200", kvMount: "secret", auth: kubernetes() },
    vault.fetch,
  )(key);
  const ref = await withTenant(TENANT_A, () => store.put("model", "sk-one"));
  vault.sessions.clear();
  assert.equal(await withTenant(TENANT_A, () => store.get(ref)), "sk-one");
  assert.deepEqual(
    vault.requests.filter((r) => r.path.endsWith("/login")).map((r) => r.path),
    ["/v1/auth/kubernetes/login", "/v1/auth/kubernetes/login"],
  );
});

test("vault store: a static token needs no login, and a token file is read on every call", async () => {
  const vault = fakeVault();
  const tokenFile = file("static-token");
  const store = createVaultSecretStores(
    { addr: "http://vault:8200", kvMount: "kv", auth: { method: "token", tokenFile } },
    vault.fetch,
  )(key);
  const ref = await withTenant(TENANT_A, () => store.put("slack", "xoxb-one"));
  writeFileSync(tokenFile, "rotated-token\n");
  await assert.rejects(
    withTenant(TENANT_A, () => store.get(ref)),
    /403/,
  );
  assert.equal(vault.requests.filter((r) => r.path.endsWith("/login")).length, 0);
  assert.deepEqual(
    vault.requests.map((r) => r.token),
    ["static-token", "rotated-token"],
  );
});

test("vault store: an encrypted ref from before Vault still reads, without a call", async () => {
  const vault = fakeVault();
  const store = createVaultSecretStores(
    { addr: "http://vault:8200", kvMount: "secret", auth: kubernetes() },
    vault.fetch,
  )(key);
  const legacy = encryptSecret("sk-legacy", key);
  assert.equal(await withTenant(TENANT_A, () => store.get(legacy)), "sk-legacy");
  await withTenant(TENANT_A, () => store.delete(legacy));
  assert.equal(vault.requests.length, 0);
});

test("vault store: a Vault ref names the missing VAULT_ADDR once Vault is turned off", async () => {
  await assert.rejects(
    createEncryptedSecretStore(key).get("vault:keychain-github@1"),
    /stored in Vault, but VAULT_ADDR is not set/,
  );
});

test("vault store: refuses to call Vault with no bound tenant", async () => {
  const vault = fakeVault();
  const store = createVaultSecretStores(
    { addr: "http://vault:8200", kvMount: "secret", auth: kubernetes() },
    vault.fetch,
  )(key);
  await assert.rejects(
    withoutTenant(() => store.put("github", "ghp_one")),
    /No tenant/,
  );
  assert.equal(vault.requests.length, 0);
});

test("vault config: reads the auth method from the environment", () => {
  const env = { DATABASE_URL: "postgres://localhost/qm", VAULT_ADDR: "http://vault:8200/" };
  assert.throws(() => loadConfig({ ...env }), /VAULT_TOKEN or VAULT_TOKEN_FILE/);
  assert.deepEqual(loadConfig({ ...env, VAULT_TOKEN: "t" }).vault, {
    addr: "http://vault:8200",
    kvMount: "secret",
    auth: { method: "token", token: "t" },
  });
  assert.deepEqual(loadConfig({ ...env, VAULT_AUTH_METHOD: "kubernetes", VAULT_AUTH_ROLE: "qm" }).vault?.auth, {
    method: "kubernetes",
    mount: "kubernetes",
    role: "qm",
    jwtFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  });
  assert.throws(() => loadConfig({ ...env, VAULT_AUTH_METHOD: "jwt", VAULT_AUTH_ROLE: "qm" }), /VAULT_AUTH_JWT_FILE/);
  assert.throws(() => loadConfig({ ...env, VAULT_AUTH_METHOD: "approle" }), /not recognized/);
  assert.equal(loadConfig({ DATABASE_URL: "postgres://localhost/qm" }).vault, undefined);
});
