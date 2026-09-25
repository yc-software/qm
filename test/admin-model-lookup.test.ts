import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { AddressInfo } from "node:net";

const headers = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
test("admin lookup recognizes an existing model without asking for a clone template", async () => {
  const config = testConfig({ anthropicApiKey: "test-only" });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const result = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/model-registry/lookup`,
      { method: "POST", headers, body: JSON.stringify({ provider: "anthropic", id: "claude-opus-4-6" }) },
    );
    assert.equal(result.status, 200);
    const body = (await result.json()) as { kind: string; spec: { template: string }; missing: string[] };
    assert.equal(body.kind, "builtin");
    assert.equal(body.spec.template, "claude-opus-4-6");
    assert.deepEqual(body.missing, []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

import { lookupModel } from "../src/model/model-lookup.ts";
import { createModelCredentialStore } from "../src/model/model-credential-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { verificationUpstream } from "./support/model-verification-upstream.ts";
import { setModelOverlays } from "../src/model/pi-models.ts";
import { afterEach } from "node:test";

afterEach(() => {
  setProviderBaseUrls({});
  setModelOverlays([]);
});
const credentials = () =>
  createModelCredentialStore({
    backing: createMemoryMap(),
    keyMaterial: "test-key",
    fallback: { openai: "test-openai-key", anthropic: "test-anthropic-key" },
  });

test("exact catalog lookup returns documented values without network or other-model guesses", async () => {
  const result = await lookupModel({ provider: "anthropic", id: "claude-opus-4-6" }, credentials(), async () => {
    throw Error("must not fetch");
  });
  assert.equal(result.kind, "builtin");
  assert.equal(result.spec.template, "claude-opus-4-6");
  assert.equal(result.spec.cost?.input, 5);
  assert.ok(result.spec.maxTokens);
  assert.equal(result.source, "Bundled model catalog");
  await assert.rejects(lookupModel({ provider: "openai", id: "claude-opus-4-6" }), /different provider/);
});

test("provider lookup only imports exact bounded metadata, never pricing from a similar model", async () => {
  setProviderBaseUrls({ anthropic: "http://127.0.0.1:19998" });
  let calls = 0;
  const result = await lookupModel(
    { provider: "anthropic", id: "future-lookup-model" },
    credentials(),
    async (url, options) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:19998/v1/models/future-lookup-model");
      assert.equal(new Headers(options?.headers).get("x-api-key"), "test-anthropic-key");
      assert.equal(options?.redirect, "error");
      return Response.json({
        id: "future-lookup-model",
        display_name: "Future exact",
        max_input_tokens: 160000,
        max_tokens: 40000,
        apiKey: "private",
        cost: { input: 100 },
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.spec.name, "Future exact");
  assert.equal(result.spec.contextWindow, 160000);
  assert.equal(result.spec.maxTokens, 40000);
  assert.equal(result.spec.template, undefined);
  assert.equal(result.spec.cost, undefined);
  assert.deepEqual(result.missing, ["template", "input", "output", "cacheRead", "cacheWrite"]);
  assert.doesNotMatch(JSON.stringify(result), /private|test-anthropic-key/);
});

test("OpenAI minimal metadata and missing credentials leave unknown fields visibly missing", async () => {
  const result = await lookupModel({ provider: "openai", id: "future-openai-model" }, credentials(), async () =>
    Response.json({ id: "future-openai-model", object: "model" }),
  );
  assert.equal(result.spec.name, "future-openai-model");
  assert.equal(result.spec.template, undefined);
  assert.ok(result.missing.includes("contextWindow"));
  const absent = await lookupModel({ provider: "openai", id: "future-openai-model" }, undefined, async () => {
    throw Error("must not fetch");
  });
  assert.equal(absent.source, "Manual entry");
  assert.ok(absent.missing.includes("name"));
  assert.match(absent.message, /provider key/);
});

test("bad responses degrade to manual fields with no partial or mismatched metadata", async () => {
  for (const response of [
    Response.json({ id: "wrong-model", display_name: "Wrong", max_input_tokens: 1, max_tokens: 1 }),
    Response.json({ id: "future-model", max_tokens: -1 }),
    new Response("secret", { status: 403 }),
    new Response("x".repeat(65537)),
  ]) {
    const result = await lookupModel(
      { provider: "anthropic", id: "future-model" },
      credentials(),
      async () => response,
    );
    assert.equal(result.source, "Manual entry");
    assert.equal(result.spec.contextWindow, undefined);
    assert.equal(result.spec.name, undefined);
    assert.ok(result.missing.includes("template"));
    assert.doesNotMatch(JSON.stringify(result), /secret|Wrong/);
  }
  const offline = await lookupModel({ provider: "openai", id: "future-model" }, credentials(), async () => {
    throw Error("secret");
  });
  assert.match(offline.message, /Retry lookup/);
});

test("live lookup is admin-only and builtin enable verifies without a duplicate or changed default", async () => {
  const upstream = await verificationUpstream();
  const config = testConfig({
    harness: "pi",
    anthropicApiKey: "lookup-key",
    providerBaseUrls: { anthropic: upstream.url },
  });
  const built = buildApp(config, {
    modelCredentialFetch: async () => {
      throw Error("lookup must not fetch for builtin");
    },
  });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: object, actor = "admin-alice@default-org") =>
    fetch(base + path, { method: "POST", headers: { ...headers, "x-admin-actor": actor }, body: JSON.stringify(body) });
  const identity = { id: "claude-opus-4-6", provider: "anthropic" };
  const enable = "/v1/admin/model-registry/claude-opus-4-6/enable";
  try {
    assert.equal((await post("/v1/admin/model-registry/lookup", identity, "bob@default-org")).status, 403);
    assert.equal((await post(enable, { provider: "anthropic", verify: true }, "bob@default-org")).status, 403);
    assert.equal((await post(enable, { provider: "anthropic" })).status, 400);
    assert.equal(upstream.requests.length, 0);
    const priorDefault = await built.config.getRuntimeSelectionDurable("org:default-org");
    built.config.setWebuiModels("org:default-org", ["claude-sonnet-4-6"]);
    await built.config.flushScope("org:default-org");
    upstream.behavior.status = 403;
    assert.equal((await post(enable, { provider: "anthropic", verify: true })).status, 422);
    assert.deepEqual(await built.config.getWebuiModelsDurable("org:default-org"), ["claude-sonnet-4-6"]);
    upstream.behavior.status = 200;
    assert.equal((await post(enable, { provider: "anthropic", verify: true })).status, 200);
    assert.equal(upstream.requests.at(-1)?.body.model, "claude-opus-4-6");
    assert.equal(upstream.requests.at(-1)?.body.max_tokens, 128);
    assert.deepEqual(await built.config.getWebuiModelsDurable("org:default-org"), [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
    assert.deepEqual(await built.config.getRuntimeSelectionDurable("org:default-org"), priorDefault);
    assert.deepEqual(await built.modelRegistry.statuses(), []);
    const runtime = await fetch(
      base + "/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org",
      { headers },
    );
    const body = (await runtime.json()) as { modelsByHarness: { pi: string[] } };
    assert.ok(body.modelsByHarness.pi.includes("claude-opus-4-6"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
  }
});

test("enable rechecks serving credentials and harness policy before mutating the picker", async () => {
  let onProbe: () => Promise<void> = async () => {};
  const config = testConfig({ harness: "pi", anthropicApiKey: "test-key" });
  const built = buildApp(config, { modelVerificationProbe: async () => onProbe() });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/model-registry/claude-opus-4-6/enable`;
  const enable = () =>
    fetch(url, { method: "POST", headers, body: JSON.stringify({ provider: "anthropic", verify: true }) });
  const org = "org:default-org";
  try {
    onProbe = async () => {
      await built.modelCredentials.set("anthropic", "changed-key", "admin");
    };
    assert.equal((await enable()).status, 422);
    assert.equal(await built.config.getWebuiModelsDurable(org), null);
    onProbe = async () => {
      built.config.setApprovedHarnesses(["claude"]);
      await built.config.flushScope(org);
    };
    assert.equal((await enable()).status, 422);
    assert.equal(await built.config.getWebuiModelsDurable(org), null);
    onProbe = async () => {
      throw Error("must not call");
    };
    assert.equal((await enable()).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("identity schema rejects URL-like and extra inputs before lookup", async () => {
  const { modelLookupInput } = await import("../src/model/model-lookup.ts");
  for (const body of [
    { provider: "openai", id: "https://example.invalid/model" },
    { provider: "other", id: "model" },
    { provider: "openai", id: "model", baseUrl: "https://example.invalid" },
    { provider: "openai", id: "../models" },
  ])
    assert.equal(modelLookupInput.safeParse(body).success, false);
});

import { createServer } from "node:http";

test("real metadata transport authenticates only the configured endpoint and refuses redirects", async () => {
  let mode = "record";
  let sinkRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/sink") {
      sinkRequests++;
      res.end("unexpected");
      return;
    }
    assert.equal(req.headers["x-api-key"], "test-anthropic-key");
    if (mode === "redirect") {
      res.writeHead(302, { location: "/sink" });
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "live-metadata-model",
        display_name: "Exact network record",
        max_input_tokens: 200000,
        max_tokens: 32000,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  setProviderBaseUrls({ anthropic: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  try {
    const value = await lookupModel({ provider: "anthropic", id: "live-metadata-model" }, credentials());
    assert.equal(value.spec.name, "Exact network record");
    assert.equal(value.spec.contextWindow, 200000);
    assert.equal(value.spec.maxTokens, 32000);
    mode = "redirect";
    const redirect = await lookupModel({ provider: "anthropic", id: "live-metadata-model" }, credentials());
    assert.equal(sinkRequests, 0);
    assert.equal(redirect.source, "Manual entry");
    assert.equal(redirect.spec.name, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
