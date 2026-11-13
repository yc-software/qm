import "./support/auto-fake-sprites.ts";
import { settle } from "./support/settle.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { Webhook as StandardWebhook } from "standardwebhooks";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";

const SECRET = "core-signing-secret".repeat(3);
const HOOK_SECRET = "hook-secret";

function start(
  signingSecret?: string,
  publicUrl?: string,
): { base: string; built: ReturnType<typeof buildApp>; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "wh-")) }));
  const deps = { ...(publicUrl ? { publicUrl } : {}), webhookReceiver: built.webhookReceiver };
  const server = signingSecret
    ? createServer(built.app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), ...deps, signingSecret })
    : createInsecureTestServer(built.app, deps);
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
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

const regBody = () => JSON.stringify({ action: "triage", verification: { scheme: "github", secret: HOOK_SECRET } });

async function asU1(method: string, path: string, body: string): Promise<Record<string, string>> {
  const identity = await mintPortalIdentity({ p: "U1", exp: Date.now() + 60_000 }, SECRET);
  return { ...sign(method, path, body), [PORTAL_IDENTITY_HEADER]: identity };
}

test("register → list elides the secret; the inbound URL is returned", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: await asU1("POST", "/v1/webhooks", body),
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
      headers: await asU1("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(created.status, 200);
    const { webhook, url } = (await created.json()) as { webhook: { id: string }; url: string };
    assert.equal(url, `https://portal.example.com/v1/webhooks/incoming/${webhook.id}`);
  } finally {
    await srv.close();
  }
});

test("registration stamps the signed-in person as owner and creator, whatever the body names", async () => {
  const srv = start(SECRET);
  try {
    const body = JSON.stringify({
      ...JSON.parse(regBody()),
      ownerScopeId: "personal:U2",
      owner: "U2",
      createdBy: "U2",
    });
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: await asU1("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(res.status, 200);
    const { webhook } = (await res.json()) as { webhook: { ownerScopeId: string; owner: string; createdBy: string } };
    assert.deepEqual([webhook.ownerScopeId, webhook.owner, webhook.createdBy], ["personal:U1", "U1", "U1"]);
    const unsigned = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(unsigned.status, 401);
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
    const body = JSON.stringify({ action: "unsafe", verification: { scheme: "none" } });
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: await asU1("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(res.status, 400);
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
      headers: await asU1("POST", "/v1/webhooks", reg),
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
      headers: await asU1("POST", "/v1/webhooks", reg),
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
    const webhook = await srv.built.app.createWebhook({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "github", secret: HOOK_SECRET },
    });
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

test("signed webhook history enforces viewer permissions and links to an owner-readable worklog", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: await asU1("POST", "/v1/webhooks", body),
      body,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    for (const [suffix, status] of [
      ["?viewer=U1", 200],
      ["?viewer=U2", 404],
      ["", 404],
    ] as const) {
      const path = `/v1/webhooks/${webhook.id}/events${suffix}`;
      const res = await fetch(`${srv.base}${path}`, { headers: sign("GET", path, "") });
      assert.equal(res.status, status);
      if (status === 200) assert.deepEqual(await res.json(), { events: [] });
    }
    assert.equal((await fetch(`${srv.base}/v1/webhooks/${webhook.id}/events?viewer=U1`)).status, 401);
    const eventBody = JSON.stringify({ message: "agent message for worklog" });
    const accepted = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": githubSig(eventBody) },
      body: eventBody,
    });
    assert.equal(accepted.status, 202);
    const historyPath = `/v1/webhooks/${webhook.id}/events?viewer=U1`;
    let events: Array<{ sessionId?: string; payload: string }> = [];
    await settle(async () => {
      const history = await fetch(`${srv.base}${historyPath}`, { headers: sign("GET", historyPath, "") });
      ({ events } = (await history.json()) as { events: typeof events });
      return Boolean(events[0]?.sessionId);
    });
    assert.equal(events.length, 1);
    assert.ok(events[0]?.sessionId);
    assert.match(events[0]!.payload, /agent message for worklog/);
    const sessionPath = `/v1/sessions/${events[0]!.sessionId}?viewer=U1`;
    let worklog = "";
    await settle(async () => {
      const res = await fetch(`${srv.base}${sessionPath}`, { headers: sign("GET", sessionPath, "") });
      assert.equal(res.status, 200);
      worklog = JSON.stringify(await res.json());
      return /agent message for worklog/.test(worklog);
    });
    assert.match(worklog, /agent message for worklog/);
    const otherPath = `/v1/sessions/${events[0]!.sessionId}?viewer=U2`;
    assert.equal((await fetch(`${srv.base}${otherPath}`, { headers: sign("GET", otherPath, "") })).status, 404);
  } finally {
    await srv.close();
  }
});

test("a token webhook accepts its secret as a bearer header or on the URL, and nothing else", async () => {
  const srv = start();
  try {
    const webhook = await srv.built.app.createWebhook({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "token", secret: HOOK_SECRET },
    });
    const deliver = (n: number, query: string, authorization?: string) =>
      fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ alarm: n }),
      }).then((res) => res.status);
    assert.equal(await deliver(1, "", `Bearer ${HOOK_SECRET}`), 202);
    assert.equal(await deliver(2, `?token=${HOOK_SECRET}`), 202);
    assert.equal(await deliver(3, ""), 401);
    assert.equal(await deliver(4, "?token=wrong"), 401);
    assert.equal(await deliver(5, `?token=${HOOK_SECRET}`, "Bearer wrong"), 401);
    await settle(async () => (await deliver(1, "", `Bearer ${HOOK_SECRET}`)) === 200);
  } finally {
    await srv.close();
  }
});

test("a standard-webhooks webhook accepts a sender-signed request once and rejects a tampered body", async () => {
  const srv = start();
  try {
    const secret = `whsec_${Buffer.from("standard-webhooks-secret").toString("base64")}`;
    const webhook = await srv.built.app.createWebhook({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "standard-webhooks", secret },
    });
    await assert.rejects(
      srv.built.app.createWebhook({ ...webhook, verification: { scheme: "standard-webhooks", secret: "not base64!" } }),
      /standard-webhooks cannot use this secret/,
    );
    const sent = new Date();
    const eventBody = JSON.stringify({ type: "invoice.paid" });
    const deliver = (body: string) =>
      fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_1",
          "webhook-timestamp": String(Math.floor(sent.getTime() / 1000)),
          "webhook-signature": new StandardWebhook(secret).sign("msg_1", sent, eventBody),
        },
        body,
      });
    assert.equal((await deliver(eventBody)).status, 202);
    assert.equal((await deliver(JSON.stringify({ type: "invoice.refunded" }))).status, 401);
    await settle(async () => (await (await deliver(eventBody)).text()) === "duplicate");
  } finally {
    await srv.close();
  }
});
