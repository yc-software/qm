import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";

const PID = "soul-read-portal-identity-secret-for-tests";

test("source-authenticated SOUL reads require the portal-verified principal to belong to the scope", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "soul-read-")) }));
  await built.directory.replaceChannels(
    [{ channelId: "C", name: "eng", isPrivate: true }],
    [{ channelId: "C", principalId: "alice" }],
  );
  await built.config.setSoul(scopeId("personal", "bob"), "Bob's private instruction.");
  await built.config.setSoul(scopeId("channel", "C"), "Channel C instruction.");
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    identity: built.identity,
    portalIdentitySecret: PID,
    requireSignedPortalIdentity: true,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const read = async (query: string, as?: string) =>
    fetch(`${base}/v1/soul?${query}`, {
      headers: as ? { "x-portal-identity": await mintSignedPayload({ p: as, exp: Date.now() + 60_000 }, PID) } : {},
    });
  try {
    assert.equal((await read("scopeId=personal:bob&principalId=bob")).status, 401);
    assert.equal((await read("scopeId=personal:bob&principalId=bob", "alice")).status, 403);
    assert.equal((await read("scopeId=personal:bob&principalId=alice", "alice")).status, 403);
    assert.equal((await read("scopeId=channel:C&principalId=bob", "bob")).status, 403);

    const own = await read("scopeId=personal:bob&principalId=bob", "bob");
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as { soul: string }).soul, "Bob's private instruction.");

    const channel = await read("scopeId=channel:C&principalId=alice", "alice");
    assert.equal(channel.status, 200);
    assert.equal(((await channel.json()) as { soul: string }).soul, "Channel C instruction.");

    assert.equal((await read("scopeId=org:default-org&principalId=alice", "alice")).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
