import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { CODEX_SUBSCRIPTION_PROVIDER, getRequiredModel } from "../src/model/pi-models.ts";

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64url")}.test`;

test("a derived ChatGPT access token authenticates pi-ai's oauth-only codex provider for its own runtime only", async () => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  assert.equal(runtime.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), true);
  assert.equal((await runtime.getAuth(CODEX_SUBSCRIPTION_PROVIDER))?.auth.apiKey, subscriptionToken);
  const metered = await buildModelRuntime({ openai: "sk-metered-test-key" });
  assert.equal(metered.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), false);
  assert.equal(await metered.getAuth(CODEX_SUBSCRIPTION_PROVIDER), undefined);
});

test("codex subscription requests reach chatgpt.com with the bare model id on both streaming paths", async (t) => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  const model = getRequiredModel("codex/gpt-5.6-sol");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const method of ["stream", "streamSimple"] as const) {
    let request: { url: string; body: { model?: string } } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
      const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
      request = { url: String(url), body: JSON.parse(text) as { model?: string } };
      return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
    }) as typeof fetch;
    const response = await runtime[method](
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { transport: "sse", maxRetries: 0 },
    ).result();
    assert.ok(request, `${method} must reach the provider request: ${response.errorMessage ?? "no error"}`);
    assert.match(request.url, /^https:\/\/chatgpt\.com\/backend-api\//);
    assert.equal(request.body.model, "gpt-5.6-sol", `${method} must send the provider's own model id`);
    assert.equal(response.model, "codex/gpt-5.6-sol", `${method} keeps QM's namespaced id on the assistant message`);
  }
});
