import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, serverDeps, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

const SECRET = "memorable-route-secret-abcdefghijklmnop".repeat(2);

describe("memorable connect routes", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      TEST_CAPABILITY_SECRET,
    );

  const request = async (method: string, path: string, body?: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { "x-agent-capability": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    const config = testConfig({ signingSecret: SECRET, memorableEnabled: true });
    built = buildApp(config);
    await built.app.upsertDirectory([
      { principalId: "U1", displayName: "One", type: "internal" },
      { principalId: "U2", displayName: "Two", type: "internal" },
    ]);
    server = createServer(built.app, {
      ...serverDeps(config, built),
      signingSecret: SECRET,
      capabilitySecret: TEST_CAPABILITY_SECRET,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses every connect route without a capability token", async () => {
    for (const [method, path] of [
      ["POST", "/v1/memorable/connect"],
      ["GET", "/v1/memorable/connect"],
      ["DELETE", "/v1/memorable/connect"],
      ["POST", "/v1/memorable/consent"],
    ] as const) {
      const res = await request(method, path, method === "POST" ? { mode: "read-write" } : undefined);
      assert.notEqual(res.status, 200, `${method} ${path} answered 200 with no token`);
    }
  });

  it("refuses to start a sign-in for anyone but the caller", async () => {
    const res = await request("POST", "/v1/memorable/connect", { scope: "personal:U2" }, await capFor("U1"));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message?: string };
    assert.match(String(body.message), /only be started for yourself/);
  });

  it("refuses a scope named in the query string just the same", async () => {
    const res = await request("GET", "/v1/memorable/connect?scope=personal%3AU2", undefined, await capFor("U1"));
    assert.equal(res.status, 400);
  });

  it("refuses to set consent for another scope, including the org's", async () => {
    for (const scope of ["personal:U2", "org:acme", "channel:C1"]) {
      const res = await request("POST", "/v1/memorable/consent", { mode: "read-write", scope }, await capFor("U1"));
      assert.equal(res.status, 400, `consent for ${scope} was not refused`);
    }
  });

  it("answers for the caller's own scope, and reports nothing in flight", async () => {
    const res = await request("GET", "/v1/memorable/connect", undefined, await capFor("U1"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { scope: "personal:U1", status: "none" });
  });

  it("refuses a consent mode it does not recognise", async () => {
    const res = await request("POST", "/v1/memorable/consent", { mode: "enable" }, await capFor("U1"));
    assert.equal(res.status, 400);
  });

  it("never returns a key when listing accounts", async () => {
    const res = await request("GET", "/v1/memorable/accounts", undefined, await capFor("U1"));
    assert.equal(JSON.stringify(await res.json().catch(() => ({}))).includes("apiKey"), false);
  });
});
