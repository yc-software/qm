import type { BrokerSessionStore } from "../src/auth/broker-sessions.ts";
import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { signedCoreHeaders } from "./support/signed-core.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testConfig } from "./support/test-config.ts";
import { bindTestTenant, OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";

bindTestTenant();

const SECRET = "auth-broker-claim-test-secret".repeat(2);
const CLAIM_PATH = "/v1/auth/broker/claim";

function durableStub(): ReplayDedupe {
  const held = new Map<string, number>();
  return {
    durable: true,
    async claim(eventId, expiresAtMs) {
      if ((held.get(eventId) ?? 0) > Date.now()) return false;
      held.set(eventId, expiresAtMs);
      return true;
    },
  };
}

function start(
  replayDedupe: ReplayDedupe = durableStub(),
  brokerSessions?: BrokerSessionStore,
): {
  base: string;
  dedupe: ReplayDedupe;
  close: () => Promise<void>;
} {
  const built: BuiltApp = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "auth-broker-claim-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe,
    brokerSessions,
    portalIdentitySecret: SECRET + "identity",
    capabilitySecret: SECRET + "capability",
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    dedupe: replayDedupe,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function claim(
  base: string,
  body: unknown,
  sign = true,
  tenant = TEST_TENANT,
): Promise<{ status: number; json: { claimed?: unknown; error?: unknown } }> {
  const path = `${CLAIM_PATH}?nonce=${crypto.randomUUID()}`;
  const raw = JSON.stringify(body);
  const json = { "content-type": "application/json" };
  const headers = sign ? await signedCoreHeaders(SECRET, "POST", path, raw, { tenant, headers: json }) : json;
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as { claimed?: unknown; error?: unknown } };
}

const soon = (): number => Date.now() + 60_000;

test("the broker claim route hands out each id exactly once", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const first = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() });
  assert.equal(first.status, 200);
  assert.equal(first.json.claimed, "link:abc");
  assert.deepEqual((await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() })).json, { claimed: null });
});

test("broker claim ids are namespaced per tenant", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  assert.equal((await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() })).json.claimed, "link:abc");
  const other = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() }, true, OTHER_TENANT);
  assert.equal(other.json.claimed, "link:abc", "another tenant's identical link id is its own nonce");
  assert.equal(
    (await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() }, true, OTHER_TENANT)).json.claimed,
    null,
  );
});

test("a batch claims the first free slot and reports exhaustion", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const slots = ["rate:e:h:1:0", "rate:e:h:1:1", "rate:e:h:1:2"];
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:0");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:1");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:2");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, null);
});

test("broker ids live in their own namespace and cannot poison another subsystem's nonces", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  assert.equal(
    (await claim(srv.base, { ids: ["oauth:shared-nonce"], expiresAtMs: soon() })).json.claimed,
    "oauth:shared-nonce",
  );
  assert.equal(
    await srv.dedupe.claim("oauth:shared-nonce", soon()),
    true,
    "the OAuth callback path must still be able to claim the unprefixed id",
  );
});

test("the claim route refuses to answer from a per-process replay store", async (t) => {
  const srv = start(createMemoryReplayDedupe());
  t.after(() => srv.close());
  const response = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() });
  assert.equal(response.status, 503, "a RAM-only dedupe cannot make a sign-in link single-use across instances");
  assert.equal(response.json.error, "not_configured");
});

test("the claim route refuses unsigned callers", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const unsigned = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() }, false);
  assert.equal(unsigned.status, 401);
});

test("the claim route validates its input", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const cases: unknown[] = [
    { ids: [], expiresAtMs: soon() },
    { ids: ["ok"], expiresAtMs: Date.now() - 1000 },
    { ids: ["ok"], expiresAtMs: Date.now() + 48 * 60 * 60 * 1000 },
    { ids: ["ok"] },
    { ids: ["ok"], expiresAtMs: "soon" },
    { ids: "ok", expiresAtMs: soon() },
    { ids: [""], expiresAtMs: soon() },
    { ids: [42], expiresAtMs: soon() },
    { ids: ["x".repeat(201)], expiresAtMs: soon() },
    { ids: Array.from({ length: 65 }, (_, i) => `slot-${i}`), expiresAtMs: soon() },
  ];
  for (const body of cases) {
    const response = await claim(srv.base, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(response.json.error, "bad_request");
  }
});

test("broker sessions cross the production identity gate, but revocation requires the owner", async (t) => {
  const revoked: string[] = [];
  const token = "a".repeat(43);
  const sessions: BrokerSessionStore = {
    async create(email) {
      return { token, email, authTime: 1, expiresAtMs: Date.now() + 60000 };
    },
    async use(value) {
      return value === token ? { email: "user@example.com", authTime: 1, expiresAtMs: Date.now() + 60000 } : null;
    },
    async revoke(email) {
      revoked.push(email);
    },
  };
  const srv = start(durableStub(), sessions);
  t.after(() => srv.close());
  const post = async (suffix: string, data: unknown, actor?: string, signed = true): Promise<Response> => {
    const path = `/v1/auth/broker/sessions${suffix}?nonce=${crypto.randomUUID()}`;
    const body = JSON.stringify(data);
    const base = { "content-type": "application/json" };
    const opts = { headers: base, identitySecret: SECRET + "identity", ...(actor ? { actor } : {}) };
    const headers = signed ? await signedCoreHeaders(SECRET, "POST", path, body, opts) : base;
    return fetch(`${srv.base}${path}`, { method: "POST", body, headers });
  };
  assert.equal((await post("", { email: "user@example.com", idleS: 30, absoluteS: 90 })).status, 200);
  assert.equal((await post("/use", { token })).status, 200);
  assert.equal((await post("", { email: "user@example.com", idleS: 30, absoluteS: 90 }, undefined, false)).status, 401);
  assert.equal((await post("", { email: "user@example.com", idleS: 91, absoluteS: 90 })).status, 400);
  assert.equal((await post("/revoke", { email: "user@example.com" })).status, 401);
  assert.notEqual((await post("/revoke", { email: "other@example.com" }, "user@example.com")).status, 200);
  assert.equal((await post("/revoke", { email: "user@example.com" }, "user@example.com")).status, 200);
  assert.deepEqual(revoked, ["user@example.com"]);
});
