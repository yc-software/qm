import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SOURCE = "shared-source-auth-secret-for-tests-0001";
const CAP = "core-only-capability-secret-for-tests-01";

describe("capability tokens verify under the core-only capability secret, not the shared source-auth secret", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = async (secret: string) =>
    mintCapabilityToken(
      { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
      secret,
    );

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cap-iso-")), signingSecret: SOURCE }));
    server = createServer(built.app, { signingSecret: SOURCE, capabilitySecret: CAP, scheduler: built.scheduler });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const apis = (token: string) => fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": token } });

  it("accepts a capability signed with the capability secret", async () => {
    assert.equal((await apis(await cap(CAP))).status, 200);
  });

  it("rejects a capability forged with only the shared source-auth secret (what a surface holds)", async () => {
    assert.equal((await apis(await cap(SOURCE))).status, 401);
  });
});

describe("createServer refuses to boot enforcement that a surface could bypass", () => {
  let built: BuiltApp;
  before(() => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cap-failclosed-")), signingSecret: SOURCE }));
  });

  const boot = (extra: Record<string, unknown>) =>
    createServer(built.app, {
      signingSecret: SOURCE,
      scheduler: built.scheduler,
      requireSignedPortalIdentity: true,
      ...extra,
    });

  it("throws when CAPABILITY_SECRET is absent (it would fall back to the source secret)", () => {
    assert.throws(
      () => boot({ portalIdentitySecret: "portal-only-identity-secret-for-tests-01" }),
      /CAPABILITY_SECRET is not set/,
    );
  });

  it("throws when PORTAL_IDENTITY_SECRET is absent", () => {
    assert.throws(() => boot({ capabilitySecret: CAP }), /PORTAL_IDENTITY_SECRET is not set/);
  });

  it("throws when a split secret equals CORE_SIGNING_SECRET", () => {
    assert.throws(
      () => boot({ capabilitySecret: SOURCE, portalIdentitySecret: "portal-only-identity-secret-for-tests-01" }),
      /CAPABILITY_SECRET must differ/,
    );
    assert.throws(
      () => boot({ capabilitySecret: CAP, portalIdentitySecret: SOURCE }),
      /PORTAL_IDENTITY_SECRET must differ/,
    );
  });

  it("throws when portal identity and capability signing share a key", () => {
    assert.throws(
      () => boot({ capabilitySecret: CAP, portalIdentitySecret: CAP }),
      /PORTAL_IDENTITY_SECRET must differ from CAPABILITY_SECRET/,
    );
  });

  it("boots when both split secrets are present and distinct", () => {
    const server = boot({ capabilitySecret: CAP, portalIdentitySecret: "portal-only-identity-secret-for-tests-01" });
    assert.ok(server);
    server.close();
  });

  it("does not gate when enforcement is off, even with shared secrets", () => {
    const server = createServer(built.app, { signingSecret: SOURCE, scheduler: built.scheduler });
    assert.ok(server);
    server.close();
  });

  it("production refuses an unauthenticated core unless explicitly isolated", () => {
    assert.throws(
      () => createServer(built.app, { production: true, scheduler: built.scheduler }),
      /CORE_SIGNING_SECRET/,
    );
    const server = createServer(built.app, {
      production: true,
      allowUnauthenticatedCore: true,
      scheduler: built.scheduler,
    });
    server.close();
  });

  it("production enables signed-identity enforcement without a separate opt-in", () => {
    assert.throws(
      () => createServer(built.app, { production: true, signingSecret: SOURCE, scheduler: built.scheduler }),
      /CAPABILITY_SECRET is not set/,
    );
  });
});
