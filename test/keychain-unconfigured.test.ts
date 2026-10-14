import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "route-test-secret".repeat(3);

test("a server without a keychain key says so instead of a bare not_found", async () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "kc-off-")), signingSecret: SECRET });
  delete (config as { connectorSecretKey?: string }).connectorSecretKey;
  const built = buildApp(config);
  assert.equal(built.keychain, undefined);
  const server = createServer(built.app, { signingSecret: SECRET, config: built.config });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("personal", "U1"),
        destination: { type: "slack", target: "D-U1", audienceScopeId: scopeId("personal", "U1") },
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/keychain/overview`, {
      headers: { "x-agent-capability": token },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "keychain_unavailable");
    assert.match(body.message, /CONNECTOR_SECRET_KEY/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
