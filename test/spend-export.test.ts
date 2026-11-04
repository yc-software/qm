import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, SPEND_EXPORT_AUD } from "../src/auth/capability-token.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const DAY = 86_400_000;
const sourceSecret = "source-only-secret".repeat(3);
const capabilitySecret = "capability-only-secret".repeat(3);
const TENANT = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";
const exportClaims = { actorId: "admin-alice", scopeId: "org:default-org", aud: SPEND_EXPORT_AUD };
const mintFor = (claims: Parameters<typeof mintCapabilityToken>[0]) =>
  withTenant(TENANT, () => mintCapabilityToken(claims, capabilitySecret));
const exportToken = await mintFor({ ...exportClaims, exp: Date.now() + DAY });
const today = Math.floor(Date.now() / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const window = `from=${iso(today - DAY)}&to=${iso(today + DAY)}`;

function fixture(options: { sessions?: SessionStore | null } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const url = testDatabaseUrl();
  const sessions = options.sessions === null ? undefined : (options.sessions ?? createPostgresSessionStore(url));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret,
    requireSignedPortalIdentity: true,
    admin: built.admin,
    auditLog: built.auditLog,
    ...(sessions ? { sessions } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${exportToken}` }) =>
    fetch(base + path, { headers });
  return { built, sessions, url, get, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("spend export: the token authorizes the export and nothing else", async () => {
  const s = fixture();
  try {
    for (const path of ["/v1/admin/spend", "/v1/admin/whoami", "/v1/admin/users", "/v1/background-work"]) {
      const res = await s.get(path);
      assert.equal(res.status, 401, path);
    }
  } finally {
    await s.close();
  }
});

test("spend export: an unavailable spend store is an error, not an empty export", async () => {
  const s = fixture({ sessions: null });
  try {
    assert.equal((await s.get(`/v1/spend/export?${window}`)).status, 503);
  } finally {
    await s.close();
  }
});
