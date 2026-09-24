import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
  BROWSER_MODEL_AUD,
  CONTROL_PLANE_AUD,
} from "../src/auth/capability-token.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";

const model = "claude-opus-5";
const key = "company-gateway-secret";

test("browser inference uses the company gateway with scoped model authorization", async (t) => {
  const calls: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  let status = 200;
  const upstream = httpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        status === 200 ? { choices: [{ message: { role: "assistant", content: "done" } }] } : { error: key },
      ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const config = testConfig({ signingSecret: "ingress-secret".repeat(3) });
  const built = buildApp(config);
  const routes: Record<string, string> = { [model]: "anthropic/claude-opus-5" };
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    browserModelGateway: {
      url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      apiKey: `Bearer ${key}`,
      apiKeyHeader: "Authorization",
      models: routes,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/browser-model/chat/completions`;
  const claims = {
    actorId: "U1",
    scopeId: "personal:U1" as const,
    browserModel: model,
    aud: BROWSER_MODEL_AUD,
    browserAccount: "company" as const,
    exp: Date.now() + 60_000,
  };
  const token = await mintCapabilityToken(claims, TEST_CAPABILITY_SECRET);
  const post = (body: unknown, credential = token) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": credential },
      body: JSON.stringify(body),
    });
  const body = { model, messages: [{ role: "user", content: "browse" }], response_format: { type: "json_object" } };
  const response = await post(body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "done" } }] });
  assert.deepEqual(calls[0], {
    url: "/v1/chat/completions",
    auth: `Bearer ${key}`,
    body: { ...body, model: "anthropic/claude-opus-5", stream: false },
  });
  for (const invalid of [
    { ...body, model: "other" },
    { ...body, api_key: "override" },
    { ...body, api_base: "https://attacker.invalid" },
    { ...body, stream: true },
  ])
    assert.equal((await post(invalid)).status, 400);
  assert.equal(
    (await post(body, await mintCapabilityToken({ ...claims, aud: CONTROL_PLANE_AUD }, TEST_CAPABILITY_SECRET))).status,
    403,
  );
  assert.equal(
    (await post(body, await mintCapabilityToken({ ...claims, exp: 1 }, TEST_CAPABILITY_SECRET))).status,
    401,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await post({
        ...body,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(1_100_000) } }],
          },
        ],
      })
    ).status,
    200,
  );
  status = 429;
  const limited = await post(body);
  assert.equal(limited.status, 429);
  assert.ok(!(await limited.text()).includes(key));
  await built.config.setSecurityPosture("personal:U1", "strict");
  assert.equal((await post(body)).status, 403);
  await built.config.setSecurityPosture("personal:U1", "auto");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  assert.equal((await post(body)).status, 409);
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: "subscription-test",
    expiresAt: Date.now() + 3600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const claudeToken = await mintCapabilityToken({ ...claims, browserAccount: "anthropic" }, TEST_CAPABILITY_SECRET);
  const unsupported = await post(body, claudeToken);
  assert.equal(unsupported.status, 422);
  assert.match(await unsupported.text(), /Claude subscription/);
  await built.config.setPersonalModelAuth("U1", false);
  delete routes[model];
  assert.equal((await post(body)).status, 503);
  assert.equal(calls.length, 3);
});

test("gateway deployment provisions a browser token without exposing the company model key", async () => {
  const config = testConfig({
    signingSecret: "ingress-secret".repeat(3),
    apiBaseUrl: "https://core.example.test",
    modelGateway: {
      url: "https://models.invalid",
      apiKey: key,
      apiKeyHeader: "Authorization",
      models: { [model]: "anthropic/claude-opus-5" },
    },
  });
  const built = buildApp(config, { modelCredentialFetch: async () => new Response("unavailable", { status: 503 }) });
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  const result = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:browser" },
    text: "!run echo browser",
  });
  assert.equal(result.status, "ok");
  const env = captured?.env;
  assert.equal(env?.BROWSE_LAB_MODEL_PROVIDER, "managed");
  assert.equal(env?.BROWSE_LAB_BASE_URL, "https://core.example.test/v1/browser-model");
  assert.ok(!Object.values(env ?? {}).includes(key));
  const claims = await verifyCapabilityToken(env!.BROWSE_LAB_MODEL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, BROWSER_MODEL_AUD);
  assert.equal(claims?.browserModel, model);
  assert.equal(claims?.scopeId, "personal:U1");
});

test("gateway browsing never selects a direct provider when callback signing or URL is missing", async () => {
  for (const missing of [{ signingSecret: undefined }, { apiBaseUrl: undefined }]) {
    const config = testConfig({
      signingSecret: "ingress-secret".repeat(3),
      apiBaseUrl: "https://core.example.test",
      ...missing,
      modelGateway: {
        url: "https://models.invalid",
        apiKey: key,
        apiKeyHeader: "Authorization",
        models: { [model]: "anthropic/claude-opus-5" },
      },
    });
    const built = buildApp(config, { modelCredentialFetch: async () => new Response("unavailable", { status: 503 }) });
    let captured: ProvisionOptions | undefined;
    const provision = built.sandbox.provision.bind(built.sandbox);
    built.sandbox.provision = (layers, opts) => {
      captured = opts;
      return provision(layers, opts);
    };
    await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:missing" },
      text: "!run echo missing",
    });
    assert.equal(captured?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed");
    assert.equal(captured?.env?.BROWSE_LAB_MODEL_TOKEN, undefined);
  }
});

test("company browsing without a gateway uses current deployment credentials and endpoints", async (t) => {
  const calls: Array<{ key: string | undefined; model: string }> = [];
  const upstream = httpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ key: req.headers["x-api-key"] as string, model: body.model });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      {
        type: "message_start",
        message: {
          id: "test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DIRECT_OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const config = testConfig({
    signingSecret: "ingress-secret".repeat(3),
    apiBaseUrl: "https://core.example.test",
    anthropicApiKey: "deployment-key",
    providerBaseUrls: { anthropic: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
  });
  const built = buildApp(config);
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:direct" },
    text: "!run echo direct",
  });
  const env = captured!.env!;
  assert.equal(env.BROWSE_LAB_MODEL_PROVIDER, "managed");
  assert.equal(env.BROWSE_LAB_MODEL, model);
  assert.ok(!Object.values(env).includes("deployment-key"));
  const token = env.BROWSE_LAB_MODEL_TOKEN!;
  assert.equal((await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET))?.browserAccount, "company");
  const post = () =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/browser-model/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "direct browser test" }] }),
    });
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(
    ((await first.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content,
    "DIRECT_OK",
  );
  await built.modelCredentials.set("anthropic", "rotated-admin-key", "U1");
  assert.equal((await post()).status, 200);
  assert.deepEqual(calls, [
    { key: "deployment-key", model },
    { key: "rotated-admin-key", model },
  ]);
  await built.modelCredentials.delete("anthropic", "U1");
  assert.equal((await post()).status, 503);
  assert.equal(calls.length, 2);
});
