import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "offboarding-secret".repeat(3);

const member = (principalId: string) => ({ principalId, displayName: principalId, type: "internal" as const });

describe("offboarding: directory sync and the /v1/principals routes drive deactivation (§3)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const signedPost = (path: string) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n`),
      },
    });
  };

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "offboarding-")),
        signingSecret: SECRET,
      }),
    );
    await built.identity.hydrate();
    server = createServer(built.app, { signingSecret: SECRET, identity: built.identity, auditLog: built.auditLog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a roster swap that drops a member deactivates them; reappearing reactivates", async () => {
    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");

    await built.app.upsertDirectory([member("U-stay")]);
    assert.equal(built.identity.classify("U-leave").type, "guest");
    assert.equal(built.identity.classify("U-stay").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.deactivate" && e.principalId === "U-leave"),
    );

    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.reactivate" && e.principalId === "U-leave"),
    );
  });

  it("configured service principals are seeded and survive roster replacement", async () => {
    const servicePrincipal = member("agent@example.com");
    const configured = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "service-principal-")),
        servicePrincipals: [{ ...servicePrincipal, displayName: "Configured Agent" }],
      }),
    );
    await configured.identity.hydrate();

    assert.deepEqual(await configured.directory.list(), [{ ...servicePrincipal, displayName: "Configured Agent" }]);

    await configured.app.upsertDirectory([member("U-human"), { ...servicePrincipal, displayName: "Roster Name" }]);
    assert.deepEqual(await configured.directory.get("agent@example.com"), {
      ...servicePrincipal,
      displayName: "Configured Agent",
    });

    await configured.app.upsertDirectory([member("U-human")]);
    assert.equal(configured.identity.classify("agent@example.com").type, "internal");
    assert.equal((await configured.directory.get("agent@example.com"))?.displayName, "Configured Agent");
  });

  it("the deactivate/reactivate routes flip classification and are audited", async () => {
    const off = await signedPost("/v1/principals/U-manual/deactivate");
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { ok: true, principalId: "U-manual", active: false });
    assert.equal(built.identity.classify("U-manual").type, "guest");

    await built.app.upsertDirectory([member("U-manual")]);
    assert.equal(built.identity.classify("U-manual").type, "guest");

    const on = await signedPost("/v1/principals/U-manual/reactivate");
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { ok: true, principalId: "U-manual", active: true });
    assert.equal(built.identity.classify("U-manual").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.reactivate" && e.principalId === "U-manual"),
    );
  });

  it("an agent capability token cannot reach the principals routes (source-auth only)", async () => {
    const cap = await mintCapabilityToken(
      { actorId: "U-stay", scopeId: scopeId("personal", "U-stay"), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await fetch(`${base}/v1/principals/U-stay/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
    });
    assert.equal(res.status, 401);
  });
});
