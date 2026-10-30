import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createAgent, agentConfigOptions } from "../src/agent/agent-run.ts";
import { codexSubscriptionModelId } from "../src/model/pi-models.ts";

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "company-account" } }),
).toString("base64url")}.test`;

function recordFetch(t: TestContext, headers: Headers[] = []): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    headers.push(new Headers(input instanceof Request ? input.headers : init?.headers));
    return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
  });
  return urls;
}

const companyAgent = (keys: Record<string, string>) =>
  createAgent({
    modelId: "gpt-5.6-sol",
    captureRequests: false,
    resolveProviderKeys: async () => keys,
    companyModelId: codexSubscriptionModelId,
  });

test("company utility calls on a plain OpenAI id are served by the ChatGPT subscription, never the metered key", async (t) => {
  const urls = recordFetch(t);
  await assert.rejects(
    async () => companyAgent({ openai: "sk-metered", "openai-codex": subscriptionToken }).oneShot?.("system", "hi"),
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
  assert.equal(await companyAgent({ openai: "sk-metered" }).oneShot?.("system", "hi"), undefined);
  assert.deepEqual(urls, []);
});

test("without a company subscription a plain OpenAI id stays metered", async (t) => {
  const urls = recordFetch(t);
  const agent = createAgent({
    modelId: "gpt-5.6-sol",
    captureRequests: false,
    resolveProviderKeys: async () => ({ openai: "sk-metered" }),
  });
  await assert.rejects(async () => agent.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => new URL(url).hostname === "api.openai.com"),
    JSON.stringify(urls),
  );
});

test("a subscription-only deployment's default utility model is served by the ChatGPT subscription", async (t) => {
  const urls = recordFetch(t);
  const config = { ...loadConfig({}), codexAuthCredential: "cred-1" };
  const agent = createAgent({
    ...agentConfigOptions(config),
    captureRequests: false,
    resolveProviderKeys: async () => ({ "openai-codex": subscriptionToken }),
    companyModelId: codexSubscriptionModelId,
  });
  await assert.rejects(async () => agent.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/")),
    JSON.stringify(urls),
  );
});
