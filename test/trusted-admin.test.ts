import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { trustedPrincipal } from "../plugins/portal/src/trusted-entry.ts";
import { provisionTrustedAdmin } from "../plugins/portal/src/trusted-admin.ts";

const signingSecret = "core-test-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);
const issuer = "https://identity.example.test";
function start(enabled = true) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "trusted-admin-")),
      orgId: "default-org",
      ...(enabled ? { trustedOidcAdminIssuer: issuer } : {}),
    }),
  );
  const server = createServer(built.app, {
    signingSecret,
    capabilitySecret: "capability-secret".repeat(3),
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
    replayDedupe: { ...createMemoryReplayDedupe(), durable: true },
    admin: built.admin,
    identity: built.identity,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    built,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function claims(overrides: Record<string, unknown> = {}) {
  return {
    purpose: "trusted-entry-admin",
    issuer,
    subject: "founder-7",
    org: "org:default-org",
    exp: Date.now() + 55_000,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}
async function send(base: string, payload: unknown, key = identitySecret, sourceSigned = true) {
  const path = `/v1/auth/trusted/admin?nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({ assertion: await mintSignedPayload(payload, key) });
  const ts = Math.floor(Date.now() / 1000);
  return fetch(base + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...(sourceSigned
        ? { "x-timestamp": String(ts), "x-signature": signRequest(signingSecret, ts, `POST\n${path}\n${body}`) }
        : {}),
    },
  });
}

test("portal provisioning creates a durable ordinary grant once and preserves existing grants", async (t) => {
  const s = start();
  t.after(s.close);
  const config = { core: s.base, signingSecret, identitySecret, org: "default-org", issuer };
  await Promise.all(Array.from({ length: 8 }, () => provisionTrustedAdmin(config, "founder-7")));
  const principal = { id: trustedPrincipal(issuer, "founder-7"), type: "internal" as const };
  assert.equal((await s.built.admin.adminStatusOf(principal)).isAdmin, true);
  const first = await s.built.admin.listGrants();
  await provisionTrustedAdmin(config, "founder-7");
  assert.deepEqual(await s.built.admin.listGrants(), first);
  assert.equal((await s.built.auditLog.events()).filter((e) => e.action === "grant.create").length, 1);
  assert.equal((await s.built.admin.adminStatusOf({ id: "founder-7", type: "internal" })).isAdmin, false);
  assert.equal((await s.built.admin.adminStatusOf({ id: "founder@example.test", type: "internal" })).isAdmin, false);
});

test("provisioning rejects forged, unrelated, expired, impersonated, and replayed assertions", async (t) => {
  const s = start();
  t.after(s.close);
  for (const invalid of [
    { purpose: "session" },
    { org: "org:other" },
    { issuer: "https://other.example.test" },
    { exp: Date.now() - 1 },
    { exp: Date.now() + 120_000 },
    { exp: null },
    { subject: "" },
    { subject: "x".repeat(256) },
    { subject: "\ud800" },
    { imp: "operator" },
    { jti: "" },
  ])
    assert.ok((await send(s.base, claims(invalid))).status >= 400, JSON.stringify(invalid));
  assert.equal((await send(s.base, claims(), signingSecret)).status, 403);
  assert.ok((await send(s.base, claims(), identitySecret, false)).status >= 400);
  assert.equal(
    (await send(s.base, { p: trustedPrincipal(issuer, "founder-7"), exp: Date.now() + 55_000 })).status,
    403,
  );
  assert.ok(!(await s.built.admin.listGrants()).some((g) => g.principalId.startsWith("oidc:")));
  const payload = claims();
  assert.equal((await send(s.base, payload)).status, 200);
  assert.equal((await send(s.base, payload)).status, 409);
});

test("provisioning needs core opt-in and never reactivates a deactivated founder", async (t) => {
  const disabled = start(false);
  t.after(disabled.close);
  assert.equal((await send(disabled.base, claims())).status, 403);
  const s = start();
  t.after(s.close);
  const id = trustedPrincipal(issuer, "founder-7");
  await s.built.identity.deactivate(id);
  assert.equal((await send(s.base, claims())).status, 403);
  assert.equal((await s.built.admin.adminStatusOf({ id, type: "internal" })).isAdmin, false);
});
