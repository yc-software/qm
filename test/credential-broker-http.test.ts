import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as httpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { realBrokerFetch } from "../src/api/credential-broker.ts";
import { testConfig } from "./support/test-config.ts";

const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("a broker-use capability cannot obtain an operator's key from an HTTP response reflection", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-reflection-"));
  const signingSecret = "isolated-http-fixture-signing-secret";
  const hiddenKey = "synthetic-operator-gate-key-0123456789";
  const handoffUrl = "https://app.example.test/connect?state=synthetic-user-handoff";
  const received: Array<{ authorization?: string; actor?: string }> = [];
  const upstream = httpServer((req, res) => {
    received.push({ authorization: req.headers.authorization, actor: req.headers["x-qm-actor"] as string });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ diagnostic: req.headers.authorization, continueAt: handoffUrl, message: "sign-in required" }),
    );
  });
  const upstreamOrigin = await listen(upstream);
  const built = buildApp(testConfig({ dataDir: root, signingSecret }));
  const keychain = built.keychain;
  assert.ok(keychain);
  const core = createServer(built.app, {
    signingSecret,
    serviceCreds: keychain,
    credentialUsage: built.credentialUsage,
    auditLog: built.auditLog,
    brokerFetch: async (url, init) => {
      const target = new URL(url);
      assert.equal(target.origin, "https://service.example.test");
      return realBrokerFetch(`${upstreamOrigin}${target.pathname}${target.search}`, init);
    },
  });
  const origin = await listen(core);
  const request = async (actorId: string, credentials: string[]) => {
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    const token = await mintCapabilityToken(
      { actorId, scopeId: `personal:${actorId}`, aud: "credential-broker", credentials, exp: Date.now() + 60_000 },
      signingSecret,
    );
    return fetch(`${origin}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({ credential: "service_fixture", url: "https://service.example.test/status" }),
    });
  };
  try {
    await keychain.setServiceCredential("org:default-org", {
      slug: "service_fixture",
      name: "Synthetic operator service",
      secret: hiddenKey,
      host: "service.example.test",
      delivery: "broker",
      injection: { actor: true },
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/status"],
      enabled: true,
    });
    assert.ok(!JSON.stringify(await keychain.listServiceCredentials("org:default-org")).includes(hiddenKey));
    const outsider = await request("synthetic-bob", []);
    assert.equal(outsider.status, 403);
    assert.equal(received.length, 0, "another actor without broker-use access cannot reach the provider");
    const alice = await request("synthetic-alice", ["service_fixture"]);
    const aliceResult = (await alice.json()) as { status: number; body: string };
    const bob = await request("synthetic-bob", ["service_fixture"]);
    const bobResult = (await bob.json()) as { status: number; body: string };
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    assert.deepEqual(received, [
      { authorization: `Bearer ${hiddenKey}`, actor: "synthetic-alice" },
      { authorization: `Bearer ${hiddenKey}`, actor: "synthetic-bob" },
    ]);
    for (const result of [aliceResult, bobResult]) {
      assert.equal(result.status, 401);
      assert.ok(!JSON.stringify(result).includes(hiddenKey), "use access must not become raw-secret disclosure");
      assert.deepEqual(JSON.parse(result.body), {
        diagnostic: "Bearer <redacted:credential>",
        continueAt: handoffUrl,
        message: "sign-in required",
      });
    }
    const controlToken = await mintCapabilityToken(
      { actorId: "synthetic-bob", scopeId: "personal:synthetic-bob", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
      signingSecret,
    );
    const wrongAudience = await fetch(`${origin}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": controlToken },
      body: "{}",
    });
    assert.equal(wrongAudience.status, 403);
  } finally {
    await close(core);
    await close(upstream);
    await built.runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
