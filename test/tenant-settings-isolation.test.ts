import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { requireTenantSetting, TenantSettingMissingError, type TenantSettingValues } from "../src/tenants/settings.ts";
import { createAgent } from "../src/agent/agent-run.ts";
import { configuredModelFor } from "../src/model/tenant-models.ts";
import type { BuiltApp } from "../src/wiring.ts";
import { buildApp, testTenantSettings } from "./support/build-app.ts";
import { TEST_TENANT } from "./support/tenant.ts";
import { testConfig } from "./support/test-config.ts";

const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const TENANT_C = "00000000-0000-4000-8000-00000000000c";

interface SeenRequest {
  path: string;
  gatewayKey: string | undefined;
  apiKey: string | undefined;
  model: unknown;
}

function anthropicReply(res: ServerResponse, model: unknown, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

async function startGateway(t: TestContext): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as { model?: unknown }) : {};
    const header = (name: string) =>
      typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined;
    seen.push({
      path: req.url ?? "",
      gatewayKey: header("x-gateway-key"),
      apiKey: header("x-api-key"),
      model: body.model,
    });
    const tenant = (req.url ?? "").split("/")[1];
    if (!req.url?.endsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      const listing = req.url?.endsWith("/v1/models") ? [{ id: `acme/opus-${tenant}` }] : [];
      return res.end(JSON.stringify({ data: listing }));
    }
    anthropicReply(res, body.model, `reply from gateway ${tenant}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function gatewaySettings(url: string, name: string): TenantSettingValues {
  return {
    PI_MODEL: "claude-opus-5",
    MODEL_GATEWAY_URL: `${url}/${name}`,
    MODEL_GATEWAY_API_KEY: `gateway-key-${name}`,
    MODEL_GATEWAY_API_KEY_HEADER: "x-gateway-key",
    MODEL_GATEWAY_MODELS: `claude-opus-5=acme/opus-${name}`,
  };
}

function turnInput(threadRef: string, text: string) {
  return {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef },
    text,
  };
}

function agentOf(built: BuiltApp) {
  return createAgent({
    defaultModelId: () => configuredModelFor(built.tenantSettings.peek()),
    resolveModelGateway: () => built.modelGatewayTransport(),
    resolveProviderKeys: () => built.resolveBrowserCompanyKeys(),
  });
}

test("an agent call under each tenant reaches only that tenant's gateway with that tenant's key", async (t) => {
  const gateway = await startGateway(t);
  const tenantSettings = testTenantSettings(gatewaySettings(gateway.url, "a"));
  await withTenant(TENANT_B, () => tenantSettings.update(gatewaySettings(gateway.url, "b")));
  const built = buildApp(testConfig(), { tenantSettings });
  const agent = agentOf(built);

  const replyA = await withTenant(TEST_TENANT, () => agent.oneShot!("Reply briefly", "hello from a"));
  assert.equal(replyA, "reply from gateway a");
  const seenByA = gateway.seen.splice(0);
  const messagesA = seenByA.filter((r) => r.path.endsWith("/v1/messages"));
  assert.equal(messagesA.length, 1);
  assert.equal(messagesA[0]!.model, "acme/opus-a");
  for (const request of seenByA) {
    assert.ok(request.path.startsWith("/a/"), `tenant A request went to ${request.path}`);
    assert.equal(request.gatewayKey, "gateway-key-a");
  }

  const replyB = await withTenant(TENANT_B, () => agent.oneShot!("Reply briefly", "hello from b"));
  assert.equal(replyB, "reply from gateway b");
  const seenByB = gateway.seen.splice(0);
  const messagesB = seenByB.filter((r) => r.path.endsWith("/v1/messages"));
  assert.equal(messagesB.length, 1);
  assert.equal(messagesB[0]!.model, "acme/opus-b");
  for (const request of seenByB) {
    assert.ok(request.path.startsWith("/b/"), `tenant B request went to ${request.path}`);
    assert.equal(request.gatewayKey, "gateway-key-b");
    assert.notEqual(request.apiKey, "gateway-key-a");
  }

  const again = await withTenant(TEST_TENANT, () => agent.oneShot!("Reply briefly", "hello again from a"));
  assert.equal(again, "reply from gateway a");
  assert.ok(gateway.seen.splice(0).every((r) => r.path.startsWith("/a/") && r.gatewayKey === "gateway-key-a"));
});

test("a tenant without gateway settings or keys never borrows another tenant's gateway", async (t) => {
  const gateway = await startGateway(t);
  const tenantSettings = testTenantSettings(gatewaySettings(gateway.url, "a"));
  await withTenant(TENANT_C, () => tenantSettings.update({ PI_MODEL: "claude-opus-5" }));
  const built = buildApp(testConfig(), { tenantSettings });
  const agent = agentOf(built);
  assert.equal(await withTenant(TEST_TENANT, () => agent.oneShot!("Reply briefly", "warm a")), "reply from gateway a");
  gateway.seen.splice(0);
  assert.equal(await withTenant(TENANT_C, () => built.modelGatewayTransport()), undefined);
  assert.deepEqual(await withTenant(TENANT_C, () => built.resolveBrowserCompanyKeys()), {});
  assert.equal(await withTenant(TENANT_C, () => agent.oneShot!("Reply briefly", "hello from c")), undefined);
  assert.deepEqual(gateway.seen, []);
});

test("a missing tenant setting fails closed with the setting's name", async () => {
  const tenantSettings = testTenantSettings({});
  const built = buildApp(testConfig(), { tenantSettings });
  const settings = await withTenant(TENANT_C, () => built.tenantSettings.get());
  assert.throws(
    () => requireTenantSetting(settings, "MODEL_GATEWAY_API_KEY"),
    (error: unknown) =>
      error instanceof TenantSettingMissingError &&
      error.message === "MODEL_GATEWAY_API_KEY is not set in this tenant's settings",
  );
});

test("tenant-owned settings and model routes refuse to resolve with no tenant bound", async (t) => {
  const gateway = await startGateway(t);
  const tenantSettings = testTenantSettings(gatewaySettings(gateway.url, "a"));
  const built = buildApp(testConfig(), { tenantSettings });
  await withoutTenant(async () => {
    await assert.rejects(async () => built.tenantSettings.get(), /No tenant is bound/);
    await assert.rejects(async () => built.modelGatewayTransport(), /No tenant is bound/);
    await assert.rejects(async () => built.modelCredentials.availability(), /No tenant is bound/);
    await assert.rejects(async () => built.resolveBrowserCompanyKeys(), /No tenant is bound/);
  });
  assert.deepEqual(gateway.seen, []);
});

test("a tenant's security screen proxy classifies only that tenant's turns", async (t) => {
  const screened: Array<{ endpoint: string; token: string | null }> = [];
  const passthrough = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://screen-")) return passthrough(input, init);
    screened.push({ endpoint: url, token: new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify({ score: 0, threshold: 0.7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const proxy = (name: string): TenantSettingValues => ({
    SECURITY_SCREEN: "enforce",
    SECURITY_SCREEN_CLASSIFIER: "proxy",
    SECURITY_SCREEN_PROXY_PROVIDER: `screen-${name}`,
    SECURITY_SCREEN_PROXY_ENDPOINT: `https://screen-${name}.example.test/classify`,
    SECURITY_SCREEN_PROXY_TOKEN: `screen-token-${name}`,
  });
  const tenantSettings = testTenantSettings(proxy("a"));
  await withTenant(TENANT_B, () => tenantSettings.update(proxy("b")));
  await withTenant(TENANT_C, () => tenantSettings.update({ SECURITY_SCREEN: "enforce" }));
  const built = buildApp(testConfig(), { tenantSettings });
  const screenedTurn = (tenant: string, threadRef: string) =>
    withTenant(tenant, () =>
      built.app.turn({
        ...turnInput(threadRef, "run the assigned task"),
        surface: "swarm",
        triggered: true,
        securityScreenData: `assigned task for ${threadRef}`,
      }),
    );

  await screenedTurn(TEST_TENANT, "screen-a-thread");
  const seenByA = screened.splice(0);
  assert.ok(seenByA.length > 0);
  assert.deepEqual(
    new Set(seenByA.map((s) => `${s.endpoint} ${s.token}`)),
    new Set(["https://screen-a.example.test/classify screen-token-a"]),
  );

  await screenedTurn(TENANT_B, "screen-b-thread");
  const seenByB = screened.splice(0);
  assert.ok(seenByB.length > 0);
  assert.deepEqual(
    new Set(seenByB.map((s) => `${s.endpoint} ${s.token}`)),
    new Set(["https://screen-b.example.test/classify screen-token-b"]),
  );

  await screenedTurn(TENANT_C, "screen-c-thread");
  assert.deepEqual(screened, []);
});
