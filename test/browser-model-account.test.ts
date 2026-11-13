import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { BROWSER_MODEL_AUD, mintCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { COMPANY_CHATGPT_CREDENTIAL, saveCompanyChatGPTLogin } from "./support/company-chatgpt-login.ts";

type Upstream = { host: string; headers: Headers; body: Record<string, unknown> };

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicToolResult(input: Record<string, unknown>): Response {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t", name: "structured_result", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

async function browserEndpoint(
  t: TestContext,
  respond: (upstream: Upstream) => Response,
  overrides: Parameters<typeof testConfig>[0] = {},
) {
  const config = testConfig({ signingSecret: "ingress-secret".repeat(3), ...overrides });
  const built = stopAtEnd(buildApp(config));
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const calls: Upstream[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    const raw = input instanceof Request ? await input.text() : init?.body;
    const call = {
      host: url.host,
      headers: new Headers(input instanceof Request ? input.headers : init?.headers),
      body: (typeof raw === "string" ? JSON.parse(raw) : {}) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/browser-model/chat/completions`;
  const post = async (claims: Partial<CapabilityClaims>, body: Record<string, unknown>) =>
    realFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await mintCapabilityToken(
          {
            actorId: "U1",
            scopeId: "personal:U1",
            aud: BROWSER_MODEL_AUD,
            sessionId: "browser-session",
            exp: Date.now() + 60_000,
            ...claims,
          },
          TEST_CAPABILITY_SECRET,
        ),
      },
      body: JSON.stringify(body),
    });
  return { built, calls, post };
}

const structuredRequest = {
  model: "claude-opus-5",
  messages: [
    { role: "system", content: "Browse safely" },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    },
  ],
  response_format: {
    type: "json_schema",
    json_schema: { schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } },
  },
};

test("browser requests run on the person's own Claude key, as their session does", async (t) => {
  const { built, calls, post } = await browserEndpoint(t, () => anthropicToolResult({ done: true }));
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const claims = { browserAccount: "anthropic" as const, browserModel: "claude-opus-5" };

  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-claude-key");
  const keyed = await post(claims, structuredRequest);
  assert.equal(keyed.status, 200, await keyed.clone().text());
  assert.equal(
    ((await keyed.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content,
    '{"done":true}',
  );
  assert.equal(calls[0]?.host, "api.anthropic.com");
  assert.equal(calls[0]?.headers.get("x-api-key"), "personal-claude-key");
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "tool", name: "structured_result" });
  assert.match(JSON.stringify(calls[0]?.body.system), /Browse safely/);
  assert.match(JSON.stringify(calls[0]?.body.messages), /"media_type":"image\/png"/);

  await built.userModelCredentials.delete("U1", "anthropic");
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: "sk-ant-oat01-subscription",
    expiresAt: Date.now() + 3600_000,
  });
  const subscribed = await post(claims, structuredRequest);
  assert.equal(subscribed.status, 422);
  assert.match(await subscribed.text(), /Claude subscription/);
  assert.equal(calls.length, 1);

  await built.userModelCredentials.delete("U1", "anthropic");
  assert.equal((await post(claims, structuredRequest)).status, 409);
  assert.equal(calls.length, 1);
});

test("a failed browser request names the model and the account it billed", async (t) => {
  const { built, post } = await browserEndpoint(
    t,
    () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  );
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-claude-key");
  const failed = await post({ browserAccount: "anthropic", browserModel: "claude-opus-5" }, structuredRequest);
  assert.equal(failed.status, 502);
  const { error } = (await failed.json()) as { error: string };
  assert.match(error, /Claude Opus 5 \(billed to the person's own account\) could not complete the browser request/);
  assert.match(error, /slow down/);
  assert.ok(!error.includes("personal-claude-key"));
});

const chatgptToken = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
).toString("base64url")}.sig`;

const rejected = () =>
  new Response(JSON.stringify({ error: { message: "subscription test stop" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

test("a ChatGPT login serves the browser on the person's subscription", async (t) => {
  const { built, calls, post } = await browserEndpoint(t, rejected);
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: chatgptToken,
    expiresAt: Date.now() + 3600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const response = await post(
    { browserAccount: "openai", browserModel: "codex/gpt-6.1-sol" },
    { ...structuredRequest, model: "codex/gpt-6.1-sol" },
  );
  assert.equal(response.status, 502);
  assert.match(await response.text(), /billed to the person's own account/);
  assert.equal(calls[0]?.host, "chatgpt.com");
  assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${chatgptToken}`);
});

test("a company ChatGPT subscription serves company browsing without an API-key fallback", async (t) => {
  const { built, calls, post } = await browserEndpoint(t, rejected, {
    codexAuthCredential: COMPANY_CHATGPT_CREDENTIAL,
    openaiApiKey: "must-not-fallback",
  });
  await saveCompanyChatGPTLogin(built.keychain, {
    auth_mode: "chatgpt",
    tokens: { access_token: chatgptToken, refresh_token: "company-refresh", id_token: chatgptToken },
  });
  const response = await post(
    { browserAccount: "company", browserModel: "gpt-5.6-sol" },
    { ...structuredRequest, model: "gpt-5.6-sol" },
  );
  assert.equal(response.status, 502);
  assert.match(await response.text(), /billed to the organization's own provider key/);
  assert.equal(calls[0]?.host, "chatgpt.com");
  assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${chatgptToken}`);
});
