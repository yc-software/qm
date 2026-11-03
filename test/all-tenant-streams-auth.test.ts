import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testTenants } from "./support/test-tenants.ts";

const signingSecret = "core-test-secret".repeat(3);
const capabilitySecret = "capability-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);

test("only a source-signed service can open the all-tenant session-state and loop-item streams", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "streams-auth-")), orgId: "acme" }));
  const server = createServer(built.app, {
    signingSecret,
    capabilitySecret,
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [tenant] = testTenants();
  const capability = await withTenant(tenant, () =>
    mintCapabilityToken(
      { actorId: "alice", scopeId: scopeId("personal", "alice"), exp: Date.now() + 60_000 },
      capabilitySecret,
    ),
  );
  const identity = mintPortalIdentity({ p: "alice", t: tenant, exp: Date.now() + 60_000 }, identitySecret);
  const open = async (path: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const res = await fetch(base + path, { headers, signal: controller.signal });
    controller.abort();
    return res.status;
  };
  for (const stream of ["/v1/session-state/events", "/v1/loop-items/events"]) {
    for (const headers of [
      {},
      { "x-agent-capability": capability },
      { authorization: `Bearer ${capability}` },
      { [PORTAL_IDENTITY_HEADER]: identity, "x-qm-tenant": tenant },
    ])
      assert.equal(await open(stream, headers), 401, `${stream} ${Object.keys(headers).join(",")}`);
    const signed = withSourceAuthNonce(stream, signingSecret);
    assert.equal(await open(signed, signedHeaders(signingSecret, "GET", signed, "")), 200, stream);
  }
});
