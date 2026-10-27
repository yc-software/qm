import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "../../src/api/server.ts";
import { createPostgresBrokerSessions, type BrokerSessionStore } from "../../src/auth/broker-sessions.ts";
import { mintPortalIdentity } from "../../src/auth/portal-identity.ts";
import type { ReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { signRequest } from "../../src/auth/source-auth.ts";
import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";

const url = process.env.DATABASE_URL;

test(
  "broker sessions persist across instances, expire strictly, and revoke every remembered browser",
  { skip: !url },
  async () => {
    const a = createPostgresBrokerSessions(url!);
    const b = createPostgresBrokerSessions(url!);
    const pool = new pg.Pool({ connectionString: url });
    const email = `${randomUUID()}@example.com`;
    try {
      const first = await a.create(email, 30 * 86400, 90 * 86400);
      const second = await b.create(email, 30 * 86400, 90 * 86400);
      assert.equal((await b.use(first.token))?.authTime, first.authTime);
      const hash = createHash("sha256").update(first.token).digest("hex");
      const rows = await pool.query("SELECT token_hash FROM auth_broker_sessions WHERE email = $1", [email]);
      assert.equal(rows.rows.length, 2);
      assert.ok(rows.rows.some((row) => row.token_hash === hash));
      assert.ok(rows.rows.every((row) => row.token_hash !== first.token));
      await pool.query("UPDATE auth_broker_sessions SET expires_at = now() + interval '1 day' WHERE token_hash = $1", [
        hash,
      ]);
      assert.ok((await b.use(first.token))!.expiresAtMs > Date.now() + 29 * 86400000);
      await pool.query(
        "UPDATE auth_broker_sessions SET absolute_expires_at = now() + interval '1 hour' WHERE token_hash = $1",
        [hash],
      );
      const capped = await b.use(first.token);
      assert.ok(capped!.expiresAtMs <= Date.now() + 3600000);
      await pool.query(
        "UPDATE auth_broker_sessions SET absolute_expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [hash],
      );
      assert.equal(await a.use(first.token), null);
      await pool.query("UPDATE auth_broker_sessions SET expires_at = now() - interval '1 second' WHERE email = $1", [
        email,
      ]);
      assert.equal(await a.use(second.token), null);
      const third = await a.create(email, 30, 90);
      const fourth = await b.create(email, 30, 90);
      await a.revoke(email);
      assert.equal(await a.use(third.token), null);
      assert.equal(await b.use(fourth.token), null);
    } finally {
      await a.revoke(email);
      await pool.end();
    }
  },
);

const SECRET = "auth-broker-claim-test-secret".repeat(2);
const CLAIM_PATH = "/v1/auth/broker/claim";

function stubDedupe(): ReplayDedupe {
  const held = new Map<string, number>();
  return {
    async claim(eventId, expiresAtMs) {
      if ((held.get(eventId) ?? 0) > Date.now()) return false;
      held.set(eventId, expiresAtMs);
      return true;
    },
  };
}

function start(
  replayDedupe: ReplayDedupe = stubDedupe(),
  brokerSessions?: BrokerSessionStore,
): {
  base: string;
  dedupe: ReplayDedupe;
  close: () => Promise<void>;
} {
  const built: BuiltApp = buildApp(testConfig({ orgId: "acme" }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe,
    brokerSessions,
    requireSignedPortalIdentity: true,
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
): Promise<{ status: number; json: { claimed?: unknown; error?: unknown } }> {
  const path = `${CLAIM_PATH}?nonce=${crypto.randomUUID()}`;
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sign) {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = signRequest(SECRET, ts, `POST\n${path}\n${raw}`);
  }
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

test("the claim route refuses unsigned callers", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const unsigned = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() }, false);
  assert.equal(unsigned.status, 401);
});

test("a claim batch is bounded by the request body, not by a slot count or id length", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const slots = Array.from({ length: 65 }, (_, i) => `rate:wide:${i}`);
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:wide:0");
  const longId = `oidc:${"a".repeat(64)}:${"b".repeat(340)}`;
  assert.equal((await claim(srv.base, { ids: [longId], expiresAtMs: soon() })).json.claimed, longId);
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
  const srv = start(stubDedupe(), sessions);
  t.after(() => srv.close());
  const post = async (suffix: string, data: unknown, actor?: string, signed = true): Promise<Response> => {
    const path = `/v1/auth/broker/sessions${suffix}?nonce=${crypto.randomUUID()}`;
    const body = JSON.stringify(data);
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${srv.base}${path}`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        ...(signed
          ? { "x-timestamp": String(ts), "x-signature": signRequest(SECRET, ts, `POST\n${path}\n${body}`) }
          : {}),
        ...(actor
          ? {
              "x-portal-identity": await mintPortalIdentity({ p: actor, exp: Date.now() + 60000 }, SECRET + "identity"),
            }
          : {}),
      },
    });
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
