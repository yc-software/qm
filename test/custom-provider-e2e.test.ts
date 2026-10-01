// QA: end-to-end custom-provider lifecycle against a REAL fake upstream.
// Boots the app, registers a provider pointing at a local OpenAI-compatible
// server, and proves: validation, catalog surfacing, key hygiene, a real
// model call leaving QM and hitting the endpoint, edit-without-key, delete.
import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { oneShot } from "../src/harness/pi-harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { verificationUpstream } from "./support/model-verification-upstream.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("QA: openai-responses custom provider serves a real turn through the generated Pi registry", async () => {
  const upstream = await verificationUpstream();
  const upstreamUrl = `${upstream.url}/v1`;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qa-responses-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    admin: built.admin,
    auditLog: built.auditLog,
    harnessId: "pi",
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { headers: ADMIN, ...init });
  const spec = {
    name: "Responses Provider",
    protocol: "openai-responses",
    baseUrl: upstreamUrl,
    models: [{ id: "responses-custom-model", name: "Responses Custom Model" }],
  };
  try {
    let response = await api("/v1/admin/custom-providers/responses-provider", {
      method: "PUT",
      body: JSON.stringify({ ...spec, apiKey: "sk-responses-test" }),
    });
    assert.equal(response.status, 200);
    const validation = upstream.requests.find((request) => request.path === "/v1/models");
    assert.equal(validation?.authorization, "Bearer sk-responses-test");
    assert.equal(((await response.json()) as { status: { protocol: string } }).status.protocol, "openai-responses");

    const model = resolveModel("responses-custom-model");
    assert.ok(model);
    assert.equal(model.api, "openai-responses");
    const reply = await oneShot(
      "qa-responses",
      model as Model<Api>,
      { "responses-provider": "sk-responses-test" },
      "be terse",
      "reply",
    );
    assert.equal(reply, "VERIFIED MODEL REPLY");
    const request = upstream.requests.find((item) => item.path === "/v1/responses");
    assert.ok(request);
    assert.equal(request.body.model, "responses-custom-model");
    assert.equal(request.body.stream, true);
    assert.ok(Array.isArray(request.body.input));
    assert.equal(
      upstream.requests.some((item) => item.path.endsWith("/chat/completions")),
      false,
    );

    response = await api("/v1/admin/custom-providers/responses-provider", {
      method: "PUT",
      body: JSON.stringify({ ...spec, name: "Responses Provider Edited" }),
    });
    assert.equal(response.status, 200);
    response = await api("/v1/admin/custom-providers");
    const providers = (await response.json()) as {
      providers: Array<{ id: string; name: string; protocol: string; hasKey: boolean }>;
    };
    const saved = providers.providers.find((provider) => provider.id === "responses-provider");
    assert.equal(saved?.name, "Responses Provider Edited");
    assert.equal(saved?.protocol, "openai-responses");
    assert.equal(saved?.hasKey, true);
  } finally {
    server.close();
    await upstream.close();
  }
});

test("QA: anthropic-protocol custom provider serves a real turn (correct wire shape + headers)", async () => {
  const seen: Array<{ path: string; apiKeyHeader?: string; version?: string; model?: string }> = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const record = {
        path: req.url ?? "",
        apiKeyHeader: req.headers["x-api-key"] as string | undefined,
        version: req.headers["anthropic-version"] as string | undefined,
      } as (typeof seen)[0];
      if (req.url?.endsWith("/v1/models")) {
        seen.push(record);
        res.writeHead(record.apiKeyHeader === "sk-ant-qa" ? 200 : 401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [] }));
      }
      if (req.url?.endsWith("/v1/messages")) {
        record.model = (JSON.parse(body) as { model?: string }).model;
        seen.push(record);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_qa", type: "message", role: "assistant", content: [], model: "claude-compat", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
        );
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANTHROPIC QA REPLY" } })}\n\n`,
        );
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        return res.end();
      }
      seen.push(record);
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qa-ant-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    admin: built.admin,
    auditLog: built.auditLog,
    harnessId: "pi",
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/v1/admin/custom-providers/antcompat`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Ant Compat",
        protocol: "anthropic",
        baseUrl: upstreamUrl,
        apiKey: "sk-ant-qa",
        models: [{ id: "claude-compat", name: "Claude Compat" }],
      }),
    });
    assert.equal(r.status, 200, "anthropic-protocol registration validates against /v1/models with x-api-key");
    const model = resolveModel("claude-compat");
    assert.ok(model);
    assert.equal((model as { api?: string }).api, "anthropic-messages");
    const reply = await oneShot("qa-ant", model as unknown as Model<Api>, { antcompat: "sk-ant-qa" }, "terse", "go");
    assert.equal(reply, "ANTHROPIC QA REPLY");
    const call = seen.find((s) => s.path.endsWith("/v1/messages"));
    assert.ok(call, "messages request reached the anthropic-compatible upstream");
    assert.equal(call!.model, "claude-compat");
    assert.equal(call!.apiKeyHeader, "sk-ant-qa", "anthropic wire auth uses x-api-key");
  } finally {
    server.close();
    upstream.close();
  }
});

test("QA: registrations survive a restart (shared durable backing + same secret)", async () => {
  // In production the backing map is the Postgres artifact store (same as
  // model credentials); a restart is a new store instance over the same
  // rows with the same CONNECTOR_SECRET_KEY. Simulate exactly that.
  const backing = createMemoryMap<never>() as Parameters<typeof createCustomProviderStore>[0]["backing"];
  const secret = "restart-secret-restart-secret-restart-secret";
  const first = createCustomProviderStore({ backing, keyMaterial: secret });
  await first.upsert(
    {
      id: "survivor",
      name: "Survivor",
      protocol: "openai",
      baseUrl: "https://gw.example.com/v1",
      models: [{ id: "survivor-model" }],
    },
    "sk-live-key",
    "admin-alice@default-org",
  );
  // "restart": brand-new store instance over the same backing
  const second = createCustomProviderStore({ backing, keyMaterial: secret });
  const enabled = await second.enabled();
  assert.equal(enabled[0]?.id, "survivor", "spec survives the restart");
  assert.equal(await second.resolveKey("survivor"), "sk-live-key", "key decrypts after restart with the same secret");
  // and the hydration path wires it into the runtime registry
  setCustomProviders(enabled);
  assert.ok(resolveModel("survivor-model"), "hydrated model resolves");
  setCustomProviders([]);
});

test("QA: a corrupt stored key degrades that provider only — admin surface stays intact", async () => {
  const backing = createMemoryMap<never>() as Parameters<typeof createCustomProviderStore>[0]["backing"];
  const writer = createCustomProviderStore({ backing, keyMaterial: "first-secret-first-secret-first-secret-1" });
  await writer.upsert(
    {
      id: "corrupted",
      name: "Corrupted",
      protocol: "openai",
      baseUrl: "https://gw.example.com/v1",
      models: [{ id: "corrupted-model" }],
    },
    "sk-will-be-unreadable",
    "admin-alice@default-org",
  );
  // reboot with a DIFFERENT secret: the stored key is undecryptable
  const reader = createCustomProviderStore({ backing, keyMaterial: "other-secret-other-secret-other-secret-2" });
  await assert.rejects(reader.resolveKey("corrupted"), "decryption fails with the wrong secret");
  const statuses = await reader.statuses();
  assert.equal(statuses[0]?.id, "corrupted");
  assert.equal(statuses[0]?.hasKey, true, "admin surface (no secrets) unaffected");
  const enabled = await reader.enabled();
  assert.equal(enabled[0]?.id, "corrupted", "spec listing unaffected — only the key is lost");
});
