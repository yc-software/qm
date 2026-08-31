import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  createMcpAuthoritySigner,
  mcpAuthoritySignerConfigFromEnv,
  type McpAuthoritySigner,
  type McpAuthorityPayload,
  type McpHumanCallContext,
} from "../src/mcp/mcp-authority.ts";
import { createMcpServerStore, type McpAllowedTool, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { parseMcpInputSchema, type McpFetch } from "../src/mcp/mcp-client.ts";
import { parseAnalyticsNativeDelivery } from "../src/mcp/mcp-native-card.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { analyticsNativeCardBlocks } from "../src/slack/native-cards.ts";
import { toSlackMrkdwn } from "../src/slack/mrkdwn.ts";

const keys = generateKeyPairSync("ed25519");
const signerConfig = {
  issuer: "qm:test",
  organizationId: "org-founder",
  principalId: "founder@example.com",
  slackTeamId: "T123",
  slackUserId: "U123",
  slackDmChannelId: "D123",
  privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  ttlSeconds: 30,
};
const context: McpHumanCallContext = {
  surface: "slack",
  conversationType: "dm",
  principalId: "founder@example.com",
  slackTeamId: "T123",
  slackUserId: "U123",
  slackChannelId: "D123",
  slackMessageTs: "1788119999.000001",
  slackThreadTs: "1788119999.000001",
  deliveryTarget: "D123",
};
const inputSchema = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 3, maxLength: 2_000 },
    account: { type: "string", minLength: 1, maxLength: 200 },
    person: { type: "string", minLength: 1, maxLength: 200 },
    priorReceiptHandle: { type: "string", minLength: 46, maxLength: 46 },
  },
  required: ["question"],
  additionalProperties: false,
};
const remoteTool = {
  name: "analytics_query",
  description: "Bounded analytics",
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const allowedTool: McpAllowedTool = {
  name: "analytics_query",
  label: "Analyze account",
  status: "Analyzing account",
  readOnly: true,
  inputSchema,
  requestAuthority: "qm.ed25519.founder-dm.v1",
  nativeRenderer: "qm.analytics.card.v1",
};
const server: McpServer = {
  id: "analytics",
  name: "Analytics",
  url: "https://analytics.example.com/api/mcp/analytics/mcp",
  auth: "none",
  scopes: [],
  allowedTools: [allowedTool],
  readOnly: true,
  enabled: true,
  credentialState: "none",
  updatedAt: 1,
  updatedBy: "UADMIN",
};

function response(id: number, result: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

function decodeAuthority(token: string): McpAuthorityPayload {
  const [encoded, signature] = token.split(".");
  assert.ok(encoded && signature);
  assert.equal(verify(null, Buffer.from(encoded, "ascii"), keys.publicKey, Buffer.from(signature, "base64url")), true);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as McpAuthorityPayload;
}

function delivery(authority: McpAuthorityPayload, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    delivery: {
      version: 1,
      renderer: "qm.analytics.card.v1",
      receiptId: "a".repeat(64),
      authority: {
        organizationId: authority.organizationId,
        principalId: authority.principalId,
        slackTeamId: authority.slackTeamId,
        slackUserId: authority.slackUserId,
        slackChannelId: authority.slackChannelId,
        slackConversationType: authority.slackConversationType,
        slackMessageTs: authority.slackMessageTs,
        slackThreadTs: authority.slackThreadTs,
        jti: authority.jti,
      },
      fallbackText: "Analytics result",
      heading: "Analytics · UC Online",
      question: "How is UC Online doing?",
      findings: [{ source: "posthog", topic: "usage", text: "Active usage is 12.", confidence: "high" }],
      confidenceNotes: ["Missing: clarify"],
      nextStep: "Review the evidence.",
      proposedActions: ["Draft an email."],
      ...over,
    },
  };
}

async function serviceWith(
  fetchImpl: McpFetch,
  withSigner = true,
  authoritySigner: McpAuthoritySigner = createMcpAuthoritySigner(signerConfig, () => 1_788_119_999_000),
  serverInput: McpServer = server,
) {
  const store = createMcpServerStore(
    createMemoryMap(),
    deriveConnectorKey("mcp-authority-test-key", "mcp-server-secrets"),
  );
  const service = createMcpToolService({
    servers: store,
    fetchImpl,
    audit: createAuditLog(),
    ...(withSigner ? { authoritySigner } : {}),
    refreshIntervalMs: 3_600_000,
  });
  await store.put(serverInput);
  await service.refresh();
  return service;
}

test("founder-DM signer binds canonical body and rejects every other user, team, channel, or surface", () => {
  const signer = createMcpAuthoritySigner(signerConfig, () => 1_788_119_999_000);
  const envelope = signer.sign("analytics_query", { question: "How is UC Online doing?" }, context);
  const payload = decodeAuthority(envelope.token);
  assert.equal(payload.bodySha256, "9933fef2fa384037708bb2ba23efe6e986823f3cec76ba4f60f8c17acfdc4ae2");
  assert.equal(payload.iat, 1_788_119_999);
  assert.equal(payload.exp, 1_788_120_029);
  for (const changed of [
    { principalId: "attacker@example.com" },
    { principalId: "U123" },
    { principalId: "Founder@example.com" },
    { principalId: " founder@example.com" },
    { principalId: undefined },
    { slackUserId: "U999" },
    { slackTeamId: "T999" },
    { slackChannelId: "D999" },
    { conversationType: "group" },
    { surface: "web" },
    { slackThreadTs: "bad" },
    { deliveryTarget: "D999" },
  ]) {
    assert.throws(() => signer.sign("analytics_query", {}, { ...context, ...changed } as McpHumanCallContext));
  }
  assert.throws(() =>
    signer.sign("analytics_query", {}, {
      ...context,
      slackTeamId: undefined,
      slackTeamIds: ["T123", "T999"],
    } as unknown as McpHumanCallContext),
  );
  assert.throws(() => signer.sign("other", {}, context));
  const unicodeBody = { "\uE000": "private", "😀": "surrogate" };
  const unicodePayload = decodeAuthority(signer.sign("analytics_query", unicodeBody, context).token);
  assert.equal(
    unicodePayload.bodySha256,
    createHash("sha256")
      .update(JSON.stringify({ "😀": "surrogate", "\uE000": "private" }))
      .digest("hex"),
  );
});

test("authority environment loading is default-off and rejects partial configuration", () => {
  assert.equal(mcpAuthoritySignerConfigFromEnv({}), undefined);
  assert.throws(() => mcpAuthoritySignerConfigFromEnv({ QM_MCP_AUTHORITY_ISSUER: "qm:test" }));
  assert.throws(() => createMcpAuthoritySigner({ ...signerConfig, ttlSeconds: 1 }));
});

test("the closed Command Center analytics schema is accepted without pattern support", () => {
  assert.deepEqual(parseMcpInputSchema(inputSchema), inputSchema);
});

test("signer configuration requires the same canonical email identity carried in authority payloads", () => {
  for (const principalId of [
    "U123ABC",
    "Founder@example.com",
    " founder@example.com",
    "founder@example.com ",
    "founder@example",
    "founder..name@example.com",
    "founder@example..com",
  ]) {
    assert.throws(() => createMcpAuthoritySigner({ ...signerConfig, principalId }), /signer configuration is invalid/);
    assert.throws(
      () =>
        mcpAuthoritySignerConfigFromEnv({
          QM_MCP_AUTHORITY_ISSUER: signerConfig.issuer,
          QM_MCP_AUTHORITY_ORGANIZATION_ID: signerConfig.organizationId,
          QM_MCP_AUTHORITY_PRINCIPAL_ID: principalId,
          QM_MCP_AUTHORITY_SLACK_TEAM_ID: signerConfig.slackTeamId,
          QM_MCP_AUTHORITY_SLACK_USER_ID: signerConfig.slackUserId,
          QM_MCP_AUTHORITY_SLACK_DM_CHANNEL_ID: signerConfig.slackDmChannelId,
          QM_MCP_AUTHORITY_ED25519_PRIVATE_KEY: signerConfig.privateKey,
          QM_MCP_AUTHORITY_TTL_SECONDS: String(signerConfig.ttlSeconds),
        }),
      /signer configuration is invalid/,
    );
  }
  const canonical = mcpAuthoritySignerConfigFromEnv({
    QM_MCP_AUTHORITY_ISSUER: signerConfig.issuer,
    QM_MCP_AUTHORITY_ORGANIZATION_ID: signerConfig.organizationId,
    QM_MCP_AUTHORITY_PRINCIPAL_ID: signerConfig.principalId,
    QM_MCP_AUTHORITY_SLACK_TEAM_ID: signerConfig.slackTeamId,
    QM_MCP_AUTHORITY_SLACK_USER_ID: signerConfig.slackUserId,
    QM_MCP_AUTHORITY_SLACK_DM_CHANNEL_ID: signerConfig.slackDmChannelId,
    QM_MCP_AUTHORITY_ED25519_PRIVATE_KEY: signerConfig.privateKey,
    QM_MCP_AUTHORITY_TTL_SECONDS: String(signerConfig.ttlSeconds),
  });
  assert.equal(canonical?.principalId, "founder@example.com");
  assert.equal(canonical?.slackUserId, "U123");
  assert.notEqual(canonical?.principalId, canonical?.slackUserId);
});

test("native analytics parser rejects remote blocks and QM renders bounded escaped Slack blocks", () => {
  const authority = decodeAuthority(
    createMcpAuthoritySigner(signerConfig, () => 1_788_119_999_000).sign(
      "analytics_query",
      { question: "How is UC Online doing?" },
      context,
    ).token,
  );
  assert.equal(parseAnalyticsNativeDelivery(delivery(authority, { blocks: [] }), authority), null);
  const parsed = parseAnalyticsNativeDelivery(
    delivery(authority, {
      fallbackText: "Ping <@U123> or @Alice & review",
      question: "How is UC Online doing?\nUse current evidence.",
      findings: [{ source: "posthog", topic: "usage", text: "<@here> & 12 active", confidence: "high" }],
    }),
    authority,
  );
  assert.ok(parsed);
  assert.equal(parsed.card.fallbackText, "Ping &lt;@\u200bU123&gt; or @\u200bAlice &amp; review");
  const rendered = JSON.stringify(analyticsNativeCardBlocks(parsed.card));
  assert.doesNotMatch(rendered, /<@here>/);
  assert.match(rendered, /&lt;@here&gt; &amp; 12 active/);
});

test("sealed analytics deliveries bind exact target and fixed authority through an explicit key overlap", () => {
  const oldSigner = createMcpAuthoritySigner(signerConfig, () => 1_788_119_999_000);
  const authority = decodeAuthority(
    oldSigner.sign("analytics_query", { question: "How is UC Online doing?" }, context).token,
  );
  const parsed = parseAnalyticsNativeDelivery(
    delivery(authority, { fallbackText: "Notify <!channel> <@U123> <https://evil.example|open> & review" }),
    authority,
  );
  assert.ok(parsed);
  const token = oldSigner.sealAnalyticsCard(parsed.unsignedCard, authority, "D123");
  const verified = oldSigner.verifyAnalyticsCard(token, "D123");
  assert.equal(
    verified?.fallbackText,
    "Notify &lt;!channel&gt; &lt;@​U123&gt; &lt;https:​//evil.example|open&gt; &amp; review",
  );
  assert.doesNotMatch(toSlackMrkdwn(verified!.fallbackText), /<!(?:channel|here|everyone)>|<@U|<https:/);
  assert.equal(oldSigner.verifyAnalyticsCard(token, "D123:1788119999.000001"), null);

  const [encoded, signature] = token.split(".");
  assert.ok(encoded && signature);
  const changed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  changed.card.findings[0].text = "Invented finding";
  const tampered = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
  assert.equal(oldSigner.verifyAnalyticsCard(tampered, "D123"), null);

  const nextKeys = generateKeyPairSync("ed25519");
  const rotatingSigner = createMcpAuthoritySigner({
    ...signerConfig,
    privateKey: nextKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    previousPublicKeys: [keys.publicKey.export({ format: "der", type: "spki" }).toString("base64")],
  });
  assert.equal(rotatingSigner.verifyAnalyticsCard(token, "D123")?.receiptId, "a".repeat(64));
  for (const [configOverride, contextOverride] of [
    [{ issuer: "qm:other" }, {}],
    [{ organizationId: "org-other" }, {}],
    [{ principalId: "other@example.com" }, { principalId: "other@example.com" }],
    [{ slackTeamId: "T999" }, { slackTeamId: "T999" }],
    [{ slackUserId: "U999" }, { slackUserId: "U999" }],
    [{ slackDmChannelId: "D999" }, { slackChannelId: "D999", deliveryTarget: "D999" }],
  ] as const) {
    const priorIdentitySigner = createMcpAuthoritySigner(
      { ...signerConfig, ...configOverride },
      () => 1_788_119_999_000,
    );
    const priorContext = { ...context, ...contextOverride };
    const priorAuthority = decodeAuthority(
      priorIdentitySigner.sign("analytics_query", { question: "How is UC Online doing?" }, priorContext).token,
    );
    const priorDelivery = parseAnalyticsNativeDelivery(delivery(priorAuthority), priorAuthority);
    assert.ok(priorDelivery);
    const priorTarget = priorContext.deliveryTarget;
    const priorToken = priorIdentitySigner.sealAnalyticsCard(priorDelivery.unsignedCard, priorAuthority, priorTarget);
    assert.equal(rotatingSigner.verifyAnalyticsCard(priorToken, priorTarget), null);
  }
  const noOverlap = createMcpAuthoritySigner({
    ...signerConfig,
    privateKey: nextKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  assert.equal(noOverlap.verifyAnalyticsCard(token, "D123"), null);
});

test("tool service injects authority only on tools/call and accepts one exact authority-bound native card", async () => {
  const seen: Array<{ method: string; authority?: string }> = [];
  const fetchImpl: McpFetch = async (_url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string };
    const authorityToken = init.headers["x-risely-qm-authority"];
    seen.push({ method: request.method, ...(authorityToken ? { authority: authorityToken } : {}) });
    if (request.method === "tools/list") return response(request.id, { tools: [remoteTool] });
    assert.ok(authorityToken);
    const authority = decodeAuthority(authorityToken);
    return response(request.id, {
      content: [{ type: "text", text: JSON.stringify({ answer: 12 }) }],
      structuredContent: delivery(authority),
    });
  };
  const service = await serviceWith(fetchImpl);
  const result = await service.callWithContext(
    "analytics_analytics_query",
    { question: "How is UC Online doing?" },
    context,
    "founder@example.com",
  );
  assert.equal(result.text, JSON.stringify({ answer: 12 }));
  assert.ok(result.trustedAnalyticsCard);
  assert.equal(
    createMcpAuthoritySigner(signerConfig).verifyAnalyticsCard(result.trustedAnalyticsCard, "D123")?.renderer,
    "qm.analytics.card.v1",
  );
  assert.equal(result.nativeCardIdempotencyKey, `mcp-card:${"a".repeat(64)}`);
  assert.ok(seen.filter((entry) => entry.method === "tools/list").every((entry) => !entry.authority));
  assert.equal(seen.filter((entry) => entry.method === "tools/call").length, 1);
  assert.ok(seen.find((entry) => entry.method === "tools/call")?.authority);
  service.close();
});

test("cold discovery delay cannot age the authority envelope before tools/call dispatch", async () => {
  const initialClock = 1_788_119_900_000;
  let clock = initialClock;
  let signCount = 0;
  const events: string[] = [];
  const baseSigner = createMcpAuthoritySigner(signerConfig, () => clock);
  const observedSigner: McpAuthoritySigner = {
    ...baseSigner,
    sign(tool, body, callContext) {
      signCount += 1;
      events.push("sign");
      return baseSigner.sign(tool, body, callContext);
    },
  };
  const fetchImpl: McpFetch = async (url, init) => {
    if (url === "https://auth.example.com/oauth/token") {
      events.push("oauth");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3_600 }),
      };
    }
    const request = JSON.parse(init.body) as { id: number; method: string };
    if (request.method === "tools/list") {
      events.push("list");
      assert.equal(signCount, 0, "the envelope must not exist during cold discovery or contract revalidation");
      clock += 45_000;
      return response(request.id, { tools: [remoteTool] });
    }
    events.push("call");
    assert.equal(init.headers.authorization, "Bearer oauth-token");
    assert.equal(signCount, 1);
    const authority = decodeAuthority(init.headers["x-risely-qm-authority"]!);
    assert.equal(authority.iat, Math.floor(clock / 1_000));
    assert.equal(authority.exp - authority.iat, signerConfig.ttlSeconds);
    assert.ok(Math.floor(initialClock / 1_000) + signerConfig.ttlSeconds <= Math.floor(clock / 1_000));
    assert.ok(authority.exp > Math.floor(clock / 1_000));
    return response(request.id, {
      content: [{ type: "text", text: "fresh" }],
      structuredContent: delivery(authority),
    });
  };
  const service = await serviceWith(fetchImpl, true, observedSigner, {
    ...server,
    auth: "client-credentials",
    clientId: "qm-analytics",
    clientSecret: "secret",
    tokenUrl: "https://auth.example.com/oauth/token",
    audience: "https://analytics.example.com/api/mcp/analytics/mcp",
    tokenAuthMethod: "client_secret_basic",
    tokenAudienceParameter: "audience",
    scopes: ["analytics:read"],
    credentialState: "ready",
  });
  const result = await service.callWithContext(
    "analytics_analytics_query",
    { question: "How is UC Online doing?" },
    context,
    "founder@example.com",
  );
  assert.equal(result.text, "fresh");
  assert.ok(events.indexOf("oauth") < events.indexOf("sign"));
  assert.ok(events.lastIndexOf("list") < events.indexOf("sign"));
  assert.equal(events.at(-2), "sign");
  assert.equal(events.at(-1), "call");
  service.close();
});

test("missing signer and tampered native-card authority fail closed", async () => {
  let calls = 0;
  const noSigner = await serviceWith(async (_url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string };
    if (request.method === "tools/call") calls += 1;
    return response(request.id, { tools: [remoteTool] });
  }, false);
  await assert.rejects(
    () =>
      noSigner.callWithContext(
        "analytics_analytics_query",
        { question: "How is UC Online doing?" },
        context,
        "founder@example.com",
      ),
    /authority is unavailable/,
  );
  assert.equal(calls, 0);
  noSigner.close();

  const tampered = await serviceWith(async (_url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string };
    if (request.method === "tools/list") return response(request.id, { tools: [remoteTool] });
    const authority = decodeAuthority(init.headers["x-risely-qm-authority"]!);
    return response(request.id, {
      content: [{ type: "text", text: "result" }],
      structuredContent: delivery(authority, {
        authority: {
          organizationId: authority.organizationId,
          principalId: authority.principalId,
          slackTeamId: authority.slackTeamId,
          slackUserId: "U999",
          slackChannelId: authority.slackChannelId,
          slackConversationType: authority.slackConversationType,
          slackMessageTs: authority.slackMessageTs,
          slackThreadTs: authority.slackThreadTs,
          jti: authority.jti,
        },
      }),
    });
  });
  await assert.rejects(
    () =>
      tampered.callWithContext(
        "analytics_analytics_query",
        { question: "How is UC Online doing?" },
        context,
        "founder@example.com",
      ),
    /native renderer result is invalid/,
  );
  tampered.close();
});
