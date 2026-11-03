import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";

const value = JSON.stringify({
  providers: [
    {
      id: "knowledge",
      type: "mcp",
      url: "http://memory-provider.internal:48081",
      read: {
        tool: "search_knowledge",
        clientIdEnv: "KNOWLEDGE_RO_CLIENT_ID",
        clientSecretEnv: "KNOWLEDGE_RO_CLIENT_SECRET",
      },
      write: {
        tool: "write_knowledge",
        clientIdEnv: "KNOWLEDGE_RW_CLIENT_ID",
        clientSecretEnv: "KNOWLEDGE_RW_CLIENT_SECRET",
      },
    },
  ],
  routes: [
    { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
    { provider: "knowledge", scopes: ["org"], capture: "explicit", manage: false, label: "Organization" },
  ],
});

test("provider config resolves MCP credentials and scope routes", () => {
  const config = parseMemoryProviderConfig(value, {
    KNOWLEDGE_RO_CLIENT_ID: "ro",
    KNOWLEDGE_RO_CLIENT_SECRET: "ro-secret",
    KNOWLEDGE_RW_CLIENT_ID: "rw",
    KNOWLEDGE_RW_CLIENT_SECRET: "rw-secret",
  });
  const knowledge = config?.providers[0];
  assert.equal(knowledge?.type, "mcp");
  if (knowledge?.type !== "mcp") throw new Error("expected mcp provider");
  assert.equal(knowledge.read.auth.clientId, "ro");
  assert.equal(knowledge.write?.auth.clientId, "rw");
  assert.deepEqual(
    config?.routes.map(({ provider, scopes, capture }) => ({ provider, scopes, capture })),
    [
      { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
      { provider: "knowledge", scopes: ["org"], capture: "explicit" },
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
      parseMemoryProviderConfig(value.replace("memory-provider.internal", "example.com"), {
        KNOWLEDGE_RO_CLIENT_ID: "ro",
        KNOWLEDGE_RO_CLIENT_SECRET: "x",
        KNOWLEDGE_RW_CLIENT_ID: "rw",
        KNOWLEDGE_RW_CLIENT_SECRET: "x",
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

const ENV = {
  KNOWLEDGE_RO_CLIENT_ID: "ro",
  KNOWLEDGE_RO_CLIENT_SECRET: "x",
  KNOWLEDGE_RW_CLIENT_ID: "rw",
  KNOWLEDGE_RW_CLIENT_SECRET: "x",
};

const withProvider = (fields: Record<string, unknown>) => {
  const parsed = JSON.parse(value) as { providers: Array<Record<string, unknown>> };
  parsed.providers[0] = { ...parsed.providers[0], ...fields };
  return JSON.stringify(parsed);
};

test("attestActor is an opt-in boolean on mcp providers only", () => {
  const mcp = (fields: Record<string, unknown>) => {
    const provider = parseMemoryProviderConfig(withProvider(fields), ENV)?.providers[0];
    return provider?.type === "mcp" ? provider.attestActor : undefined;
  };
  assert.equal(mcp({}), false);
  assert.equal(mcp({ attestActor: true }), true);
  assert.equal(mcp({ attestActor: false }), false);
  for (const attestActor of ["true", 1, null])
    assert.throws(() => mcp({ attestActor }), /knowledge\.attestActor must be true or false on an mcp provider/);
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [{ id: "procedures", type: "memorable", attestActor: true }], routes: [] }),
        {},
      ),
    /procedures\.attestActor must be true or false on an mcp provider/,
  );
});

test("provider URL errors name only the protocol and host and never echo secrets", () => {
  const SENTINEL = "s3ntinel-credential";
  const cases: Array<[string, RegExp]> = [
    [
      `https://user:${SENTINEL}@memory.example.com/mcp?token=${SENTINEL}`,
      /\(https:\/\/memory\.example\.com\) must not carry credentials or a #fragment/,
    ],
    [
      `https://memory.example.com/mcp?token=${SENTINEL}#${SENTINEL}`,
      /\(https:\/\/memory\.example\.com\) must not carry credentials or a #fragment/,
    ],
    [
      `http://memory.example.com/mcp?token=${SENTINEL}`,
      /\(http:\/\/memory\.example\.com\) must use HTTPS or a recognized private HTTP host/,
    ],
    [`not a url ${SENTINEL}`, /is not a valid URL \(value not shown\)/],
  ];
  for (const [url, message] of cases) {
    assert.throws(
      () => parseMemoryProviderConfig(withProvider({ url }), ENV),
      (error: unknown) => {
        const text = String(error);
        assert.match(text, message);
        assert.match(text, /localhost, 127\.0\.0\.1, \*\.internal, \*\.flycast or \*\.local/);
        assert.match(text, /docs\/memory-providers\.md#troubleshooting/);
        assert.doesNotMatch(text, new RegExp(SENTINEL));
        assert.doesNotMatch(text, /user:|token=/);
        return true;
      },
    );
  }
});
