import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testConfig } from "./support/test-config.ts";

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

function start(replayDedupe: ReplayDedupe = durableStub()): {
  base: string;
  dedupe: ReplayDedupe;
  close: () => Promise<void>;
} {
  const built: BuiltApp = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "auth-broker-claim-")), orgId: "acme" }),
  );
  const server = createServer(built.app, { signingSecret: SECRET, replayDedupe });
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
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sign) {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = signRequest(SECRET, ts, `POST\n${CLAIM_PATH}\n${raw}`);
  }
  const res = await fetch(`${base}${CLAIM_PATH}`, { method: "POST", headers, body: raw });
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
