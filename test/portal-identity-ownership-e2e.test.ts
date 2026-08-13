import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createCoreServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { testConfig } from "./support/test-config.ts";

const SOURCE_SECRET = "issue-304-source-secret-000000000001";
const CAPABILITY_SECRET = "issue-304-capability-secret-00000001";
const PORTAL_SECRET = "issue-304-portal-secret-000000000001";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};

test("portal identity ownership survives Slack sync and deactivation has an explicit recovery path", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "portal-identity-ownership-")) }));
  await built.identity.hydrate();
  const core = createCoreServer(built.app, {
    signingSecret: SOURCE_SECRET,
    capabilitySecret: CAPABILITY_SECRET,
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
    auditLog: built.auditLog,
  });
  const coreBase = await listen(core);

  process.env.CORE_API_URL = coreBase;
  process.env.CORE_SIGNING_SECRET = SOURCE_SECRET;
  process.env.PORTAL_IDENTITY_SECRET = PORTAL_SECRET;
  process.env.WEB_UI_PRINCIPALS = "portal@example.com";
  process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
  const { handler } = await import("../plugins/web-ui/server/index.ts");
  const surface = createHttpServer((req, res) => void handler(req, res));
  const surfaceBase = await listen(surface);
  const token = mintPortalIdentity({ p: "portal@example.com", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const headers = { [PORTAL_IDENTITY_HEADER]: token };

  try {
    await built.directory.replace([
      { principalId: "portal@example.com", displayName: "Portal User", type: "internal" },
    ]);
    await built.app.upsertDirectory([]);
    assert.equal((await fetch(`${surfaceBase}/me`, { headers })).status, 200);

    await built.identity.deactivate("portal@example.com", "directory-sync", "directory-sync");
    const blocked = await fetch(`${surfaceBase}/me`, { headers });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { reason?: string }).reason, "account_deactivated");

    await built.identity.reactivate("portal@example.com");
    assert.equal((await fetch(`${surfaceBase}/me`, { headers })).status, 200);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => surface.close(() => resolve())),
      new Promise<void>((resolve) => core.close(() => resolve())),
    ]);
  }
});
