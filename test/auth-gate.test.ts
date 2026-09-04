import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "test-signing-secret".repeat(3);

test("the normal server refuses to start without source-auth material", () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "auth-required-")) }));
  assert.throws(() => createServer(built.app), /CORE_SIGNING_SECRET must be at least 32 characters/);
});

function start(signingSecret?: string): { base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "auth-")),
    }),
  );
  const server = signingSecret ? createServer(built.app, { signingSecret }) : createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

const turnBody = (actorId: string) =>
  JSON.stringify({
    surface: "test",
    actor: { externalId: actorId },
    conversation: { kind: "dm", threadRef: `t-${actorId}` },
    text: "hello",
  });

test("with a signing secret, an UNSIGNED turn is rejected 401 (no impersonation)", async () => {
  const srv = start(SECRET);
  try {
    const res = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: turnBody("U-attacker"),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a FORGED actor whose body differs from what was signed is rejected", async () => {
  const srv = start(SECRET);
  try {
    const headers = sign("POST", "/v1/turns", turnBody("U-real"));
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body: turnBody("U-ceo") });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a non-numeric x-timestamp is rejected even when the signature matches the NaN canonical string", async () => {
  const srv = start(SECRET);
  try {
    const body = turnBody("U1");
    const headers = {
      "content-type": "application/json",
      "x-timestamp": "not-a-number",
      "x-signature": signRequest(SECRET, Number.NaN, `POST\n/v1/turns\n${body}`),
    };
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a correctly-signed turn is accepted", async () => {
  const srv = start(SECRET);
  try {
    const body = turnBody("U1");
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers: sign("POST", "/v1/turns", body), body });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  } finally {
    await srv.close();
  }
});

test("a signature for one route can't be replayed against another (method+path bound)", async () => {
  const srv = start(SECRET);
  try {
    const headers = sign("GET", "/v1/deliveries?type=slack", "");
    const res = await fetch(`${srv.base}/v1/sessions?principalId=U-victim`, { headers });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a replayed signature is rejected (dedup) on a mutating route", async () => {
  const srv = start(SECRET);
  try {
    const body = turnBody("U1");
    const headers = sign("POST", "/v1/turns", body);
    const first = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    const replay = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(replay.status, 401);
  } finally {
    await srv.close();
  }
});

test("an identical signed GET re-sent in the same second is accepted (reads are not replay-deduped)", async () => {
  const srv = start(SECRET);
  try {
    const headers = sign("GET", "/v1/deliveries?type=slack", "");
    const first = await fetch(`${srv.base}/v1/deliveries?type=slack`, { headers });
    assert.equal(first.status, 200);
    const second = await fetch(`${srv.base}/v1/deliveries?type=slack`, { headers });
    assert.equal(second.status, 200);
  } finally {
    await srv.close();
  }
});

test("deployment ingress /d/:id is rejected 401 without a valid signature", async () => {
  const srv = start(SECRET);
  try {
    const res = await fetch(`${srv.base}/d/some-id/`, { headers: { "x-as-principal": "U-attacker" } });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("the explicit insecure test server leaves the boundary open", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: turnBody("U1"),
    });
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test("POST /v1/blobs requires x-content-sha256 when authed, then binds the body (spec §13)", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "blobauth-")) }));
  const server = createServer(built.app, { signingSecret: SECRET, blobTransfer: built.blobTransfer });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const body = Buffer.from("payload bytes");
    const sha = createHash("sha256").update(body).digest("hex");
    const tsA = Math.floor(Date.now() / 1000);
    const noSha = await fetch(`${base}/v1/blobs`, {
      method: "POST",
      headers: { "x-timestamp": String(tsA), "x-signature": signRequest(SECRET, tsA, "POST\n/v1/blobs\n") },
      body,
    });
    assert.equal(noSha.status, 400);
    const tsB = Math.floor(Date.now() / 1000);
    const ok = await fetch(`${base}/v1/blobs`, {
      method: "POST",
      headers: {
        "x-content-sha256": sha,
        "x-timestamp": String(tsB),
        "x-signature": signRequest(SECRET, tsB, `POST\n/v1/blobs\n${sha}`),
      },
      body,
    });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("egress-audit ingest requires source auth: unsigned is 401, signed lands — including under portal-identity enforcement", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "auth-egress-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    egressAudit: built.egressAudit,
    requireSignedPortalIdentity: true,
    capabilitySecret: `${SECRET}-cap`,
    portalIdentitySecret: `${SECRET}-portal`,
  });
  server.listen(0);
  const srv = {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  try {
    const body = JSON.stringify({ records: [{ host: "api.github.com", verdict: "ok", scopeLabel: "personal:U1" }] });
    const unsigned = await fetch(`${srv.base}/v1/egress-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);
    const signed = await fetch(`${srv.base}/v1/egress-audit`, {
      method: "POST",
      headers: sign("POST", "/v1/egress-audit", body),
      body,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { accepted: 1, rejected: 0 });
  } finally {
    await srv.close();
  }
});
