import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";

test("source-authenticated SOUL reads require the named principal to belong to the scope", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "soul-read-")) }));
  await built.directory.replaceChannels(
    [{ channelId: "C", name: "eng", isPrivate: true }],
    [{ channelId: "C", principalId: "alice" }],
  );
  await built.config.setSoul(scopeId("personal", "bob"), "Bob's private instruction.");
  await built.config.setSoul(scopeId("channel", "C"), "Channel C instruction.");
  const server = createInsecureTestServer(built.app, { config: built.config });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const read = (query: string) => fetch(`${base}/v1/soul?${query}`);
  try {
    assert.equal((await read("scopeId=personal:bob")).status, 400);
    assert.equal((await read("scopeId=personal:bob&principalId=alice")).status, 403);
    assert.equal((await read("scopeId=channel:C&principalId=bob")).status, 403);

    const own = await read("scopeId=personal:bob&principalId=bob");
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as { soul: string }).soul, "Bob's private instruction.");

    const channel = await read("scopeId=channel:C&principalId=alice");
    assert.equal(channel.status, 200);
    assert.equal(((await channel.json()) as { soul: string }).soul, "Channel C instruction.");

    assert.equal((await read("scopeId=org:default-org&principalId=alice")).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
