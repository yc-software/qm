import "./support/auto-fake-sprites.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { serverDeps } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
  CONTROL_PLANE_AUD,
  SANDBOX_MODEL_AUD,
} from "../src/auth/capability-token.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";

const key = "company-gateway-secret";
const endUser = createHmac("sha256", TEST_CAPABILITY_SECRET).update("U1").digest("hex").slice(0, 32);
const routes = {
  "claude-haiku-5-5": "router/claude-haiku-latest",
  "gpt-6-luna": "openai/gpt-6-luna",
};

async function listen(server: ReturnType<typeof httpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("sandbox SDK calls reach the company gateway with the sandbox token as their API key", async (t) => {
  const calls: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let status = 200;
  const upstream = httpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
      return void res.end(JSON.stringify({ error: { message: `rejected key ${key}` } }));
    }
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      return void res.end("event: message_stop\ndata: {}\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "scored" } }] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const config = testConfig({ signingSecret: "ingress-secret".repeat(3) });
  const built = buildApp(config);
  let overBudget = false;
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    modelGatewayTransport: { url: `${upstreamUrl}/v1`, apiKey: key, apiKeyHeader: "api-key", models: routes },
    budget: {
      check: async () => ({ allowed: !overBudget, spentUsd: 0, limitUsd: 1 }),
      record: async () => {},
    },
  });
  const base = `${await listen(server as unknown as ReturnType<typeof httpServer>)}/v1/sandbox-model`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const claims = { actorId: "U1", scopeId: "personal:U1" as const, aud: SANDBOX_MODEL_AUD, exp: Date.now() + 60_000 };
  const token = await mintCapabilityToken(claims, TEST_CAPABILITY_SECRET);
  const openai = (body: unknown, credential = token) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });

  const chat = { model: "gpt-6-luna", messages: [{ role: "user", content: "score this" }], user: "spoofed" };
  const response = await openai(chat);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "scored" } }] });
  assert.equal(calls[0]!.url, "/v1/chat/completions");
  assert.equal(calls[0]!.headers["api-key"], key);
  assert.equal(calls[0]!.headers.authorization, undefined);
  assert.deepEqual(calls[0]!.body, { ...chat, model: "openai/gpt-6-luna", user: endUser });
  assert.ok(!JSON.stringify(calls[0]!.body).includes("U1"));

  const messages = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 10,
      stream: true,
      messages: [],
      metadata: { user_id: "spoofed", trace: "t1" },
    }),
  });
  assert.equal(messages.status, 200);
  assert.equal(messages.headers.get("content-type"), "text/event-stream");
  assert.match(await messages.text(), /message_stop/);
  assert.equal(calls[1]!.url, "/v1/messages");
  assert.equal(calls[1]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[1]!.headers["x-api-key"], undefined);
  assert.equal(calls[1]!.body.model, "router/claude-haiku-latest");
  assert.deepEqual(calls[1]!.body.metadata, { user_id: endUser, trace: "t1" });

  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(
    ((await models.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id),
    Object.keys(routes),
  );

  const embeddings = await fetch(`${base}/v1/embeddings?encoding_format=float`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "gpt-6-luna", input: "x" }),
  });
  assert.equal(embeddings.status, 200);
  assert.equal(calls[2]!.url, "/v1/embeddings?encoding_format=float");
  assert.deepEqual(calls[2]!.body, { model: "openai/gpt-6-luna", input: "x", user: endUser });

  assert.equal((await openai({ ...chat, model: "gpt-4o" })).status, 400);
  assert.equal((await openai({ model: 7, messages: [] })).status, 400);
  assert.equal(
    (await openai(chat, await mintCapabilityToken({ ...claims, aud: CONTROL_PLANE_AUD }, TEST_CAPABILITY_SECRET)))
      .status,
    403,
  );
  assert.equal(
    (await openai(chat, await mintCapabilityToken({ ...claims, exp: 1 }, TEST_CAPABILITY_SECRET))).status,
    401,
  );
  assert.equal((await openai(chat, "not-a-token")).status, 401);
  assert.equal(calls.length, 3);

  status = 429;
  const limited = await openai(chat);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  assert.ok(!(await limited.text()).includes(key));
  for (const upstreamStatus of [401, 403, 500]) {
    status = upstreamStatus;
    assert.equal((await openai(chat)).status, 502, String(upstreamStatus));
  }
  status = 200;

  overBudget = true;
  assert.equal((await openai(chat)).status, 429);
  overBudget = false;
  await built.config.setSecurityPosture("personal:U1", "strict");
  assert.equal((await openai(chat)).status, 403);
  assert.equal(calls.length, 7);
});

test("a sandbox-model token is refused on every other route", async (t) => {
  const config = testConfig({ signingSecret: "ingress-secret".repeat(3) });
  const built = buildApp(config);
  const server = createServer(built.app, serverDeps(config, built));
  const base = await listen(server as unknown as ReturnType<typeof httpServer>);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const token = await mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", aud: SANDBOX_MODEL_AUD, exp: Date.now() + 60_000 },
    TEST_CAPABILITY_SECRET,
  );
  const control = await mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
    TEST_CAPABILITY_SECRET,
  );
  const browser = (headers: Record<string, string>) =>
    fetch(`${base}/v1/browser-model/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
  assert.equal((await browser({ "x-agent-capability": token })).status, 403);
  assert.equal((await browser({ authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await browser({ authorization: `Bearer ${control}` })).status, 401);
  const admin = await fetch(`${base}/v1/admin/model-providers`, { headers: { "x-agent-capability": token } });
  assert.equal(admin.status, 403);
});

test("gateway deployments hand the sandbox a gateway URL and turn token, never the gateway key", async () => {
  const config = testConfig({
    signingSecret: "ingress-secret".repeat(3),
    apiBaseUrl: "https://core.example.test/",
    modelGateway: { url: "https://models.invalid", apiKey: key, apiKeyHeader: "api-key", models: routes },
  });
  const built = buildApp(config, { modelCredentialFetch: async () => new Response("unavailable", { status: 503 }) });
  await selectDefaultSandbox(built, "U1", "personal:U1");
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  const turn = (text: string, thread: string) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `dm:U1:${thread}` },
      text,
    });
  assert.equal((await turn("!run echo models", "run")).status, "ok");
  const env = captured!.env!;
  assert.equal(env.MODEL_GATEWAY_URL, "https://core.example.test/v1/sandbox-model");
  assert.ok(!Object.values(env).includes(key));
  const claims = await verifyCapabilityToken(env.MODEL_GATEWAY_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, SANDBOX_MODEL_AUD);
  assert.equal(claims?.actorId, "U1");
  assert.equal(claims?.scopeId, "personal:U1");
  assert.match((await turn("!sysprompt", "prompt")).reply ?? "", /MODEL_GATEWAY_TOKEN/);

  await built.config.setSecurityPosture("personal:U1", "strict");
  assert.doesNotMatch((await turn("!sysprompt", "strict-prompt")).reply ?? "", /MODEL_GATEWAY/);
});

test("deployments without a gateway leave the sandbox gateway variables unset", async () => {
  const config = testConfig({ signingSecret: "ingress-secret".repeat(3), apiBaseUrl: "https://core.example.test" });
  const built = buildApp(config);
  await selectDefaultSandbox(built, "U1", "personal:U1");
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:no-gateway" },
    text: "!run echo none",
  });
  for (const name of ["MODEL_GATEWAY_URL", "MODEL_GATEWAY_TOKEN"]) assert.equal(captured?.env?.[name], undefined, name);
});
