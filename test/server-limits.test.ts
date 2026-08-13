import assert from "node:assert/strict";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("the Core server allows five minutes to receive a complete request", () => {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app);
  assert.equal(server.requestTimeout, 300_000);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.maxConnections, 1024);
  server.close();
});
