import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { zeroUsage } from "../src/harness/replay.ts";
import { zstdDecompressSync } from "node:zlib";
import { buildModelRuntime, piUsageToCallUsage, wantsFastMode } from "../src/harness/pi-harness.ts";
import { getRequiredModel, modelSupportedByHarness, resolveModel } from "../src/model/pi-models.ts";
import { resolveIndividualAuthRouting } from "../src/core/individual-auth-routing.ts";

for (const [baseId, shortCost, longCost] of [
  ["gpt-6-astra", 0.3, 6.35],
  ["gpt-6.1-sol", 0.055, 1.26],
] as const) {
  const id = `${baseId}-ultrafast`;

  test(`${baseId} Ultrafast is an explicit API-only Pi choice with its own full pricing card`, () => {
    const model = getRequiredModel(id);
    assert.equal(model.provider, "openai");
    assert.equal(model.api, "openai-responses");
    assert.equal(wantsFastMode(true, id), false);
    assert.equal(modelSupportedByHarness(id, "pi"), true);
    assert.equal(modelSupportedByHarness(id, "claude"), false);
    assert.equal(resolveModel(`codex/${id}`), undefined);
    for (const tokens of [
      { input: 10_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000 },
      { input: 300_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000 },
    ]) {
      const standardUsage = { ...zeroUsage(), ...tokens };
      const ultrafastUsage = { ...zeroUsage(), ...tokens };
      calculateCost(getRequiredModel(baseId), standardUsage);
      calculateCost(model, ultrafastUsage);
      const standard = piUsageToCallUsage(standardUsage, getRequiredModel(baseId), false)!;
      const ultrafast = piUsageToCallUsage(ultrafastUsage, model, false)!;
      assert.ok(Math.abs(standard.costUsd - (tokens.input === 10_000 ? shortCost : longCost)) < 1e-9);
      assert.ok(Math.abs(ultrafast.costUsd - standard.costUsd * 6) < 1e-9);
    }
    const oauth = { kind: "oauth", oauth: { accessToken: "test" } } as never;
    assert.equal(resolveIndividualAuthRouting(null, oauth, id), null);
    const apiKey = { kind: "apikey", apiKey: "test" } as never;
    assert.equal(resolveIndividualAuthRouting(null, apiKey, id)?.model, id);
    assert.equal(resolveIndividualAuthRouting(apiKey, null, id), null);
  });

  for (const gateway of [false, true]) {
    test(`${baseId} Ultrafast reaches the wire across every runtime call path (${gateway ? "gateway" : "direct"})`, async (t) => {
      const config = gateway
        ? {
            url: "https://gateway.example.test/v1",
            apiKey: "gateway-key",
            apiKeyHeader: "api-key",
            models: { [id]: `router/${baseId}` },
          }
        : undefined;
      const runtime = await buildModelRuntime({ openai: "test-key" }, config);
      const originalFetch = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
        let request: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const text =
            headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(init?.body as Uint8Array).toString()
              : String(init?.body);
          request = { url: String(url), body: JSON.parse(text), headers };
          return new Response(JSON.stringify({ error: { message: "offline test" } }), { status: 400 });
        }) as typeof fetch;
        const result = runtime[method](
          getRequiredModel(id),
          { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
          {
            transport: "sse",
            maxRetries: 0,
            onPayload: (payload) => ({
              ...(payload as object),
              service_tier: "priority",
              metadata: { preserved: "yes" },
            }),
          },
        );
        const response = "result" in result ? await result.result() : await result;
        assert.ok(request, `${method}: ${response.errorMessage}`);
        assert.equal(request.body.model, gateway ? `router/${baseId}` : baseId);
        assert.equal(request.body.service_tier, "ultrafast");
        assert.deepEqual(request.body.metadata, { preserved: "yes" });
        assert.equal(response.model, id);
        if (gateway) assert.equal(request.headers.get("api-key"), "gateway-key");
      }
    });
  }
}
