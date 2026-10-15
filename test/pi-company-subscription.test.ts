import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createPiHarness, piHarnessConfigOptions } from "../src/harness/pi-harness.ts";
import { codexSubscriptionModelId } from "../src/model/pi-models.ts";

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "company-account" } }),
).toString("base64url")}.test`;

function recordFetch(t: TestContext): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
  });
  return urls;
}

const companyHarness = (keys: Record<string, string>) =>
  createPiHarness({
    modelId: "gpt-5.6-sol",
    captureRequests: false,
    resolveProviderKeys: async () => keys,
    companyModelId: codexSubscriptionModelId,
  });

test("company utility calls on a plain OpenAI id are served by the ChatGPT subscription, never the metered key", async (t) => {
  const urls = recordFetch(t);
  await assert.rejects(
    async () =>
      companyHarness({ openai: "sk-metered", "openai-codex": subscriptionToken }).models.oneShot?.("system", "hi"),
    /offline test response/,
  );
  assert.ok(
    urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/")),
    JSON.stringify(urls),
  );
  assert.ok(!urls.some((url) => new URL(url).hostname === "api.openai.com"), JSON.stringify(urls));
});

test("an unavailable company ChatGPT token fails closed instead of falling back to the metered key", async (t) => {
  const urls = recordFetch(t);
  assert.equal(await companyHarness({ openai: "sk-metered" }).models.oneShot?.("system", "hi"), undefined);
  assert.deepEqual(urls, []);
});

test("without a company subscription a plain OpenAI id stays metered", async (t) => {
  const urls = recordFetch(t);
  const harness = createPiHarness({
    modelId: "gpt-5.6-sol",
    captureRequests: false,
    resolveProviderKeys: async () => ({ openai: "sk-metered" }),
  });
  await assert.rejects(async () => harness.models.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => new URL(url).hostname === "api.openai.com"),
    JSON.stringify(urls),
  );
});

test("a subscription-only deployment's default utility model is served by the ChatGPT subscription", async (t) => {
  const urls = recordFetch(t);
  const config = { ...loadConfig({}), harness: "pi" as const, codexAuthCredential: "cred-1" };
  const harness = createPiHarness({
    ...piHarnessConfigOptions(config),
    captureRequests: false,
    resolveProviderKeys: async () => ({ "openai-codex": subscriptionToken }),
    companyModelId: codexSubscriptionModelId,
  });
  await assert.rejects(async () => harness.models.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/")),
    JSON.stringify(urls),
  );
});
