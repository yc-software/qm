import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runInNewContext } from "node:vm";

const calls: Array<{ method: string; url: string; body: string; actor: string | null; signed: boolean }> = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body,
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ id: "acme-chat", name: "Acme Chat" }], total: 1, truncated: false }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-custom-provider-proxy-secret";
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

test("model discovery POST is signed and forwarded to Core", async () => {
  const payload = {
    providerId: "acme",
    protocol: "openai",
    baseUrl: "https://llm.acme.test/v1",
    apiKey: "sk-write-only",
  };
  const response = await fetch(`${base}/api/custom-providers/models`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    models: [{ id: "acme-chat", name: "Acme Chat" }],
    total: 1,
    truncated: false,
  });
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    url: "/v1/admin/custom-providers/models",
    body: JSON.stringify(payload),
    actor: "U-admin@acme",
    signed: true,
  });
});

test("model discovery POST rejects signed-out callers before Core", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/custom-providers/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "openai", baseUrl: "https://llm.acme.test/v1", apiKey: "secret" }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});

test("custom provider UI exposes model discovery and merges returned names", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="custom-provider-fetch-models"/);
  assert.match(html, /api\("POST", "\/api\/custom-providers\/models"/);
  assert.match(html, /mergeCustomModels\(current, result\.data\?\.models \|\| \[\]\)/);
  assert.match(html, /formFingerprint !== customProviderFormFingerprint\(\)/);
  const start = html.indexOf("function formatCustomModels");
  const end = html.indexOf("async function loadCustomProviders", start);
  assert.ok(start > 0 && end > start);
  const fields: Record<string, { value: string }> = {
    "custom-provider-id": { value: "acme" },
    "custom-provider-name": { value: "Acme" },
    "custom-provider-protocol": { value: "openai" },
    "custom-provider-url": { value: "https://acme.test/v1" },
    "custom-provider-key": { value: "secret" },
    "custom-provider-models": { value: "model-a" },
  };
  const context: Record<string, unknown> = { $: (id: string) => fields[id] };
  runInNewContext(html.slice(start, end), context);
  const merge = context.mergeCustomModels as (
    current: Array<{ id: string; name?: string }>,
    discovered: Array<{ id: string; name?: string }>,
  ) => { models: Array<{ id: string; name?: string }>; omitted: number };
  const current = Array.from({ length: 199 }, (_, index) => ({ id: `current-${index}` }));
  const merged = merge(current, [
    { id: "current-0", name: "Updated" },
    { id: "new-1", name: "New One" },
    { id: "new-2", name: "New Two" },
  ]);
  assert.equal(merged.models.length, 200);
  assert.equal(merged.omitted, 1);
  assert.equal(merged.models[0]?.name, "Updated");
  assert.equal(merged.models.at(-1)?.id, "new-1");
  const fingerprint = context.customProviderFormFingerprint as () => string;
  const before = fingerprint();
  fields["custom-provider-id"]!.value = "other";
  assert.notEqual(fingerprint(), before);
});

test("onboarding loads saved custom providers on first render", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("async function loadOnboarding()");
  const end = html.indexOf('$("onboarding-model-provider").onchange', start);
  assert.ok(start > 0 && end > start);
  assert.match(html.slice(start, end), /loadCustomProviders\(\)/);
});
