import { externalSlackNamespace } from "../src/slack/external-access.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { verifyCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { externalTools } from "../src/core/orchestrator/external-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { TurnRequest } from "../src/types.ts";

const policy = { companyDomains: ["example.com"], serviceCredentials: ["safe"] };
const externalSlackPolicies = { batch: policy };
const namespace = externalSlackNamespace("T1", policy);
function request(text: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U1" },
    origin: { kind: "human" },
    externalSlack: {
      accountId: "batch",
      teamId: "T1",
      userId: "U1",
      companyDomains: ["example.com"],
      serviceCredentials: ["safe"],
    },
    conversation: {
      kind: "channel",
      channelRef: `${namespace}:C1`,
      threadRef: `${namespace}:C1:thread`,
      audience: [{ externalId: "U1" }, { externalId: "outsider", isExternalGuest: true }],
    },
    text,
  };
}

test("external Slack strips private and org preloads before the prompt, but keeps shared-safe code useful", async (t) => {
  const b = buildApp(
    testConfig({
      memoryCapture: "off",
      externalSlackPolicies,
      signingSecret: "synthetic-signing-key",
      apiBaseUrl: "https://core.example.test",
    }),
  );
  await b.config.hydrate?.();
  await b.identity.hydrate();
  await b.deploymentLayerReady;
  t.after(async () => {
    b.scheduler.stop();
    b.deploymentLayerRefresh.stop();
    await b.runtime.stop();
  });
  await b.config.setSharingPosture("org:default-org", "open");
  b.config.setSoul("org:default-org", "ORG_SOUL_SENTINEL");
  await b.memory.capture("personal:U1", ["PERSONAL_MEMORY_SENTINEL"], Date.now(), "U1");
  await b.memory.capture("org:default-org", ["ORG_MEMORY_SENTINEL"], Date.now(), "U1");
  await b.workspace.write("org:default-org", "secret.txt", "ORG_FILE_SENTINEL");
  await b.workspace.write("personal:U1", "secret.txt", "PERSONAL_FILE_SENTINEL");
  for (const slug of ["safe", "confidential"]) {
    await b.serviceCreds.setServiceCredential("org:default-org", {
      slug,
      name: slug,
      delivery: "env",
      envKey: slug.toUpperCase(),
      secret: `SYNTHETIC_${slug}`,
      host: "",
    });
    await b.acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "U1",
    });
  }
  const mustNotRead = async (): Promise<never> => {
    throw new Error("PRIVATE_PRELOAD_CALLED");
  };
  b.keychain!.listByOwners = mustNotRead;
  b.keychain!.listByOwner = mustNotRead;
  b.keychain!.grantsForScope = mustNotRead;
  b.keychain!.listConnectorsByOwners = mustNotRead;
  const prompt = await b.app.turn(request("!sysprompt"));
  assert.equal(prompt.status, "ok", JSON.stringify(prompt));
  assert.doesNotMatch(
    prompt.reply!,
    /PERSONAL_MEMORY_SENTINEL|ORG_MEMORY_SENTINEL|ORG_SOUL_SENTINEL|PERSONAL_FILE_SENTINEL|ORG_FILE_SENTINEL|service_confidential/,
  );
  assert.match(prompt.reply!, /service_safe/);
  const provisions: string[][] = [];
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = (layers, opts) => {
    provisions.push(layers.map((l) => l.scopeId));
    return provision(layers, opts);
  };
  const run = b.sandbox.run.bind(b.sandbox);
  const seenClaims: CapabilityClaims[] = [];
  let safeEnv;
  b.sandbox.run = async (handle, command, opts) => {
    if (handle.env?.AGENT_API_TOKEN)
      seenClaims.push((await verifyCapabilityToken(handle.env.AGENT_API_TOKEN, TEST_CAPABILITY_SECRET))!);
    if (handle.env?.SAFE) safeEnv = handle.env.SAFE;
    assert.equal(handle.env?.CONFIDENTIAL, undefined);
    return run(handle, command, opts);
  };
  const code = await b.app.turn(
    request(`!execute ${JSON.stringify({ command: "printf external-code-ok", credentials: ["service_safe"] })}`),
  );
  assert.equal(code.status, "ok", JSON.stringify(code));
  assert.match(code.reply!, /external-code-ok/);
  assert.equal(safeEnv, "SYNTHETIC_safe");
  assert.ok(provisions.length);
  assert.ok(provisions.every((scopes) => scopes.every((scope) => scope.startsWith("channel:external-slack:"))));
  assert.equal(seenClaims.at(-1)?.externalSlack, true);
  assert.equal(seenClaims.at(-1)?.ownerConnections, undefined);
  assert.equal(seenClaims.at(-1)?.memory, undefined);
  const missing = request("!sysprompt");
  delete missing.externalSlack;
  assert.equal((await b.app.turn(missing)).status, "refused");
});

test("external native tool ceiling cannot delegate, switch sandboxes, read confidential data or invoke MCP", async () => {
  let runs = 0;
  const tools = externalTools(
    new Proxy({} as ToolContext, {
      get: () => () => {
        runs++;
        return Promise.resolve("ok");
      },
    }),
  );
  await tools.execute("printf safe");
  assert.equal(runs, 1);
  for (const opts of [{ scratch: true }, { ownerAuth: true }, { reachTarget: "private" }, { sandboxId: "private" }])
    await assert.rejects(tools.execute("unsafe", opts), /private access/);
  for (const call of [
    () => tools.memoryRead(),
    () => tools.read("global/secret"),
    () => tools.callMcpTool("private", {}),
    () => tools.cronList(),
  ])
    assert.throws(call, /private access/);
  assert.equal(tools.sessionSyscalls, undefined);
  assert.deepEqual(tools.mcpToolDefs(), []);
  assert.equal(runs, 1);
});

test("external broker requires the current run lease and both external-safe and ordinary grants", async () => {
  const { externalSlackCapabilityAllowed } = await import("../src/api/external-slack-capability.ts");
  const { createMemoryRunStore } = await import("../src/runs/memory-run-store.ts");
  const { createAclStore } = await import("../src/acl/acl-store.ts");
  const { runs } = createMemoryRunStore();
  const acl = createAclStore();
  const req = request("test");
  const { run: queued } = await runs.enqueue({
    sessionId: req.conversation.threadRef,
    request: {
      ...req,
      actor: { id: "U1", type: "internal" },
      conversation: { ...req.conversation, publishMembers: undefined, audience: [{ id: "U1", type: "internal" }] },
      origin: { kind: "human" },
    },
  });
  const run = (await runs.claimById(queued.id, "test-worker", 60_000))!;
  const claims: CapabilityClaims = {
    actorId: "U1",
    scopeId: `channel:${namespace}:C1`,
    aud: "credential-broker",
    externalSlack: true,
    credentials: ["safe"],
    runId: run.id,
    runAttempt: run.attempts,
    runLeaseToken: run.leaseToken!,
    threadRef: run.sessionId,
    exp: Date.now() + 60_000,
  };
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), false);
  for (const slug of ["safe", "confidential"])
    await acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "U1",
    });
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), true);
  assert.equal(
    await externalSlackCapabilityAllowed(claims, {
      runs,
      acl,
      externalSlackPolicies: { batch: { ...policy, serviceCredentials: [] } },
    }),
    false,
  );

  for (const patch of [
    { credentials: ["confidential"] },
    { runLeaseToken: "stale" },
    { actorId: "U2" },
    { scopeId: "personal:U1" },
    { runAttempt: run.attempts + 1 },
  ])
    assert.equal(
      await externalSlackCapabilityAllowed({ ...claims, ...patch }, { runs, acl, externalSlackPolicies }),
      false,
    );
  await acl.revoke("org:default-org", encodeRef(serviceCredRef("safe")), "org:default-org", "U1");
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), false);
});

test("external policy changes invalidate retained requests while untouched workspaces stay unchanged", async () => {
  const { externalSlackRequestAllowed } = await import("../src/resolution/external-slack.ts");
  const req = request("test");
  assert.equal(externalSlackRequestAllowed(req, externalSlackPolicies), true);
  assert.equal(externalSlackRequestAllowed(req, {}), false);
  assert.equal(externalSlackRequestAllowed(req, { batch: { ...policy, serviceCredentials: [] } }), false);
  const legacy = {
    ...req,
    externalSlack: undefined,
    conversation: { ...req.conversation, channelRef: "C1", threadRef: "C1:old" },
  };
  assert.equal(externalSlackRequestAllowed(legacy, externalSlackPolicies), false);
  assert.equal(externalSlackRequestAllowed({ ...legacy, surface: "web" }, externalSlackPolicies, true), false);
  assert.equal(
    externalSlackRequestAllowed(
      { ...legacy, slackSource: { accountId: "staff", teamId: "STAFF", userId: "U1" } },
      externalSlackPolicies,
    ),
    true,
  );
  assert.equal(
    externalSlackRequestAllowed({ ...legacy, conversation: { kind: "dm", threadRef: "dm:U1" } }, externalSlackPolicies),
    true,
  );
});

test("external sandbox API token cannot reach private APIs, while its safe broker token works", async (t) => {
  const { createServer } = await import("../src/api/server.ts");
  const { mintCapabilityToken } = await import("../src/auth/capability-token.ts");
  const { serverDeps } = await import("../src/wiring.ts");
  const config = testConfig({ signingSecret: "synthetic-signing-key-for-http-test", externalSlackPolicies });
  const b = buildApp(config);
  await b.identity.hydrate();
  t.after(async () => {
    b.scheduler.stop();
    b.deploymentLayerRefresh.stop();
    await b.runtime.stop();
  });
  await b.serviceCreds.setServiceCredential("org:default-org", {
    slug: "safe",
    name: "safe",
    host: "public.example",
    delivery: "broker",
    secret: "SYNTHETIC_BROKER_SECRET",
  });
  await b.acl.grant({
    ownerScopeId: "org:default-org",
    ref: encodeRef(serviceCredRef("safe")),
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "U1",
  });
  const req = request("test");
  const { run: queued } = await b.runs.enqueue({
    sessionId: req.conversation.threadRef,
    request: {
      ...req,
      actor: { id: "U1", type: "internal" },
      conversation: { ...req.conversation, publishMembers: undefined, audience: [{ id: "U1", type: "internal" }] },
      origin: { kind: "human" },
    },
  });
  const run = (await b.runs.claimById(queued.id, "test-worker", 60_000))!;
  let forwarded = 0;
  const server = createServer(b.app, {
    ...serverDeps(config, b),
    brokerFetch: async () => {
      forwarded++;
      return { status: 200, contentType: "application/json", text: async () => '{"public":"ok"}' };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const claims: CapabilityClaims = {
    actorId: "U1",
    scopeId: `channel:${namespace}:C1`,
    externalSlack: true,
    runId: run.id,
    runAttempt: run.attempts,
    runLeaseToken: run.leaseToken!,
    threadRef: run.sessionId,
    exp: Date.now() + 60_000,
  };
  const control = await mintCapabilityToken({ ...claims, aud: "control-plane" }, TEST_CAPABILITY_SECRET);
  for (const path of ["/v1/apis", "/v1/keychain", "/v1/admin/whoami", "/v1/admin/memory", "/v1/memory", "/v1/crons"])
    assert.equal((await fetch(`${base}${path}`, { headers: { "x-agent-capability": control } })).status, 403, path);
  const broker = await mintCapabilityToken(
    { ...claims, aud: "credential-broker", credentials: ["safe"] },
    TEST_CAPABILITY_SECRET,
  );
  const call = (token: string) =>
    fetch(`${base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ credential: "safe", url: "https://public.example/data", method: "GET" }),
    });
  assert.equal((await call(control)).status, 403);
  const success = await call(broker);
  assert.equal(success.status, 200, await success.text());
  assert.equal(forwarded, 1);
  externalSlackPolicies.batch = { ...policy, serviceCredentials: [] };
  try {
    assert.equal((await call(broker)).status, 403);
    assert.equal(forwarded, 1);
  } finally {
    externalSlackPolicies.batch = policy;
  }
});
