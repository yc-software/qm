import { test } from "node:test";
import assert from "node:assert/strict";
import { principalStatus, reactivatePrincipal } from "../src/commands/principal.ts";
import type { QmConfig } from "../src/config.ts";
import type { DeploymentLayerTransport } from "../src/deployment-layer.ts";
const config = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://example.com",
  target: "docker",
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
} as QmConfig;
test("principal status and reactivation use the signed provider transport", async () => {
  const calls: Array<{ method: string; path?: string }> = [];
  const transport: DeploymentLayerTransport = async (opts) => {
    calls.push({ method: opts.method, path: opts.path });
    return opts.method === "GET"
      ? { status: 200, body: JSON.stringify({ principalId: "person@example.com", active: false, source: "manual" }) }
      : { status: 200, body: JSON.stringify({ principalId: "person@example.com", active: true }) };
  };
  assert.equal((await principalStatus(config, "/tmp", transport, "person@example.com")).active, false);
  assert.equal((await reactivatePrincipal(config, "/tmp", transport, "person@example.com")).active, true);
  assert.deepEqual(calls, [
    { method: "GET", path: "/v1/principals/person%40example.com/status" },
    { method: "POST", path: "/v1/principals/person%40example.com/reactivate" },
  ]);
});
