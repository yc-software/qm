import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { isUserScoped } from "../src/api/user-scoped-routes.ts";

const SECRET = "source-auth-secret-for-run-query-tests-01";
const CAP = "core-only-capability-secret-for-tests-01";
const PID = "portal-only-identity-secret-for-tests-01";

describe("run queries authenticate with source auth under production portal enforcement", () => {
  let server: Server;
  let base: string;

  before(async () => {
    const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "run-query-auth-")) }));
    server = createServer(built.app, {
      signingSecret: SECRET,
      capabilitySecret: CAP,
      portalIdentitySecret: PID,
      requireSignedPortalIdentity: true,
      scheduler: built.scheduler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const signed = (method: string, pathWithQuery: string, body = "", secret = SECRET): Record<string, string> => {
    const ts = Math.floor(Date.now() / 1000);
    return {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": signRequest(secret, ts, `${method}\n${pathWithQuery}\n${body}`),
    };
  };

  const get = (pathWithQuery: string, headers?: Record<string, string>): Promise<Response> =>
    fetch(`${base}${pathWithQuery}`, { headers: headers ?? signed("GET", pathWithQuery) });

  it("reaches the handler for a single run instead of failing the portal gate", async () => {
    const res = await get("/v1/runs/run-that-does-not-exist");
    assert.notEqual(res.status, 401);
    assert.equal(res.status, 404);
  });

  it("reaches the handler for a thread lookup instead of failing the portal gate", async () => {
    const res = await get("/v1/runs?threadRef=surface%3Atenant%3Achat");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { runId: null });
  });

  it("still admits the system turn submission that surfaces already rely on", async () => {
    const path = "/v1/turns";
    const body = JSON.stringify({});
    const res = await fetch(`${base}${path}`, { method: "POST", headers: signed("POST", path, body), body });
    assert.notEqual(res.status, 401);
  });

  it("stays closed to an unsigned run query", async () => {
    assert.equal((await get("/v1/runs/any", { "content-type": "application/json" })).status, 401);
    assert.equal((await get("/v1/runs?threadRef=t", { "content-type": "application/json" })).status, 401);
  });

  it("stays closed to a run query signed with the wrong secret", async () => {
    const path = "/v1/runs/any";
    assert.equal((await get(path, signed("GET", path, "", PID))).status, 401);
  });

  it("keeps requiring a portal identity on routes that really are user scoped", async () => {
    const path = "/v1/sessions/nope?viewer=U1";
    assert.equal((await get(path)).status, 401);
    const token = await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, PID);
    assert.equal((await get(path, { ...signed("GET", path), "x-portal-identity": token })).status, 404);
  });

  it("classifies run queries as system rather than user scoped", () => {
    assert.equal(isUserScoped("GET", "/v1/runs/run-1"), false);
    assert.equal(isUserScoped("GET", "/v1/runs"), false);
    assert.equal(isUserScoped("GET", "/v1/sessions/s-1"), true);
    assert.equal(isUserScoped("GET", "/v1/memory"), true);
  });
});
