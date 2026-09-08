import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EGRESS_PROXY_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { scopeId } from "../src/types.ts";
import { buildEgressAuthzServer, createRelayStamper, type EgressStamper } from "../src/egress-authz-main.ts";
import { createEgressStampStore, type EgressStamp } from "../src/admin/egress-stamp-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const CAPABILITY_SECRET = "test-egress-capability-secret";
const OPEN_EGRESS = { allowedHosts: ["example.com"], deniedHosts: [] };

const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

function token(execId?: string): Promise<string> {
  return mintCapabilityToken(
    {
      actorId: "U_actor",
      scopeId: scopeId("personal", "U_actor"),
      aud: EGRESS_PROXY_AUD,
      exp: Date.now() + 60_000,
      egress: OPEN_EGRESS,
      ...(execId ? { execId } : {}),
    },
    CAPABILITY_SECRET,
  );
}

function check(port: number, authority: string, bearer: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        host: "127.0.0.1",
        path: "/",
        headers: { "x-egress-authority": authority, "proxy-authorization": `Bearer ${bearer}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function boot(stamps: EgressStamper) {
  const records: Array<{ host: string; allowed: boolean }> = [];
  const server = buildEgressAuthzServer({
    capabilitySecret: CAPABILITY_SECRET,
    audit: { record: (r) => void records.push({ host: r.host, allowed: r.allowed }) },
    lookup: async () => ["93.184.216.34"],
    stamps,
  });
  return { server, records };
}

test("the first allowed connection of an execution stamps it once; later connections and other executions are independent", async () => {
  const stamped: Array<{ execId: string; host: string; principalId: string }> = [];
  const { server } = boot({
    async stamp(execId, rec) {
      stamped.push({ execId, host: rec.host, principalId: rec.principalId });
    },
  });
  const port = await listen(server);
  try {
    const a = await token("exec-a");
    assert.equal(await check(port, "example.com:443", a), 200);
    assert.equal(await check(port, "example.com:443", a), 200);
    assert.equal(await check(port, "example.com:443", await token("exec-b")), 200);
    assert.equal(await check(port, "example.com:443", await token()), 200, "a turn token without execId still works");
    assert.deepEqual(stamped, [
      { execId: "exec-a", host: "example.com", principalId: "U_actor" },
      { execId: "exec-b", host: "example.com", principalId: "U_actor" },
    ]);
  } finally {
    await close(server);
  }
});

test("a denied host never stamps, and a stamp that cannot be recorded fails the connection closed", async () => {
  let calls = 0;
  const { server, records } = boot({
    async stamp() {
      calls++;
      throw new Error("core unreachable");
    },
  });
  const port = await listen(server);
  try {
    assert.equal(await check(port, "evil.invalid:443", await token("exec-denied")), 403);
    assert.equal(calls, 0, "policy denial happens before any stamp");
    assert.equal(await check(port, "example.com:443", await token("exec-c")), 403);
    assert.equal(calls, 1);
    assert.deepEqual(records.at(-1), { host: "example.com", allowed: false });
  } finally {
    await close(server);
  }
});

test("the stamp store answers has() only after a stamp and ignores duplicate stamps", async () => {
  const store = createEgressStampStore(createMemoryMap<EgressStamp>());
  assert.equal(await store.has("exec-1"), false);
  await store.stamp("exec-1", { scopeLabel: scopeId("personal", "U1"), principalId: "U1", host: "a.example" });
  await store.stamp("exec-1", { scopeLabel: scopeId("personal", "U1"), principalId: "U1", host: "b.example" });
  assert.equal(await store.has("exec-1"), true);
  assert.equal(await store.has("exec-2"), false);
});

test("the relay stamper posts a signed stamp to the core and surfaces a non-2xx as a failure", async () => {
  const seen: Array<{ url: string; body: unknown; signed: boolean }> = [];
  let status = 200;
  const stamper = createRelayStamper("https://core.test/", "relay-secret", (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.push({
      url,
      body: JSON.parse(String(init.body)),
      signed: Object.keys(headers).some((k) => /signature|source/i.test(k)),
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch);
  await stamper.stamp("exec-9", { scopeLabel: scopeId("personal", "U1"), principalId: "U1", host: "api.example" });
  assert.equal(seen[0]!.url, "https://core.test/v1/egress-stamp");
  assert.deepEqual(seen[0]!.body, {
    execId: "exec-9",
    scopeLabel: "personal:U1",
    principalId: "U1",
    host: "api.example",
  });
  assert.equal(seen[0]!.signed, true);
  status = 503;
  await assert.rejects(
    stamper.stamp("exec-10", { scopeLabel: scopeId("personal", "U1"), principalId: "U1", host: "api.example" }),
    /503/,
  );
});

test("the core ingests a signed stamp and rejects unsigned or malformed ones", async () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "egress-stamp-")) });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    egressStamps: built.egressStamps,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({
      execId: "exec-42",
      host: "api.example",
      scopeLabel: "personal:U1",
      principalId: "U1",
    });
    const signed = await fetch(base + "/v1/egress-stamp", {
      method: "POST",
      headers: signedRequestHeaders(config.signingSecret!, "POST", "/v1/egress-stamp", body, {
        "content-type": "application/json",
      }),
      body,
    });
    assert.equal(signed.status, 200);
    assert.equal(await built.egressStamps.has("exec-42"), true);

    const malformed = await fetch(base + "/v1/egress-stamp", {
      method: "POST",
      headers: signedRequestHeaders(config.signingSecret!, "POST", "/v1/egress-stamp", "{}", {
        "content-type": "application/json",
      }),
      body: "{}",
    });
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
