import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeId, type Destination, type TurnRequest } from "../src/types.ts";
import {
  buildApp,
  freshApp,
  internalActor,
  dm,
  channel,
  grantCred,
  captureProvision,
  signedConfig,
} from "./support/orchestrator-app.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import { runNowSettled } from "./support/settle.ts";
import { loadConfig } from "../src/config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { hashId } from "../src/util/crypto.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { testMap } from "./support/test-database.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import type { Agent } from "../src/agent/agent.ts";
import { brokerCredentialCall } from "../src/api/credential-broker.ts";
import { principalDestination } from "../src/reach/reach.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("a guest actor is refused (internal-only, input side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "test",
    actor: { externalId: "G1", isExternalGuest: true },
    conversation: { kind: "dm", threadRef: "dm:G1:t1" },
    text: "hi",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("a channel with a non-internal audience member is refused (internal-only, output side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "test",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "C1:t1",
      channelRef: "C1",
      audience: [internalActor, { externalId: "G9", isExternalGuest: true }],
    },
    text: "hello channel",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("a connector that acts as the person serves only their own turns: an attested one only in their DM, neither one a Slack bot's work in their name", async () => {
  const turns: Record<string, string> = {};
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    runTurn: async (input) => {
      const outcome = (e: Error) => (/acts as the person/.test(e.message) ? "refused" : "sent");
      const outcomes = await Promise.all(
        [input.tools.callMcpTool("records", { operation: "search" }), input.tools.callMcpTool("orders_search", {})].map(
          (call) => call.then(() => "answered", outcome),
        ),
      );
      turns[input.session.threadRef] = `${(input.mcpTools ?? []).map((tool) => tool.name)} ${outcomes}`;
      return mock.runTurn(input);
    },
  };
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")) });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const built = buildApp(config, { agent });
  const tools = [{ name: "search", description: "", inputSchema: {} }];
  for (const [id, partial] of [
    ["records", { attestActor: true }],
    ["wiki", {}],
    ["orders", { auth: "oauth-user", credentialScope: "per-user", credentialHost: "h.example", catalog: false, tools }],
  ] as const) {
    await built.mcpServers.put({
      id,
      name: id,
      url: `https://127.0.0.1:9/${id}/mcp`,
      auth: "bearer",
      bearerToken: "t",
      credentialScope: "shared",
      catalog: true,
      readOnly: true,
      enabled: true,
      updatedAt: Date.now(),
      updatedBy: "admin",
      ...partial,
    });
  }
  await built.connectorTokens.setConnectorToken("h.example", "U1", { accessToken: "u1-orders" });
  await built.mcpToolService.refresh();
  for (const request of [
    dm("hello"),
    channel("hello"),
    {
      surface: "test",
      actor: internalActor,
      conversation: { kind: "group" as const, threadRef: "grp:G1:t1", channelRef: "G1", audience: [internalActor] },
      text: "hello",
    },
    dm("hello", { botActor: true, conversation: { kind: "dm", threadRef: "dm:U1:bot" } }),
    channel("hello", { botActor: true, conversation: { ...channel("").conversation, threadRef: "ch:C1:bot" } }),
  ])
    assert.equal((await built.app.turn(request)).status, "ok");
  assert.deepEqual(turns, {
    "dm:U1:t1": "orders_search,records,wiki sent,sent",
    "ch:C1:t1": "orders_search,wiki refused,sent",
    "grp:G1:t1": "orders_search,wiki refused,sent",
    "dm:U1:bot": "wiki refused,refused",
    "ch:C1:bot": "wiki refused,refused",
  });
});

test("a scheduled turn attests its owner only when the answer goes back to the owner alone, and never when a Slack bot scheduled it", async (t) => {
  const knowledge = await startMcpTestServer(t, {
    tools: ["search_knowledge", "write_knowledge"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    clients: { ro: "x", rw: "y" },
  });
  const memoryProviderConfig = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: "knowledge",
          type: "mcp",
          url: knowledge.url,
          attestActor: true,
          read: { tool: "search_knowledge", clientIdEnv: "RO_ID", clientSecretEnv: "RO_SECRET" },
          write: { tool: "write_knowledge", clientIdEnv: "RW_ID", clientSecretEnv: "RW_SECRET" },
        },
      ],
      routes: [
        { provider: "default", scopes: ["personal"], capture: "automatic" },
        { provider: "knowledge", scopes: ["personal"], capture: "explicit", manage: false },
      ],
    }),
    { RO_ID: "ro", RO_SECRET: "x", RW_ID: "rw", RW_SECRET: "y" },
  );
  let turn: { offered: string[]; called: string; calledAny: string } | undefined;
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    runTurn: async (input) => {
      const call = (name: string) =>
        input.tools.callMcpTool(name, { operation: "search" }).then(
          () => "answered",
          (e: Error) => (/answers only to them/.test(e.message) ? "refused" : "sent"),
        );
      turn = {
        offered: (input.mcpTools ?? []).map((tool) => tool.name),
        called: await call("records"),
        calledAny: await call("shared"),
      };
      await input.tools.memoryAdd(["the launch moved to Friday"]);
      await input.tools.execute("echo broker", { credentials: ["attested-api", "shared-api"] });
      return mock.runTurn(input);
    },
  };
  const config = signedConfig({ memoryProviderConfig });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const { app, sandbox, serviceCreds, acl, deliveries, identity, mcpServers, mcpToolService } = buildApp(config, {
    agent,
  });
  for (const [id, attestActor] of [
    ["records", true],
    ["wiki", false],
    ["shared", true],
  ] as const) {
    await mcpServers.put({
      id,
      name: id,
      url: `https://127.0.0.1:9/${id}/mcp`,
      auth: "bearer",
      bearerToken: "t",
      credentialScope: "shared",
      catalog: true,
      ...(attestActor ? { attestActor } : {}),
      ...(id === "shared" ? { attestAudience: "any" as const } : {}),
      readOnly: true,
      enabled: true,
      updatedAt: Date.now(),
      updatedBy: "admin",
    });
  }
  await mcpToolService.refresh();
  const org = scopeId("org", "default-org");
  for (const [slug, injection] of [
    ["attested-api", { actor: true }],
    ["shared-api", { actor: true, audience: "any" as const }],
  ] as const) {
    await serviceCreds.setServiceCredential(org, {
      slug,
      name: slug,
      secret: "synthetic",
      host: "api.example.com",
      injection,
    });
    await grantCred(acl, org, slug);
  }
  let credentialToken: string | undefined;
  const run = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    if (command === "echo broker") credentialToken = handle.env?.AGENT_CREDENTIAL_TOKEN;
    return run(handle, command, opts);
  };
  const idempotency = createIdempotencyStore(testMap());
  const fire = async (
    name: string,
    destination: Destination,
    ownerScopeId = scopeId("personal", "U1"),
    surface = "cron",
    botActor = false,
  ) => {
    turn = undefined;
    credentialToken = undefined;
    const before = knowledge.requests.length;
    const out = await runTrigger(
      { deliveries, idempotency, identity, run: (req) => app.turn(req) },
      {
        owner: "U1",
        ownerScopeId,
        input: "how is the launch going?",
        fireKey: `${surface}:${name}:1`,
        surface,
        destination,
        botActor,
      },
    );
    assert.equal(out.status, "ok", out.note);
    const claims = (await verifyCapabilityToken(credentialToken!, TEST_CAPABILITY_SECRET))!;
    const broker = async (credential: string) => {
      const res = await brokerCredentialCall({
        tenant: tenant,
        claims,
        body: { credential, url: "https://api.example.com/v1/me" },
        orgScopeId: org,
        reader: serviceCreds,
        fetchImpl: async () => ({ status: 200, text: async () => "{}" }),
      });
      return (res.json as { error?: string }).error ?? res.status;
    };
    return {
      ...turn!,
      broker: await broker("attested-api"),
      brokerAny: await broker("shared-api"),
      memory: [
        ...new Set(
          knowledge.requests
            .slice(before)
            .filter((request) => request.rpc === "tools/call")
            .map((request) => request.actor),
        ),
      ],
    };
  };
  const refused = {
    offered: ["shared", "wiki"],
    called: "refused",
    calledAny: "sent",
    broker: "private_only",
    brokerAny: 200,
    memory: [],
  };
  const attested = {
    offered: ["records", "shared", "wiki"],
    called: "sent",
    calledAny: "sent",
    broker: 200,
    brokerAny: 200,
    memory: ["U1"],
  };
  installPrincipalLinks({
    canonical: (key) => (key === "u1@example.test" ? "U1" : undefined),
    aliases: () => [],
    userId: () => undefined,
    claim: () => {},
  });
  t.after(() => installPrincipalLinks(null));
  assert.deepEqual(
    {
      botDmToOwner: await fire("bot-dm-to-owner", principalDestination("U1", "U1"), undefined, undefined, true),
      dmToTeammate: await fire("dm-to-teammate", principalDestination("U2", "U1")),
      personalToChannel: await fire("personal-to-channel", {
        type: "slack",
        target: "C1",
        audienceScopeId: scopeId("channel", "C1"),
      }),
      channelToOwner: await fire("channel-to-owner", principalDestination("U1", "U1"), scopeId("channel", "C1")),
      dmToOwner: await fire("dm-to-owner", principalDestination("U1", "U1")),
      dmToOwnerAlias: await fire("dm-to-owner-alias", {
        ...principalDestination("U1", "U1"),
        audienceScopeId: scopeId("personal", "u1@example.test"),
      }),
      dmWebhookToTeammate: await fire("dm-webhook-to-teammate", principalDestination("U2", "U1"), undefined, "webhook"),
    },
    {
      botDmToOwner: { ...refused, offered: ["wiki"], calledAny: "refused", brokerAny: "private_only" },
      dmToTeammate: refused,
      personalToChannel: refused,
      channelToOwner: refused,
      dmToOwner: attested,
      dmToOwnerAlias: attested,
      dmWebhookToTeammate: refused,
    },
  );
});

test("a connector set to attest in any audience serves every person's channel turn, including unprompted and automated ones, but not bot turns", async () => {
  const offered: string[][] = [];
  const called: string[] = [];
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    shouldRespond: async () => ({ respond: true }),
    runTurn: async (input) => {
      offered.push((input.mcpTools ?? []).map((tool) => tool.name).sort());
      for (const name of ["records", "strict"])
        called.push(
          await input.tools.callMcpTool(name, { operation: "search" }).then(
            () => `${name} answered`,
            (e: Error) => `${name} ${/answers only to them/.test(e.message) ? "refused" : "sent"}`,
          ),
        );
      return mock.runTurn(input);
    },
  };
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")) });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const built = buildApp(config, { agent });
  for (const id of ["records", "strict"]) {
    await built.mcpServers.put({
      id,
      name: id,
      url: `https://127.0.0.1:9/${id}/mcp`,
      auth: "bearer",
      bearerToken: "t",
      credentialScope: "shared",
      catalog: true,
      attestActor: true,
      ...(id === "records" ? { attestAudience: "any" as const } : {}),
      readOnly: true,
      enabled: true,
      updatedAt: Date.now(),
      updatedBy: "admin",
    });
  }
  await built.mcpToolService.refresh();
  assert.equal((await built.app.turn(channel("hello"))).status, "ok");
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "c1", isPrivate: false }],
    [{ channelId: "C1", principalId: "U1" }],
  );
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() + 3600_000 },
    action: "check records",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await runNowSettled(built.scheduler, cron.id);
  for (const extra of [
    { origin: { kind: "ambient" as const, live: true } },
    { origin: { kind: "automation" as const } },
    { botActor: true },
  ])
    assert.equal((await built.app.turn(channel("hello", extra))).status, "ok");
  assert.deepEqual(offered, [["records"], ["records"], ["records"], ["records"], []]);
  assert.deepEqual(called, [
    "records sent",
    "strict refused",
    "records sent",
    "strict refused",
    "records sent",
    "strict refused",
    "records sent",
    "strict refused",
    "records refused",
    "strict refused",
  ]);
  assert.deepEqual(
    (await built.auditLog.tail(tenant, { limit: 20, action: "mcp.call", resourceContains: "records/search" }))
      .filter((event) => !/answers only to them/.test(event.status ?? ""))
      .map((event) => event.principalId),
    ["U1", "U1", "U1", "U1"],
  );
});

test("a turn's credential token says whether it may act as its actor in a shared conversation", async () => {
  const { app, sandbox, serviceCreds, acl } = freshApp({
    signingSecret: "test-secret",
    apiBaseUrl: "https://core.example.com",
  });
  await serviceCreds.setServiceCredential("org:default-org", {
    slug: "test-service",
    name: "Test service",
    secret: "synthetic",
    host: "api.example.com",
  });
  await grantCred(acl, "org:default-org", "test-service");
  let executed: Record<string, string> | undefined;
  const run = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    if (command === "echo who") executed = handle.env;
    return run(handle, command, opts);
  };
  const ask = `!execute ${JSON.stringify({ command: "echo who", credentials: ["test-service"] })}`;
  const actAsActor = async (request: TurnRequest) => {
    executed = undefined;
    assert.equal((await app.turn(request)).status, "ok");
    return (await verifyCapabilityToken(executed!.AGENT_CREDENTIAL_TOKEN!, TEST_CAPABILITY_SECRET))!.actAsActor;
  };
  assert.equal(await actAsActor(channel(ask, { botActor: true })), undefined);
  assert.equal(await actAsActor(channel(ask)), true);
  assert.equal(await actAsActor(channel(ask, { origin: { kind: "ambient", live: true } })), true);
  assert.equal(await actAsActor(channel(ask, { origin: { kind: "automation" } })), true);
});

for (const hours of [undefined, "72", "0", "none"]) {
  test(`sandbox-facing turn tokens honor deployment TTL ${hours ?? "default"}`, async () => {
    const ttl = loadConfig({ SANDBOX_CAPABILITY_TTL_HOURS: hours }).sandboxCapabilityTtlMs;
    const { app, sandbox, serviceCreds, acl } = freshApp({
      signingSecret: "test-secret",
      apiBaseUrl: "https://core.example.com",
      sandboxCapabilityTtlMs: ttl,
    });
    await serviceCreds.setServiceCredential("org:default-org", {
      slug: "test-service",
      name: "Test service",
      secret: "synthetic",
      host: "api.example.com",
    });
    await grantCred(acl, "org:default-org", "test-service");
    let captured: ProvisionOptions | undefined;
    let executed: Record<string, string> | undefined;
    const provision = sandbox.provision.bind(sandbox);
    sandbox.provision = (owner, opts) => {
      captured = opts;
      return provision(owner, opts);
    };
    const run = sandbox.run.bind(sandbox);
    sandbox.run = (handle, command, opts) => {
      if (command === "echo ttl") executed = handle.env;
      return run(handle, command, opts);
    };
    const before = Date.now();
    const res = await app.turn(
      dm(`!execute ${JSON.stringify({ command: "echo ttl", credentials: ["test-service"] })}`),
    );
    assert.equal(res.status, "ok", res.reason);
    const tokens = {
      AGENT_API_TOKEN: captured!.env!.AGENT_API_TOKEN!,
      AGENT_OAUTH_CONSENT_TOKEN: captured!.env!.AGENT_OAUTH_CONSENT_TOKEN!,
      AGENT_CREDENTIAL_TOKEN: executed!.AGENT_CREDENTIAL_TOKEN!,
      egressToken: captured!.egressToken!,
    };
    for (const [name, token] of Object.entries(tokens)) {
      const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
      assert.ok(claims, `${name} verifies`);
      if (ttl === 0) {
        assert.equal(claims.exp, 0);
        assert.ok(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, Number.MAX_SAFE_INTEGER));
      } else {
        assert.ok(claims.exp >= before + ttl && claims.exp <= Date.now() + ttl, name);
        assert.ok(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, claims.exp - 1));
        assert.equal(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, claims.exp), null);
      }
    }
  });
}

test("an admin owner's cron fire carries the owner's authority, including org-notebook write", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);
  const alice = { externalId: "admin-alice" };
  const fire = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
    surface: "cron",
    actor: alice,
    conversation: { kind: "dm", threadRef: "dm:admin-alice:owner-fire" },
    text: "!run echo fire",
    origin: { kind: "automation" },
    ...extra,
  });

  assert.equal((await app.turn(fire({ botActor: true }))).status, "ok");
  let claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, undefined, "a bot actor's automation turn carries no authority");

  captured.opts = undefined;
  assert.equal((await app.turn(fire())).status, "ok");
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, true, "an owner's fire attests the owner's authority");
  assert.equal(claims!.memory?.orgWrite, scopeId("org", "default-org"), "an admin's fire may write the org notebook");

  const prompt = await app.turn(
    fire({ text: "!sysprompt", conversation: { kind: "dm", threadRef: "dm:admin-alice:owner-fire-2" } }),
  );
  assert.match(prompt.reply ?? "", /## Acting for an org admin/, "an admin owner's fire gets the admin plane");
});

test("an org admin's turn carries org-notebook write (token claim + prompt hint); a regular user's does not", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);

  const adminTurn = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
    surface: "test",
    actor: { externalId: "admin-alice" },
    conversation: { kind: "dm", threadRef: "dm:admin-alice:t1" },
    text: "!run echo hi",
    origin: { kind: "human" },
    ...extra,
  });

  assert.equal((await app.turn(adminTurn())).status, "ok");
  const adminClaims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(adminClaims!.memory!.orgWrite, scopeId("org", "default-org"));
  assert.ok(adminClaims!.memory!.write, "the turn's own writable notebook is still claimed");
  assert.equal(adminClaims!.personAuthority, true, "a person's typed turn carries their authority in the token");

  const adminPrompt = await app.turn(
    adminTurn({ text: "!sysprompt", conversation: { kind: "dm", threadRef: "dm:admin-alice:t2" } }),
  );
  assert.match(adminPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(adminPrompt.reply ?? "", /use the hand-off skill even if admin access could reach it/);
  assert.match(adminPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);
  assert.match(adminPrompt.reply ?? "", /including resources owned by other users/);
  assert.match(adminPrompt.reply ?? "", /Ordinary resource-owner restrictions do not by themselves prohibit/);
  assert.match(adminPrompt.reply ?? "", /admin grant changes and impersonation are portal-only/);
  assert.doesNotMatch(
    adminPrompt.reply ?? "",
    /private-content reads work only from a DM|bulk configuration imports require/,
  );
  assert.match(adminPrompt.reply ?? "", /"scope":"org"/, "the org-notebook option rides in the admin hint");

  captured.opts = undefined;
  assert.equal((await app.turn(dm("!run echo hi"))).status, "ok");
  const userClaims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(userClaims!.memory!.orgWrite, undefined, "a non-admin turn must not carry org write");

  const userPrompt = await app.turn(dm("!sysprompt"));
  assert.doesNotMatch(userPrompt.reply ?? "", /## Acting for an org admin|System administration is not limited/);
});

test("admin reach rides turns with person authority and an all-internal audience — direct, DM detection and guest-audience turns mint a powerless token", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);
  const admin = { externalId: "admin-alice" };

  assert.equal(
    (
      await app.turn({
        surface: "cron",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:auto" },
        text: "!run echo hi",
      })
    ).status,
    "ok",
  );
  let claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, undefined, "a direct-origin turn carries no person authority");
  assert.equal(claims!.memory?.orgWrite, undefined);
  const autoPrompt = await app.turn({
    surface: "cron",
    actor: admin,
    conversation: { kind: "dm", threadRef: "dm:admin-alice:auto2" },
    text: "!sysprompt",
  });
  assert.doesNotMatch(autoPrompt.reply ?? "", /The sender is an org admin\./);

  captured.opts = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: {
          kind: "group",
          threadRef: "grp:G1:det",
          channelRef: "G1",
          audience: [admin],
          publishMembers: [admin, { externalId: "bob" }],
        },
        text: "!run echo hi",
        origin: { kind: "ambient", live: true },
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, true, "a live detection turn carries its author's authority");
  assert.equal(claims!.internalAudience, true, "an all-internal roster attests an internal audience");
  const threadPrompt = await app.turn({
    surface: "test",
    actor: admin,
    conversation: {
      kind: "group",
      threadRef: "grp:G1:det",
      channelRef: "G1",
      audience: [admin],
      publishMembers: [admin, { externalId: "bob" }],
    },
    text: "!sysprompt",
    origin: { kind: "ambient", live: true },
  });
  assert.match(threadPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(threadPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);
  assert.match(threadPrompt.reply ?? "", /The sender is an org admin\./);
  assert.equal(claims!.memory?.orgWrite, scopeId("org", "default-org"));

  captured.opts = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:det" },
        text: "!run echo hi",
        origin: { kind: "ambient", live: true },
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, undefined, "a DM detection turn carries no person authority");

  captured.opts = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "group", threadRef: "grp:G2:det", channelRef: "G2", audience: [admin] },
        text: "!run echo hi",
        origin: { kind: "ambient", live: true },
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.internalAudience, undefined, "an unattested room must not attest an internal audience");

  captured.opts = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:det2" },
        text: "!run echo hi",
        origin: { kind: "ambient" },
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.personAuthority, undefined, "a synthetic detection turn carries no person authority");

  captured.opts = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: {
          kind: "channel",
          threadRef: "ch:C9:t1",
          channelRef: "C9",
          audience: [admin],
          publishMembers: [admin, { externalId: "visitor", isExternalGuest: true }],
        },
        text: "!run echo hi",
        origin: { kind: "human" },
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.internalAudience, undefined, "a guest in the room means no internal audience");
  assert.equal(claims!.personAuthority, undefined, "a guest in the room means no person authority on the token");
  assert.equal(claims!.memory?.orgWrite, undefined);

  for (const publishMembers of [undefined, [] as { externalId: string; orgId: string }[]]) {
    captured.opts = undefined;
    assert.equal(
      (
        await app.turn({
          surface: "test",
          actor: admin,
          conversation: {
            kind: "channel",
            threadRef: `ch:C10:${publishMembers ? "empty" : "absent"}`,
            channelRef: "C10",
            audience: [admin],
            ...(publishMembers ? { publishMembers } : {}),
          },
          text: "!run echo hi",
          origin: { kind: "human" },
        })
      ).status,
      "ok",
    );
    claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
    assert.equal(claims!.internalAudience, undefined, "unknown room membership must not attest an internal audience");
    if (publishMembers === undefined) {
      assert.equal(
        claims!.members,
        undefined,
        "withheld publishMembers must not mint a scope-run cron member snapshot",
      );
    } else {
      assert.deepEqual(claims!.members, [], "empty publishMembers stays an empty scope-run snapshot");
    }
    assert.deepEqual(
      claims!.keychainMembers?.map((p) => p.id),
      ["admin-alice"],
    );
  }
});
