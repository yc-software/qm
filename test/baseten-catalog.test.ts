import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach, mock } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { basetenCatalogModels, createBasetenCatalog } from "../src/model/baseten.ts";
import { resolveCustomModel, setCustomProviders } from "../src/model/custom-providers.ts";
import { contextTokenBudgetForModel } from "../src/model/pi-models.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

const CATALOG = {
  object: "list",
  data: [
    {
      id: "zai-org/GLM-5.3",
      name: "GLM 5.3",
      context_length: 202_752,
      max_completion_tokens: 202_752,
      pricing: { prompt: "0.0000006", completion: "0.0000022", input_cache_read: "0.00000011" },
      supported_features: ["tools", "reasoning", "json_mode"],
      input_modalities: ["text"],
    },
    {
      id: "nvidia/Nemotron-VL",
      name: "Nemotron VL",
      context_length: 131_072,
      max_completion_tokens: 32_768,
      pricing: { prompt: "0.0000002", completion: "0.0000006" },
      supported_features: ["tools"],
      input_modalities: ["text", "image"],
    },
    {
      id: "decision-models/no-tools",
      name: "No tools",
      context_length: 8_192,
      supported_features: ["json_mode"],
    },
  ],
};

afterEach(() => setCustomProviders([]));

test("Baseten's model list maps to tool-capable models with per-million prices", () => {
  const models = basetenCatalogModels(CATALOG.data);
  assert.deepEqual(
    models.map((m) => m.id),
    ["zai-org/GLM-5.3", "nvidia/Nemotron-VL"],
  );
  const [glm, vl] = models;
  assert.equal(glm?.reasoning, true);
  assert.equal(glm?.contextWindow, 202_752);
  assert.equal(glm?.maxTokens, 202_752);
  assert.ok(Math.abs((glm?.input ?? 0) - 0.6) < 1e-9);
  assert.ok(Math.abs((glm?.output ?? 0) - 2.2) < 1e-9);
  assert.ok(Math.abs((glm?.cacheRead ?? 0) - 0.11) < 1e-9);
  assert.equal(vl?.image, true);
  assert.equal(vl?.maxTokens, 32_768);
  assert.deepEqual(basetenCatalogModels([{ ...CATALOG.data[1], pricing: {} }]), []);
});

test("a Baseten reply without a model list offers no Baseten models", async () => {
  const fetcher = (async () => Response.json({ error: "nope" })) as unknown as typeof fetch;
  assert.deepEqual(await createBasetenCatalog("bt-test-key", fetcher).providers([]), []);
});

test("the key goes only to Baseten's own endpoint and the last good list survives an outage", async () => {
  let up = true;
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return up ? Response.json(CATALOG) : new Response("down", { status: 503 });
  }) as unknown as typeof fetch;
  const catalog = createBasetenCatalog("bt-test-key", fetcher);
  const [builtIn] = await catalog.providers([]);
  assert.equal(builtIn?.baseUrl, "https://inference.baseten.co/v1");
  assert.deepEqual(catalog.keys([]), { baseten: "bt-test-key" });
  const keylessAdmin = { ...builtIn!, baseUrl: "https://elsewhere.example/v1", models: [{ id: "m" }] };
  assert.deepEqual(catalog.keys([keylessAdmin]), {});
  assert.deepEqual(await catalog.providers([keylessAdmin]), []);
  up = false;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.tick(6 * 60_000);
    await catalog.providers([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal((await catalog.providers([]))[0]?.models.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("a failed first fetch is retried within a minute, not after the full catalog TTL", async () => {
  let up = false;
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return up ? Response.json(CATALOG) : new Response("down", { status: 503 });
  }) as unknown as typeof fetch;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const catalog = createBasetenCatalog("bt-test-key", fetcher);
    assert.deepEqual(await catalog.providers([]), []);
    up = true;
    mock.timers.tick(10_000);
    await catalog.providers([]);
    assert.equal(calls, 1, "a failure is not retried on every call");
    mock.timers.tick(31_000);
    await catalog.providers([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal((await catalog.providers([]))[0]?.models.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("callers that arrive while the first fetch is pending all get Baseten's models", async () => {
  const reply = Promise.withResolvers<Response>();
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return reply.promise;
  }) as unknown as typeof fetch;
  const catalog = createBasetenCatalog("bt-test-key", fetcher);
  const first = catalog.providers([]);
  const second = catalog.providers([]);
  reply.resolve(Response.json(CATALOG));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a[0]?.models.length, 2);
  assert.equal(b[0]?.models.length, 2);
  assert.equal(calls, 1);
});

test("a model whose output limit nears or fills its window still gets a quarter of it as compaction budget", () => {
  setCustomProviders([
    {
      id: "baseten",
      name: "Baseten",
      protocol: "openai",
      baseUrl: "https://inference.baseten.co/v1",
      models: [
        ...basetenCatalogModels(CATALOG.data),
        { id: "almost-full", contextWindow: 100_000, maxTokens: 99_999 },
        { id: "half-output", contextWindow: 100_000, maxTokens: 50_000 },
        { id: "small-output", contextWindow: 100_000, maxTokens: 20_000 },
      ],
    },
  ]);
  assert.equal(contextTokenBudgetForModel("custom/baseten/zai-org/GLM-5.3"), Math.floor(202_752 / 4));
  assert.equal(contextTokenBudgetForModel("custom/baseten/almost-full"), 25_000);
  assert.equal(contextTokenBudgetForModel("custom/baseten/half-output"), 25_000);
  assert.equal(contextTokenBudgetForModel("custom/baseten/small-output"), 40_000);
});

test("BASETEN_API_KEY offers Baseten's live catalog and an admin baseten provider takes precedence", async (t) => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  const modelCredentialFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url === "https://inference.baseten.co/v1/models") return Response.json(CATALOG);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "baseten-catalog-")),
    basetenApiKey: "bt-test-key",
  });
  const built = buildApp(config, { modelCredentialFetch });
  const deps = serverDeps(config, built);
  const server = createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const runtimeConfig = async () => {
    const res = await fetch(
      `${base}/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org`,
      { headers: ADMIN },
    );
    assert.equal(res.status, 200);
    return (await res.json()) as {
      models: string[];
      modelCatalog: Record<string, { name: string; provider: string }>;
    };
  };
  const keyStatus = async (provider: string) => {
    const res = await fetch(`${base}/v1/admin/model-providers?catalog=cached`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { customProviders: Array<{ provider: string }> };
    return body.customProviders.find((row) => row.provider === provider);
  };
  try {
    const body = await runtimeConfig();
    assert.ok(body.models.includes("custom/baseten/zai-org/GLM-5.3"));
    assert.ok(!body.models.includes("custom/baseten/decision-models/no-tools"));
    assert.equal(body.modelCatalog["custom/baseten/zai-org/GLM-5.3"]?.provider, "baseten");
    assert.deepEqual(
      requests.filter((r) => r.url.includes("baseten")).map((r) => r.auth),
      ["Bearer bt-test-key"],
    );
    const vl = resolveCustomModel("custom/baseten/nvidia/Nemotron-VL");
    assert.deepEqual(vl?.input, ["text", "image"]);
    assert.equal(vl?.upstreamId, "nvidia/Nemotron-VL");
    assert.equal(vl?.baseUrl, "https://inference.baseten.co/v1");
    assert.deepEqual(await keyStatus("baseten"), { provider: "baseten", configured: true, source: "environment" });

    const put = await fetch(`${base}/v1/admin/custom-providers/baseten`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Baseten (dedicated)",
        protocol: "openai",
        baseUrl: "https://model-abc.api.baseten.co/environments/production/sync/v1",
        models: [{ id: "my-finetune" }],
        apiKey: "bt-admin-key",
        validate: false,
      }),
    });
    assert.equal(put.status, 200);
    const after = await runtimeConfig();
    assert.ok(after.models.includes("custom/baseten/my-finetune"));
    assert.ok(!after.models.includes("custom/baseten/zai-org/GLM-5.3"));
    assert.deepEqual(await keyStatus("baseten"), { provider: "baseten", configured: true, source: "admin" });

    const keyless = await fetch(`${base}/v1/admin/custom-providers/acme`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme",
        protocol: "openai",
        baseUrl: "https://llm.acme.example/v1",
        models: [{ id: "acme-1" }],
        validate: false,
      }),
    });
    assert.equal(keyless.status, 200);
    assert.deepEqual(await keyStatus("acme"), { provider: "acme", configured: false, source: "absent" });

    t.mock.method(built.customProviders, "resolveKey", async () => {
      throw new Error("unsupported state or unable to authenticate data");
    });
    assert.deepEqual(await keyStatus("baseten"), { provider: "baseten", configured: false, source: "absent" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
