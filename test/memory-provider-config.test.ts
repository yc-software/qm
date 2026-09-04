import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";

const value = JSON.stringify({
  providers: [
    {
      id: "gbrain",
      type: "mcp",
      url: "http://qm-gbrain-relay.flycast:48081",
      read: { tool: "read_brain", clientIdEnv: "BRAIN_RO_CLIENT_ID", clientSecretEnv: "BRAIN_RO_CLIENT_SECRET" },
      write: { tool: "write_brain", clientIdEnv: "BRAIN_RW_CLIENT_ID", clientSecretEnv: "BRAIN_RW_CLIENT_SECRET" },
    },
  ],
  routes: [
    { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
    { provider: "gbrain", scopes: ["org"], capture: "explicit", manage: false, label: "Organization" },
  ],
});

test("provider config resolves MCP credentials and scope routes", () => {
  const config = parseMemoryProviderConfig(value, {
    BRAIN_RO_CLIENT_ID: "ro",
    BRAIN_RO_CLIENT_SECRET: "ro-secret",
    BRAIN_RW_CLIENT_ID: "rw",
    BRAIN_RW_CLIENT_SECRET: "rw-secret",
  });
  const brain = config?.providers[0];
  assert.equal(brain?.type, "mcp");
  if (brain?.type !== "mcp") throw new Error("expected mcp provider");
  assert.equal(brain.read.auth.clientId, "ro");
  assert.equal(brain.write?.auth.clientId, "rw");
  assert.deepEqual(
    config?.routes.map(({ provider, scopes, capture }) => ({ provider, scopes, capture })),
    [
      { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
      { provider: "gbrain", scopes: ["org"], capture: "explicit" },
    ],
  );
});

test("provider config rejects unknown providers and public cleartext MCP URLs", () => {
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [], routes: [{ provider: "missing", scopes: ["org"] }] }),
        {},
      ),
    /unknown memory provider/,
  );
  assert.throws(
    () =>
      parseMemoryProviderConfig(value.replace("qm-gbrain-relay.flycast", "example.com"), {
        BRAIN_RO_CLIENT_ID: "ro",
        BRAIN_RO_CLIENT_SECRET: "x",
        BRAIN_RW_CLIENT_ID: "rw",
        BRAIN_RW_CLIENT_SECRET: "x",
      }),
    /HTTPS or a recognized private HTTP host/,
  );
});

test("provider config accepts a memorable provider with an allow-listed child environment", () => {
  const config = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: "procedures",
          type: "memorable",
          bin: ["node", "/opt/memorable dir/cli.js"],
          passEnv: ["MEMORABLE_STORE_KEY"],
          injectTimeoutMs: 5000,
        },
      ],
      routes: [{ provider: "procedures", scopes: ["personal"], capture: "automatic", manage: false }],
    }),
    {
      DATABASE_URL: "postgres://qm",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-never",
      MEMORABLE_API_KEY: "mk",
      MEMORABLE_STORE_KEY: "aa",
    },
  );
  const provider = config?.providers[0];
  if (provider?.type !== "memorable") throw new Error("expected memorable provider");
  assert.deepEqual(provider.argv, ["node", "/opt/memorable dir/cli.js"]);
  assert.equal(provider.injectTimeoutMs, 5000);
  assert.equal(provider.recordTimeoutMs, 120_000);
  assert.deepEqual(provider.env, {
    PATH: "/usr/bin",
    MEMORABLE_API_KEY: "mk",
    MEMORABLE_STORE_KEY: "aa",
    MEMORABLE_BACKEND: "qm",
    MEMORABLE_DB_URL: "postgres://qm",
  });
  assert.equal(provider.redactValues.ANTHROPIC_API_KEY, "sk-never");
  assert.equal(config?.routes[0]?.manage, false);
});

test("provider config rejects explicit capture on a memorable route", () => {
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({
          providers: [{ id: "procedures", type: "memorable" }],
          routes: [{ provider: "procedures", scopes: ["personal"], capture: "explicit" }],
        }),
        {},
      ),
    /does not support capture "explicit"/,
  );
});

test("provider config rejects malformed passEnv names and empty bin", () => {
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [{ id: "p", type: "memorable", passEnv: ["lower"] }], routes: [] }),
        {},
      ),
    /passEnv/,
  );
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [{ id: "p", type: "memorable", bin: [] }], routes: [] }),
        {},
      ),
    /bin/,
  );
});
