import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { createDeployStore, type Deployment, type DeploymentCredentialBinding } from "../src/deploy/deploy-store.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { mintCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import type { OrchestratorInput } from "../src/core/orchestrator/types.ts";
import { personalScope, scopeId } from "../src/types.ts";
import { orgScope } from "../src/config.ts";
import { realBrokerFetch } from "../src/api/credential-broker.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";

const SECRET = "local-deployment-binding-tests".repeat(2);
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function fixture() {
  const records = createMemoryMap<KeychainCredential>();
  const keychain = createKeychain({
    creds: records,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey(SECRET),
  });
  const backing = createMemoryMap<Deployment>();
  const deployStore = createDeployStore(backing);
  const deployment = await deployStore.create({
    ownerScopeId: personalScope(OWNER),
    createdBy: OWNER,
    entrypoint: "unused",
    snapshotDir: "/unused",
  });
  await deployStore.setStatus(deployment.id, "running");
  const credential = await keychain.save({
    ownerId: OWNER,
    service: "paired-provider",
    host: "api.example.com",
    fields: [
      { envKey: "TOKEN_ID", value: "fake-token-identity" },
      { envKey: "TOKEN_SECRET", value: "fake-token-secret" },
    ],
  });
  const binding: DeploymentCredentialBinding = {
    credentialId: credential.id,
    ownerId: OWNER,
    host: "api.example.com",
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v1/data"],
    headers: [
      { name: "x-token-id", field: "TOKEN_ID" },
      { name: "x-token-secret", field: "TOKEN_SECRET" },
    ],
  };
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const { run } = await runs.enqueue({
    sessionId: "owner-dm",
    request: {
      actor: { id: OWNER, type: "internal" },
      conversation: { kind: "dm", threadRef: "owner-dm", audience: [] },
      origin: { kind: "human" },
      surface: "slack",
      text: "Allow this app to read my provider data",
    } as unknown as OrchestratorInput,
  });
  const identity = createIdentityService();
  const acl = createAclStore();
  const audit: AuditEvent[] = [];
  const upstreamCalls: Array<{ headers: Record<string, unknown>; body: string; url: string | undefined }> = [];
  const upstream = httpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstreamCalls.push({ headers: req.headers, body, url: req.url });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: ["provider-result"] }));
  });
  const upstreamBase = await listen(upstream);
  const server = createServer(
    {
      authorizesCapabilityScope: async () => true,
      getDeployment: (id: string) => deployStore.get(id),
    } as unknown as App,
    {
      signingSecret: SECRET,
      deployStore,
      keychain,
      serviceCreds: keychain,
      runs,
      signals,
      identity,
      acl,
      auditLog: {
        record: (event) => {
          audit.push(event);
        },
        events: async () => audit,
        tail: async () => audit,
      },
      brokerFetch: (url, init) => {
        assert.equal(new URL(url).host, "api.example.com");
        return realBrokerFetch(`${upstreamBase}${new URL(url).pathname}${new URL(url).search}`, init);
      },
    },
  );
  const base = await listen(server);
  const token = (over: Partial<CapabilityClaims> = {}) =>
    mintCapabilityToken(
      {
        actorId: OWNER,
        scopeId: personalScope(OWNER),
        aud: "control-plane",
        liveActor: true,
        threadRef: "owner-dm",
        runId: run.id,
        exp: Date.now() + 60_000,
        ...over,
      },
      SECRET,
    );
  const appToken = await token({ aud: "credential-broker", deployment: deployment.id, credentials: [] });
  const call = (path: string, cap: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bindings = (cap: string, value?: unknown) => call(`/v1/deployments/${deployment.id}/credentials`, cap, value);
  const broker = (cap = appToken, body: Record<string, unknown> = {}) =>
    call("/v1/credentials/broker", cap, {
      credential: credential.id,
      url: "https://api.example.com/v1/data",
      ...body,
    });
  return {
    records,
    backing,
    deployStore,
    deployment,
    credential,
    binding,
    keychain,
    runs,
    run,
    identity,
    acl,
    audit,
    upstreamCalls,
    token,
    appToken,
    call,
    bindings,
    broker,
    close: async () => {
      await close(server);
      await close(upstream);
    },
  };
}

test("owner-approved multi-header bindings reach HTTP upstream, stay out of responses, and revoke an already-issued token", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.broker()).status, 404);
  const ownerToken = await f.token();
  const granted = await f.bindings(ownerToken, { credentialBindings: [f.binding] });
  assert.equal(granted.status, 200, await granted.text());
  const listed = await f.bindings(ownerToken);
  assert.deepEqual(await listed.json(), { credentialBindings: [f.binding] });
  const response = await f.broker(f.appToken, {
    method: "POST",
    body: "request body",
    headers: { "x-token-secret": "attacker", Authorization: "attacker", "content-type": "text/plain" },
    ownerId: OTHER,
    deployment: "other",
  });
  assert.equal(response.status, 200);
  const result = await response.text();
  assert.match(result, /provider-result/);
  assert.doesNotMatch(result, /fake-token/);
  assert.equal(f.upstreamCalls.length, 1);
  assert.equal(f.upstreamCalls[0]!.headers["x-token-id"], "fake-token-identity");
  assert.equal(f.upstreamCalls[0]!.headers["x-token-secret"], "fake-token-secret");
  assert.equal(f.upstreamCalls[0]!.headers.authorization, undefined);
  assert.equal(f.upstreamCalls[0]!.body, "request body");
  assert.equal((await f.bindings(ownerToken, { credentialBindings: [] })).status, 200);
  await f.deployStore.addVersion(f.deployment.id, { entrypoint: "v2", snapshotDir: "/v2" });
  await f.deployStore.setCurrentVersion(f.deployment.id, 1);
  assert.equal((await f.broker()).status, 404);
  assert.equal(f.upstreamCalls.length, 1);
  assert.ok(f.audit.some((e) => e.action === "credential.broker.denied" && e.detail?.includes(f.deployment.id)));
  assert.doesNotMatch(JSON.stringify(await f.backing.all()), /fake-token/);
});

test("control plane requires verified live personal owner consent and rejects app tokens", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const over of [
    { actorId: OTHER, scopeId: personalScope(OTHER) },
    { triggered: true },
    { liveActor: false },
    { scopeId: scopeId("channel", "room") },
    { threadRef: "another-thread" },
    { runId: "missing" },
    { aud: "credential-broker", deployment: f.deployment.id },
  ]) {
    const cap = await f.token(over);
    assert.equal((await f.bindings(cap, { credentialBindings: [f.binding] })).status, 403, JSON.stringify(over));
    assert.equal((await f.bindings(cap)).status, 403, JSON.stringify(over));
  }
  assert.equal((await f.call("/v1/keychain", f.appToken)).status, 403);
  assert.equal((await f.call("/v1/keychain/use", f.appToken, { credential: f.credential.id })).status, 403);
  assert.equal((await f.call("/v1/deployments", f.appToken)).status, 403);
  await f.runs.withdraw(f.run.id);
  assert.equal((await f.bindings(await f.token(), { credentialBindings: [f.binding] })).status, 403);
});

test("bindings reject malformed routes, headers, fields, delegated ownership and unsupported credentials", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const token = await f.token();
  const bad: Array<Record<string, unknown>> = [
    ...[
      "https://api.example.com",
      "api.example.com:443",
      "user@api.example.com",
      "*.example.com",
      "api.example.com/",
      "api.example.com.",
      "api..example.com",
      "api.example.com\r\nx: y",
    ].map((host) => ({ host })),
    ...[[], ["TRACE"], ["get"], ["GET\r\n"]].map((allowedMethods) => ({ allowedMethods })),
    ...[[], ["v1"], ["//v1"], ["/v1/../"], ["/v1/%252e%252e"], ["/v1?x"]].map((allowedPathPrefixes) => ({
      allowedPathPrefixes,
    })),
    ...[
      "host",
      "x-qm-actor",
      "content-length",
      "connection",
      "transfer-encoding",
      "cookie",
      "x-arbitrary",
      "x-token-id\r\n",
    ].map((name) => ({ headers: [{ name, field: "TOKEN_ID" }] })),
    { ownerId: OTHER },
    { secret: "must-not-persist" },
    { headers: [] },
    { headers: [{ name: "x-token-id", field: "UNKNOWN" }] },
    { headers: [{ name: "x-token-id" }] },
    { headers: [{ name: "x-token-id", field: "TOKEN_ID", scheme: "Bearer\r\nx: y" }] },
    {
      headers: [
        { name: "x-token-id", field: "TOKEN_ID" },
        { name: "X-TOKEN-ID", field: "TOKEN_SECRET" },
      ],
    },
    {
      headers: [
        { name: "x-token-id", field: "TOKEN_ID" },
        { name: "x-token-secret", field: "TOKEN_ID" },
      ],
    },
    { host: "different.example.com" },
  ];
  for (const patch of bad) {
    const response = await f.bindings(token, { credentialBindings: [{ ...f.binding, ...patch }] });
    assert.ok([400, 403].includes(response.status), JSON.stringify(patch));
  }
  for (const body of [
    null,
    [],
    {},
    { credentialBindings: null },
    { credentialBindings: [f.binding, f.binding] },
    { credentialBindings: [], ownerId: OWNER },
  ]) {
    assert.equal((await f.bindings(token, body)).status, 400, JSON.stringify(body));
  }
  for (const patch of [
    { ownerId: OTHER },
    { kind: "file" as const },
    { managed: "connector" as const },
    { expiresAt: Date.now() - 1 },
  ]) {
    const original = (await f.records.get(f.credential.id))!;
    await f.records.merge(f.credential.id, patch);
    assert.ok([400, 403].includes((await f.bindings(token, { credentialBindings: [f.binding] })).status));
    await f.records.put(original.id, original);
  }
  for (const home of [personalScope(OTHER), scopeId("channel", "room"), scopeId("team", "team")]) {
    await f.deployStore.setOwnerScope(f.deployment.id, home);
    assert.equal((await f.bindings(token, { credentialBindings: [f.binding] })).status, 403);
  }
});

test("live broker rechecks app identity, bindings, credential metadata, host, paths and methods", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.bindings(await f.token(), { credentialBindings: [f.binding] })).status, 200);
  for (const url of [
    "http://api.example.com/v1/data",
    "https://child.api.example.com/v1/data",
    "https://evil.example.com/v1/data",
    "https://api.example.com:444/v1/data",
    "https://user@api.example.com/v1/data",
    "https://api.example.com/v1/database",
    "https://api.example.com/v1/data/../other",
    "https://api.example.com/v1/data/%2e%2e/other",
    "https://api.example.com/v1/data/%252e%252e/other",
    "https://api.example.com/v1/data/a%2fb",
    "https://api.example.com/v1/data#fragment",
    "https://api.example.com/v1/data/a%255cb",
    "https://api.example.com/v1/data/a\\..\\other",
  ])
    assert.equal((await f.broker(f.appToken, { url })).status, 403, url);
  assert.equal((await f.broker(f.appToken, { method: "DELETE" })).status, 403);
  assert.equal((await f.broker(f.appToken, { headers: { "X-QM-Actor": OTHER } })).status, 400);
  const second = await f.deployStore.create({
    ownerScopeId: personalScope(OWNER),
    createdBy: OWNER,
    entrypoint: "x",
    snapshotDir: "/x",
  });
  await f.deployStore.setStatus(second.id, "running");
  assert.equal(
    (await f.broker(await f.token({ aud: "credential-broker", deployment: second.id, credentials: [f.credential.id] })))
      .status,
    404,
  );
  assert.equal(
    (await f.broker(await f.token({ aud: "credential-broker", credentials: [f.credential.id] }))).status,
    404,
  );
  assert.equal(
    (await f.broker(await f.token({ aud: "credential-broker", actorId: OTHER, deployment: f.deployment.id }))).status,
    401,
  );
  const original = (await f.records.get(f.credential.id))!;
  for (const patch of [
    { ownerId: OTHER },
    { expiresAt: Date.now() - 1 },
    { kind: "file" as const },
    { managed: "connector" as const },
    { host: "other.example.com" },
    { fields: [{ envKey: "UNKNOWN", secret: true }] },
  ]) {
    await f.records.merge(original.id, patch);
    assert.equal((await f.broker()).status, 404, JSON.stringify(patch));
    await f.records.put(original.id, original);
  }
  await f.deployStore.setCredentialBindings(
    f.deployment.id,
    [{ ...f.binding, headers: [{ name: "host", field: "TOKEN_ID" }] }],
    (await f.deployStore.get(f.deployment.id))!,
  );
  assert.equal((await f.broker()).status, 404);
  await f.deployStore.setCredentialBindings(f.deployment.id, [f.binding], (await f.deployStore.get(f.deployment.id))!);
  await f.records.delete(original.id);
  assert.equal((await f.broker()).status, 404);
  await f.records.put(original.id, original);
  await f.deployStore.setOwnerScope(f.deployment.id, personalScope(OTHER));
  assert.equal((await f.broker()).status, 404);
  await f.deployStore.setOwnerScope(f.deployment.id, personalScope(OWNER));
  assert.equal((await f.broker()).status, 404);
  await f.deployStore.setCredentialBindings(f.deployment.id, [f.binding], (await f.deployStore.get(f.deployment.id))!);
  await f.deployStore.setStatus(f.deployment.id, "archived");
  assert.equal((await f.broker()).status, 401);
  await f.deployStore.setStatus(f.deployment.id, "running");
  assert.equal((await f.broker()).status, 404);
  assert.equal(f.upstreamCalls.length, 0);
});

test("scalar bindings support schemes, reject control characters, and org calls retain their frozen ceiling plus live ACL", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const scalar = await f.keychain.save({
    ownerId: OWNER,
    service: "scalar",
    envKey: "API_TOKEN",
    secret: "fake-scalar",
  });
  const binding = { ...f.binding, credentialId: scalar.id, headers: [{ name: "Authorization", scheme: "Bearer" }] };
  assert.equal((await f.bindings(await f.token(), { credentialBindings: [binding] })).status, 200);
  assert.equal((await f.broker(f.appToken, { credential: scalar.id })).status, 200);
  assert.equal(f.upstreamCalls[0]!.headers.authorization, "Bearer fake-scalar");
  await f.keychain.save({ ownerId: OWNER, service: "scalar", envKey: "API_TOKEN", secret: "fake\r\nx: bad" });
  assert.equal((await f.broker(f.appToken, { credential: scalar.id })).status, 404);
  const org = orgScope();
  await f.keychain.setServiceCredential(org, {
    slug: "org-api",
    name: "Org API",
    secret: "fake-org",
    host: "api.example.com",
    deployments: true,
  });
  await f.acl.grant({
    ownerScopeId: org,
    ref: encodeRef(serviceCredRef("org-api")),
    granteeScopeId: org,
    permission: "read",
    grantedBy: OWNER,
  });
  const orgToken = await f.token({ aud: "credential-broker", deployment: f.deployment.id, credentials: ["org-api"] });
  assert.equal((await f.broker(f.appToken, { credential: "org-api" })).status, 404);
  assert.equal((await f.broker(orgToken, { credential: "org-api" })).status, 200);
  await f.acl.revoke(org, encodeRef(serviceCredRef("org-api")), org, OWNER);
  assert.equal((await f.broker(orgToken, { credential: "org-api" })).status, 404);
  assert.equal(
    (await f.broker(await f.token({ aud: "credential-broker", credentials: ["org-api"] }), { credential: "org-api" }))
      .status,
    200,
  );
  await f.keychain.setServiceCredential(org, {
    slug: f.credential.id,
    name: "Collision",
    secret: "fake-collision",
    host: "api.example.com",
    deployments: true,
  });
  await f.acl.grant({
    ownerScopeId: org,
    ref: encodeRef(serviceCredRef(f.credential.id)),
    granteeScopeId: org,
    permission: "read",
    grantedBy: OWNER,
  });
  assert.equal(
    (
      await f.broker(
        await f.token({ aud: "credential-broker", deployment: f.deployment.id, credentials: [f.credential.id] }),
      )
    ).status,
    404,
  );
});

test("a delayed binding replacement cannot undo concurrent revoke, archive/restore, or transfer out and back", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const token = await f.token();
  for (const mutation of ["revoke", "archive", "transfer"]) {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getCredential = f.keychain.getCredential;
    f.keychain.getCredential = async (id) => {
      const result = await getCredential(id);
      entered();
      await resume;
      return result;
    };
    const pending = f.bindings(token, { credentialBindings: [f.binding] });
    await blocked;
    if (mutation === "revoke") {
      const response = await f.bindings(token, { credentialBindings: [] });
      assert.equal(response.status, 200);
    } else if (mutation === "archive") {
      await f.deployStore.setStatus(f.deployment.id, "archived");
      await f.deployStore.setStatus(f.deployment.id, "running");
    } else {
      await f.deployStore.setOwnerScope(f.deployment.id, personalScope(OTHER));
      await f.deployStore.setOwnerScope(f.deployment.id, personalScope(OWNER));
    }
    release();
    assert.equal((await pending).status, 409, mutation);
    f.keychain.getCredential = getCredential;
    assert.deepEqual((await f.deployStore.get(f.deployment.id))!.credentialBindings, []);
    assert.equal((await f.broker()).status, 404);
  }
});

test("credential rotation validates the metadata of the exact secret read", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.bindings(await f.token(), { credentialBindings: [f.binding] })).status, 200);
  const read = f.keychain.readOwnSecret;
  f.keychain.readOwnSecret = async (...args) => {
    await f.keychain.save({
      ownerId: OWNER,
      service: "paired-provider",
      host: "new.example.com",
      fields: [
        { envKey: "TOKEN_ID", value: "fake-new-id" },
        { envKey: "TOKEN_SECRET", value: "fake-new-secret" },
      ],
    });
    return read(...args);
  };
  assert.equal((await f.broker()).status, 404);
  assert.equal(f.upstreamCalls.length, 0);
});

test("deactivated actors and alternate broker routes deny app tokens with deployment audit attribution", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.bindings(await f.token(), { credentialBindings: [f.binding] })).status, 200);
  const git = await f.call("/v1/credentials/git/org-api/repo/info/refs", f.appToken);
  assert.equal(git.status, 403);
  await f.identity.deactivate(OWNER);
  assert.equal((await f.broker()).status, 401);
  assert.ok(
    f.audit.some(
      (event) =>
        event.action === "credential.broker.denied" &&
        event.detail === `principal_inactive deployment:${f.deployment.id}`,
    ),
  );
  assert.equal(f.upstreamCalls.length, 0);
});
