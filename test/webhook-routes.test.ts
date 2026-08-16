import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);
const HOOK_SECRET = "hook-secret";

function start(signingSecret?: string, publicUrl?: string): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "wh-")) }));
  const deps = { ...(publicUrl ? { publicUrl } : {}), webhookReceiver: built.webhookReceiver };
  const server = signingSecret
    ? createServer(built.app, { ...deps, signingSecret })
    : createInsecureTestServer(built.app, deps);
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

const githubSig = (rawBody: string) => "sha256=" + createHmac("sha256", HOOK_SECRET).update(rawBody).digest("hex");

const regBody = (owner = "U1", createdBy = "U1") =>
  JSON.stringify({
    ownerScopeId: "personal:U1",
    owner,
    createdBy,
    action: "triage",
    verification: { scheme: "github", secret: HOOK_SECRET },
  });

test("register → list elides the secret; the inbound URL is returned", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(created.status, 200);
    const { webhook, url } = (await created.json()) as {
      webhook: { id: string; verification: { secret: string } };
      url: string;
    };
    assert.equal(url, `/v1/webhooks/incoming/${webhook.id}`);
    assert.equal(webhook.verification.secret, HOOK_SECRET);

    const listPath = "/v1/webhooks?viewer=U1";
    const listed = await fetch(`${srv.base}${listPath}`, { headers: sign("GET", listPath, "") });
    const { webhooks } = (await listed.json()) as { webhooks: Array<{ verification: { secret: string } }> };
    assert.equal(webhooks[0]?.verification.secret, "***");
  } finally {
    await srv.close();
  }
});

test("with a public base configured, the inbound URL is ABSOLUTE (publicly reachable, not the 6PN api base)", async () => {
  const srv = start(SECRET, "https://portal.example.com/");
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(created.status, 200);
    const { webhook, url } = (await created.json()) as { webhook: { id: string }; url: string };
    assert.equal(url, `https://portal.example.com/v1/webhooks/incoming/${webhook.id}`);
  } finally {
    await srv.close();
  }
});

test("registration is anti-escalation gated (different owner needs consent)", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody("U2", "U1");
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("registration requires core source-auth (unsigned → 401)", async () => {
  const srv = start(SECRET);
  try {
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: regBody(),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("registration rejects webhook configurations without a verifiable signature", async () => {
  const srv = start(SECRET);
  try {
    for (const verification of [{ scheme: "none" }, { scheme: "github" }]) {
      const body = JSON.stringify({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        action: "unsafe",
        verification,
      });
      const res = await fetch(`${srv.base}/v1/webhooks`, {
        method: "POST",
        headers: sign("POST", "/v1/webhooks", body),
        body,
      });
      assert.equal(res.status, 400);
    }
  } finally {
    await srv.close();
  }
});

test("inbound ingress is gated by the per-webhook signature, NOT core source-auth", async () => {
  const srv = start(SECRET);
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", reg),
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const eventBody = JSON.stringify({ action: "opened" });

    const ok = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": githubSig(eventBody),
        "x-github-delivery": "d-1",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(ok.status, 202);

    const bad = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "d-2",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(bad.status, 401);

    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await srv.close();
  }
});

test("an over-cap inbound body is rejected 413 by the upstream readRawBody, before deliver()", async () => {
  const srv = start(SECRET);
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", reg),
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const huge = "x".repeat(1_000_001);
    const res = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": githubSig(huge),
        "x-github-delivery": "d-big",
        "x-github-event": "issues",
      },
      body: huge,
    });
    assert.equal(res.status, 413);
  } finally {
    await srv.close();
  }
});

test("inbound per-webhook auth holds even in core dev mode (no core secret)", async () => {
  const srv = start();
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const eventBody = JSON.stringify({ action: "opened" });

    const forged = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "d-3",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(forged.status, 401);
  } finally {
    await srv.close();
  }
});
