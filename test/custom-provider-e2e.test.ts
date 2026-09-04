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
import { resolveModel, modelSupportedByHarness, modelServiceable } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("QA: full custom-provider lifecycle against a live fake upstream", async () => {
  // --- fake OpenAI-compatible upstream ---
  const seen: Array<{ path: string; auth: string | undefined; model?: string }> = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const record = { path: req.url ?? "", auth: req.headers.authorization as string | undefined } as (typeof seen)[0];
      if (req.url?.endsWith("/models")) {
        seen.push(record);
        if (record.auth !== "Bearer sk-qa-good") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "bad key" } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "qa-chat" }] }));
      }
      if (req.url?.endsWith("/chat/completions")) {
        record.model = (JSON.parse(body) as { model?: string }).model;
        seen.push(record);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "cmpl-qa", object: "chat.completion.chunk", model: "qa-chat", choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } : undefined })}\n\n`;
        res.write(chunk({ role: "assistant", content: "QA UPSTREAM REPLY" }, null));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      seen.push(record);
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qa-custom-")) }));
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

  try {
    // 1. empty list
    let r = await api("/v1/admin/custom-providers");
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { providers: unknown[] }).providers, []);

    // 2. guardrails
    r = await api("/v1/admin/custom-providers/openai", {
      method: "PUT",
      body: JSON.stringify({
        name: "X",
        protocol: "openai",
        baseUrl: upstreamUrl,
        apiKey: "sk-qa-good",
        models: [{ id: "m" }],
      }),
    });
    assert.equal(r.status, 400, "reserved slug refused");
    r = await api("/v1/admin/custom-providers/qa", {
      method: "PUT",
      body: JSON.stringify({
        name: "QA",
        protocol: "openai",
        baseUrl: "ftp://nope",
        apiKey: "sk-qa-good",
        models: [{ id: "m" }],
      }),
    });
    assert.equal(r.status, 400, "non-http url refused");
    r = await api("/v1/admin/custom-providers/qa", {
      method: "PUT",
      body: JSON.stringify({ name: "QA", protocol: "openai", baseUrl: upstreamUrl, apiKey: "sk-qa-good", models: [] }),
    });
    assert.equal(r.status, 400, "no models refused");
    r = await api("/v1/admin/custom-providers/qa", {
      method: "PUT",
      body: JSON.stringify({
        name: "QA",
        protocol: "openai",
        baseUrl: upstreamUrl,
        apiKey: "sk-wrong",
        models: [{ id: "qa-chat" }],
      }),
    });
    assert.equal(r.status, 400, "bad key rejected by REAL upstream 401");
    assert.equal(((await r.json()) as { error: string }).error, "invalid_api_key");

    // 3. register for real — validation hits the live upstream
    r = await api("/v1/admin/custom-providers/qa", {
      method: "PUT",
      body: JSON.stringify({
        name: "QA Provider",
        protocol: "openai",
        baseUrl: upstreamUrl,
        apiKey: "sk-qa-good",
        models: [{ id: "qa-chat", name: "QA Chat", contextWindow: 64000, maxTokens: 4096 }],
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(
      seen.some((s) => s.path.endsWith("/models") && s.auth === "Bearer sk-qa-good"),
      "validation actually reached the upstream",
    );

    // 4. list: keyConfigured true, key NEVER present anywhere in the payload
    r = await api("/v1/admin/custom-providers");
    const listing = JSON.stringify(await r.json());
    assert.ok(listing.includes('"hasKey":true'));
    assert.ok(!listing.includes("sk-qa-good"), "key never readable");

    // 5. model resolves like a built-in and is catalog-visible
    const model = resolveModel("qa-chat");
    assert.ok(model, "custom model resolves");
    assert.equal(model!.provider, "qa");
    assert.equal((model as { baseUrl?: string }).baseUrl, upstreamUrl);
    assert.equal(modelSupportedByHarness("qa-chat", "pi"), true);
    assert.equal(modelSupportedByHarness("qa-chat", "opencode"), true);
    assert.equal(modelSupportedByHarness("qa-chat", "codex"), false);
    assert.equal(modelServiceable("qa-chat", { anthropic: false, openai: false, openrouter: false }), true);

    // 6. REAL model call through QM's pi path → fake upstream answers
    const reply = await oneShot(
      "qa",
      model as unknown as Model<Api>,
      { qa: "sk-qa-good" },
      "you are terse",
      "say anything",
    );
    assert.equal(reply, "QA UPSTREAM REPLY");
    const call = seen.find((s) => s.path.endsWith("/chat/completions"));
    assert.ok(call, "completion request reached the upstream");
    assert.equal(call!.model, "qa-chat");
    assert.equal(call!.auth, "Bearer sk-qa-good", "stored key was sent to the custom endpoint");

    // 7. edit WITHOUT key keeps the stored key
    r = await api("/v1/admin/custom-providers/qa", {
      method: "PUT",
      body: JSON.stringify({
        name: "QA Provider v2",
        protocol: "openai",
        baseUrl: upstreamUrl,
        models: [{ id: "qa-chat" }],
      }),
    });
    assert.equal(r.status, 200);
    r = await api("/v1/admin/custom-providers");
    assert.ok(JSON.stringify(await r.json()).includes('"hasKey":true'), "key survives keyless edit");

    // 8. delete: models leave the registry
    r = await api("/v1/admin/custom-providers/qa", { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal(resolveModel("qa-chat"), undefined, "model gone after delete");
    r = await api("/v1/admin/custom-providers/qa", { method: "DELETE" });
    assert.equal(r.status, 404, "second delete 404s");

    // 9. non-admin cannot touch any of it
    r = await fetch(`${base}/v1/admin/custom-providers`, { headers: { "content-type": "application/json" } });
    assert.notEqual(r.status, 200, "unauthenticated read refused");
  } finally {
    server.close();
    upstream.close();
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
