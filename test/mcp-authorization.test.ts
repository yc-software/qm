import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent, fetch } from "undici";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createKeychain, type KeychainCredential, type ServiceCredentialInput } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService, type McpCallContext } from "../src/mcp/mcp-tool-service.ts";
import type { Principal } from "../src/types.ts";

const org = "org:test";
const alice: Principal = { id: "alice", type: "internal", teamIds: ["staff"] };
const bob: Principal = { id: "bob", type: "internal" };
const guest: Principal = { id: "guest", type: "guest" };
const context = (audience = [alice], scopeId = "personal:alice"): McpCallContext => ({
  audience,
  scopeId,
  orgScopeId: org,
  allInternal: true,
});

async function fixture(t: TestContext, auth: "bearer" | "client-credentials" = "bearer") {
  const dir = await mkdtemp(join(tmpdir(), "mcp-authorization-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(join(dir, "cert.pem"));
  let secret = "synthetic-secret-one";
  let calls = 0;
  let mints = 0;
  let requests = 0;
  let pauseToken: ((finish: () => void) => void) | undefined;
  let pause: ((finish: (fail?: boolean) => void) => void) | undefined;
  const remote = createServer({ key: await readFile(join(dir, "key.pem")), cert }, async (req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      mints++;
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "synthetic-client");
      assert.equal(form.get("client_secret"), secret);
      const finish = () => res.end(JSON.stringify({ access_token: `access-${secret}`, expires_in: 3600 }));
      if (pauseToken) {
        const pending = pauseToken;
        pauseToken = undefined;
        pending(finish);
      } else finish();
      return;
    }
    assert.equal(req.url, "/mcp");
    assert.equal(req.headers.authorization, `Bearer ${auth === "bearer" ? secret : `access-${secret}`}`);
    const rpc = JSON.parse(body);
    if (rpc.method === "tools/list") {
      res.end(JSON.stringify({ id: rpc.id, result: { tools: [{ name: "read", inputSchema: { type: "object" } }] } }));
      return;
    }
    assert.equal(rpc.method, "tools/call");
    calls++;
    const finish = (fail = false) =>
      res.end(
        JSON.stringify({
          id: rpc.id,
          ...(fail
            ? { error: { message: "protected-upstream-error" } }
            : { result: { content: [{ type: "text", text: "protected-result" }] } }),
        }),
      );
    if (pause) {
      const pending = pause;
      pause = undefined;
      pending(finish);
    } else finish();
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const dispatcher = new Agent({ connect: { ca: cert } });
  const keychain = createKeychain({
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("synthetic-encryption-key"),
  });
  const acl = createAclStore();
  const audit = createAuditLog();
  const servers = createMcpServerStore(createMemoryMap<McpServer>());
  const config: McpServer = {
    id: "test",
    name: "Test",
    url: `https://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`,
    auth,
    ...(auth === "client-credentials" ? { clientId: "synthetic-client" } : {}),
    serviceCredential: "test-mcp",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "admin",
  };
  const input: ServiceCredentialInput = {
    slug: "test-mcp",
    name: "Test MCP",
    secret,
    delivery: "broker",
    host: "127.0.0.1",
    allowedMethods: ["POST"],
    allowedPathPrefixes: ["/mcp", "/token"],
    enabled: true,
  };
  const setCredential = async (patch: Partial<ServiceCredentialInput> = {}) => {
    if (patch.secret) secret = patch.secret;
    await keychain.setServiceCredential(org, { ...input, secret, ...patch });
  };
  await setCredential();
  await servers.put(config);
  const service = createMcpToolService({
    servers,
    audit,
    acl,
    orgScopeId: org,
    serviceCreds: keychain,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher, redirect: "error" }),
  });
  t.after(async () => {
    service.close();
    await dispatcher.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await service.refresh();
  const grant = (granteeScopeId = "personal:alice") =>
    acl.grant({
      ownerScopeId: org,
      ref: "service-cred:test-mcp",
      granteeScopeId,
      permission: "read",
      grantedBy: "admin",
    });
  const revoke = (granteeScopeId = "personal:alice") =>
    acl.revoke(org, "service-cred:test-mcp", granteeScopeId, "admin");
  return {
    service,
    acl,
    audit,
    servers,
    config,
    keychain,
    grant,
    revoke,
    setCredential,
    stats: () => ({ calls, mints, requests }),
    pauseToken: () =>
      new Promise<() => void>((resolve) => {
        pauseToken = resolve;
      }),
    pause: () =>
      new Promise<(fail?: boolean) => void>((resolve) => {
        pause = resolve;
      }),
  };
}

for (const auth of ["bearer", "client-credentials"] as const) {
  test(`real HTTPS ${auth}: service credential grants govern exposure, calls, cached auth, rotation and revocation`, async (t) => {
    const f = await fixture(t, auth);
    assert.equal(f.service.toolDefs().length, 1); // admin inventory, not agent exposure
    assert.deepEqual(await f.service.authorizedToolDefs(context()), []);
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), /not authorized/);
    assert.equal((await f.audit.tail({ limit: 1, action: "mcp.call" }))[0]?.status, "denied");
    await f.grant();
    assert.deepEqual(await f.keychain.materializeOwn("alice"), []);
    assert.deepEqual(await f.keychain.materializeStanding("personal:alice"), []);
    assert.equal((await f.service.authorizedToolDefs(context())).length, 1);
    assert.equal(await f.service.call("test_read", {}, "alice", context()), "protected-result");
    const before = f.stats();
    await f.revoke();
    assert.deepEqual(await f.service.authorizedToolDefs(context()), []);
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), /not authorized/);
    assert.deepEqual(f.stats(), before);
    await f.grant();
    await f.setCredential({ secret: "synthetic-secret-two" });
    assert.equal(await f.service.call("test_read", {}, "alice", context()), "protected-result");
    if (auth === "client-credentials") assert.ok(f.stats().mints > before.mints);
    await f.setCredential({ enabled: false });
    assert.deepEqual(await f.service.authorizedToolDefs(context()), []);
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), /unavailable/);
    await f.setCredential();
    await f.keychain.deleteServiceCredential(org, "test-mcp");
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), /unavailable/);
    assert.deepEqual(await f.keychain.materializeOwn("alice"), []);
    assert.deepEqual(await f.keychain.materializeStanding("personal:alice"), []);
  });
}

test("audience floor uses existing personal/team/channel/org grants and never bypasses internal-only delivery", async (t) => {
  const f = await fixture(t);
  for (const target of ["personal:alice", "team:staff", "channel:room", org]) {
    await f.grant(target);
    assert.equal((await f.service.authorizedToolDefs(context([alice], "channel:room"))).length, 1);
    for (const denied of [
      context([]),
      context([alice, guest], "channel:room"),
      { ...context(), allInternal: false },
      { ...context(), orgScopeId: "org:other" },
    ]) {
      assert.deepEqual(await f.service.authorizedToolDefs(denied), []);
      await assert.rejects(f.service.call("test_read", {}, "alice", denied), /not authorized/);
    }
    await assert.rejects(f.service.call("test_read", {}, "alice"), /not authorized/);
    await f.revoke(target);
  }
  await f.grant();
  assert.deepEqual(await f.service.authorizedToolDefs(context([alice, bob], "channel:room")), []);
  assert.deepEqual(f.stats().calls, 0);
});

test("revocation during success or upstream error suppresses both protected payloads", async (t) => {
  const f = await fixture(t, "client-credentials");
  for (const fail of [false, true]) {
    await f.grant();
    const started = f.pause();
    const call = f.service.call("test_read", {}, "alice", context());
    const rejection = assert.rejects(call, (error: Error) => {
      assert.match(error.message, /not authorized/);
      assert.doesNotMatch(error.message, /protected-/);
      return true;
    });
    const finish = await started;
    await f.revoke();
    finish(fail);
    await rejection;
    assert.equal((await f.audit.tail({ limit: 1, action: "mcp.call" }))[0]?.status, "denied");
  }
});

test("cached MCP clients retain live broker host/path/method checks and reject incompatible credential delivery", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await f.service.call("test_read", {}, "alice", context());
  const before = f.stats();
  for (const [patch, message] of [
    [{ host: "other.example" }, /host_not_allowed/],
    [{ allowedPathPrefixes: ["/other"] }, /path_not_allowed/],
    [{ allowedMethods: ["GET"] }, /method_not_allowed/],
    [{ delivery: "env", envKey: "TEST_MCP_SECRET" }, /unavailable/],
    [{ injection: { actor: true } }, /unavailable/],
  ] as const) {
    await f.setCredential(patch as Partial<ServiceCredentialInput>);
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), message);
    assert.deepEqual(f.stats(), before);
  }
});

test("client-secret token mint respects broker target policy before sending any secret", async (t) => {
  const f = await fixture(t, "client-credentials");
  await f.grant();
  const before = f.stats();
  await f.setCredential({ allowedPathPrefixes: ["/mcp"] });
  await assert.rejects(f.service.call("test_read", {}, "alice", context()), /path_not_allowed/);
  assert.deepEqual(f.stats(), before);
});

test("revocation during OAuth token mint prevents the subsequent tools/call request", async (t) => {
  const f = await fixture(t, "client-credentials");
  await f.grant();
  const started = f.pauseToken();
  const call = f.service.call("test_read", {}, "alice", context());
  const rejected = assert.rejects(call, /not authorized/);
  const finish = await started;
  await f.revoke();
  finish();
  await rejected;
  assert.equal(f.stats().calls, 0);
});

test("registry changes invalidate tool metadata and stale catalog refresh cannot republish it", async (t) => {
  const servers = createMcpServerStore(createMemoryMap<McpServer>());
  const config: McpServer = {
    id: "test",
    name: "Test",
    url: "https://old.example/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "admin",
  };
  await servers.put(config);
  const pending: Array<() => void> = [];
  const service = createMcpToolService({
    servers,
    fetchImpl: async (url) => {
      if (url.includes("old.example")) await new Promise<void>((resolve) => pending.push(resolve));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            result: {
              tools: [
                {
                  name: url.includes("old.example") ? "private_old" : "current",
                  inputSchema: { type: "object" },
                },
              ],
            },
          }),
      };
    },
  });
  t.after(() => service.close());
  const oldRefresh = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await servers.put({ ...config, url: "https://new.example/mcp" });
  assert.deepEqual(service.toolDefs(), []);
  await service.refresh();
  for (const resolve of pending) resolve();
  await oldRefresh;
  assert.deepEqual(
    (await service.authorizedToolDefs(context())).map((d) => d.name),
    ["test_current"],
  );
  await assert.rejects(service.call("test_private_old", {}, "alice", context()), /unknown MCP tool/);
});

test("tool exposure discards an ACL decision if the registry changes while it is pending", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const original = f.acl.grantsOfKind;
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  f.acl.grantsOfKind = async (...args) => {
    const result = await original(...args);
    entered();
    await release;
    return result;
  };
  const exposure = f.service.authorizedToolDefs(context());
  await started;
  await f.keychain.setServiceCredential(org, {
    slug: "private-new",
    name: "Private",
    delivery: "broker",
    host: "127.0.0.1",
    secret: "synthetic-secret-one",
    allowedMethods: ["POST"],
    allowedPathPrefixes: ["/mcp"],
  });
  await f.servers.put({ ...f.config, serviceCredential: "private-new" });
  await f.service.refresh();
  unblock();
  assert.deepEqual(await exposure, []);
});

test("client credentials accept serialized default injection but reject custom injection and actor", async (t) => {
  const f = await fixture(t, "client-credentials");
  await f.grant();
  for (const injection of [
    {},
    { header: "Authorization", scheme: "Bearer " },
    { header: "aUtHoRiZaTiOn", scheme: "Bearer" },
    { header: "authorization" },
    { scheme: "Bearer" },
  ]) {
    await f.setCredential({ injection });
    assert.equal(await f.service.call("test_read", {}, "alice", context()), "protected-result");
  }
  const before = f.stats();
  for (const injection of [
    { header: "X-API-Key", scheme: "Bearer" },
    { scheme: "Basic" },
    { scheme: "" },
    { scheme: "Bearer  " },
    { actor: true, header: "Authorization", scheme: "Bearer" },
  ]) {
    await f.setCredential({ injection });
    assert.deepEqual(await f.service.authorizedToolDefs(context()), []);
    await assert.rejects(f.service.call("test_read", {}, "alice", context()), /unavailable/);
    assert.deepEqual(f.stats(), before);
  }
});
