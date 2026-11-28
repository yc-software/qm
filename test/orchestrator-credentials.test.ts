import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeId } from "../src/types.ts";
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
import { failedTurnError } from "./support/failed-turn.ts";
import type { SandboxHandle, ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { verifyCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { egressClaimAllowingControlPlane } from "../src/core/orchestrator.ts";
import { egressDecision } from "../src/resolution/egress-policy.ts";
import { hashId } from "../src/util/crypto.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testMap, testDatabaseUrl } from "./support/test-database.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools, type ToolContextRef } from "../src/agent/agent-tools.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("execute runs in the sandbox via the primitive", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!run echo sandbox-works"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /sandbox-works/);
});

test("a per-turn egress-proxy token is minted and passed to provision, carrying the egress policy", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);

  const res = await app.turn(dm("!run echo go"));
  assert.equal(res.status, "ok");
  assert.ok(captured.opts?.egressToken, "provision must receive a per-turn egressToken");

  const claims = await verifyCapabilityToken(captured.opts!.egressToken!, TEST_CAPABILITY_SECRET);
  assert.ok(claims, "the egress token must verify with the capability secret");
  assert.equal(claims!.aud, EGRESS_PROXY_AUD);
  assert.deepEqual(captured.opts!.egress, { allowedHosts: [], deniedHosts: [] });
});

test("large channel turns apply the compression rollout setting to every sandbox token", async () => {
  for (const capabilityTokenCompression of [false, true]) {
    const { app, sandbox } = buildApp(signedConfig({ capabilityTokenCompression }));
    const captured = captureProvision(sandbox);
    const members = Array.from({ length: 120 }, (_, i) => ({
      externalId: i === 0 ? "U1" : `U${i + 1}-compression-fixture`,
    }));
    const result = await app.turn(
      channel("!run echo compact", {
        conversation: {
          kind: "channel",
          threadRef: "ch:C1:compact",
          channelRef: "C1",
          audience: members,
          publishMembers: members,
        },
      }),
    );
    assert.equal(result.status, "ok");
    for (const token of [
      captured.opts?.env?.AGENT_API_TOKEN,
      captured.opts?.env?.AGENT_OAUTH_CONSENT_TOKEN,
      captured.opts?.egressToken,
    ]) {
      assert.ok(token);
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      assert.equal(payload.encoding, capabilityTokenCompression ? "deflate-raw" : undefined);
      if (capabilityTokenCompression) assert.ok(token.length < 8 * 1024);
      const verified = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
      assert.equal(verified?.members?.length, 120);
    }
  }
});

test("bot attestation reaches control, OAuth, and egress capabilities without a person's authority", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);
  for (const actor of [{ externalId: "B-LEGACY", isBot: true }, { externalId: "admin-alice" }]) {
    const res = await app.turn(
      channel("!run echo bot", {
        actor,
        botActor: true,
        origin: { kind: "human" },
        conversation: {
          kind: "channel",
          threadRef: `ch:C-${actor.externalId}:bot`,
          channelRef: `C-${actor.externalId}`,
          isPrivate: true,
          audience: [actor],
          publishMembers: [actor],
        },
      }),
    );
    assert.equal(res.status, "ok");
    for (const token of [
      captured.opts!.env!.AGENT_API_TOKEN,
      captured.opts!.env!.AGENT_OAUTH_CONSENT_TOKEN,
      captured.opts!.egressToken,
    ]) {
      const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
      assert.equal(claims?.botActor, true);
      assert.equal(claims?.personAuthority, undefined);
      assert.deepEqual(claims?.members, [{ id: actor.externalId, type: "internal" }]);
      assert.equal(claims?.memory?.orgWrite, undefined);
    }
  }
});

test("a Slack bot's message in a person's thread can neither cancel nor resume the person's goal", async () => {
  const base = createMockAgent();
  const agent: Agent = {
    ...base,
    async runTurn(turn) {
      const ref: ToolContextRef = {
        current: turn.tools,
        scopeLabel: turn.scopeLabel,
        emit: turn.emit,
        goal: turn.goal ?? null,
        ...(turn.saveGoal ? { saveGoal: turn.saveGoal } : {}),
      };
      const goal = createAgentTools(ref).find((tool) => tool.name === "goal")!.execute as unknown as (
        id: string,
        input: unknown,
      ) => Promise<unknown>;
      await goal(
        `goal-${turn.runId}`,
        turn.input.includes("grind")
          ? { action: "create", objective: "grind on the release notes", floor: { minTurns: 40 } }
          : { action: "update", status: turn.goal?.status === "paused" ? "resume" : "cancel", note: "the bot asked" },
      );
      return { reply: "done", modelCalls: 1 };
    },
  };
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")) });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const built = buildApp(config, { agent });
  const bot = { externalId: "B1", displayName: "Release bot", isBot: true };
  const fromBot = (text: string) =>
    channel(text, {
      actor: bot,
      botActor: true,
      origin: { kind: "human" },
      conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [bot] },
    });
  assert.equal(
    (await built.app.turn(channel("grind on the release notes", { origin: { kind: "human" } }))).status,
    "ok",
  );
  const session = (await built.sessions.getByThread("ch:C1:t1"))!;
  const goalStatus = async () => (await built.sessions.goals([session.id])).get(session.id)?.status;
  assert.equal(await goalStatus(), "active");
  assert.equal((await built.app.turn(fromBot("cancel the goal"))).status, "ok");
  const afterCancel = await goalStatus();
  const paused = (await built.sessions.goals([session.id])).get(session.id)!;
  paused.status = "paused";
  await built.sessions.setGoal({ sessionId: session.id }, paused);
  assert.equal((await built.app.turn(fromBot("resume the goal"))).status, "ok");
  assert.deepEqual({ afterCancel, afterResume: await goalStatus() }, { afterCancel: "active", afterResume: "paused" });
});

test("Composio backend access is announced without delivering the project key", async () => {
  const built = freshApp({
    apiBaseUrl: "https://core.example.com",
    signingSecret: "test-secret",
    maxAttempts: 1,
  });
  const { app, serviceCreds, acl, sandbox } = built;
  const captured = captureProvision(sandbox);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "synthetic-composio-secret",
    host: "backend.composio.dev",
  });
  const prompt = async (suffix: string) => {
    const result = await app.turn(
      dm("!sysprompt", { conversation: { kind: "dm", threadRef: `dm:U1:discovery-${suffix}` } }),
    );
    assert.equal(result.status, "ok");
    assert.doesNotMatch(result.reply ?? "", /synthetic-composio-secret/);
    return result.reply ?? "";
  };
  assert.doesNotMatch(await prompt("ungranted"), /COMPOSIO_API_KEY/);
  await grantCred(acl, org, "composio");
  const granted = await prompt("granted");
  assert.match(granted, /## Connected app access/);
  assert.match(granted, /Composio is configured in the backend/);
  assert.doesNotMatch(granted, /`composio`/);
  assert.match(
    await failedTurnError(
      built,
      dm(`!execute ${JSON.stringify({ command: "true", credentials: ["composio"] })}`, {
        conversation: { kind: "dm", threadRef: "dm:U1:composio-explicit" },
      }),
    ),
    /not available/,
  );
  assert.doesNotMatch(granted, /COMPOSIO_API_KEY/);
  assert.doesNotMatch(granted, /Do not suggest or offer any app connection/);
  const result = await app.turn(
    dm("!run echo backend-only", { conversation: { kind: "dm", threadRef: "dm:U1:composio-backend" } }),
  );
  assert.equal(result.status, "ok");
  assert.equal(captured.opts?.env?.COMPOSIO_API_KEY, undefined);
  const claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.ownerConnections, true);
  const listServiceCredentials = serviceCreds.listServiceCredentials.bind(serviceCreds);
  serviceCreds.listServiceCredentials = async (...args) =>
    (await listServiceCredentials(...args)).map((record) =>
      record.slug === "composio" ? { ...record, delivery: "broker" } : record,
    );
  const brokerDelivery = await prompt("backend-broker-delivery");
  assert.match(brokerDelivery, /Composio is configured in the backend/);
  assert.doesNotMatch(brokerDelivery, /`composio`|Shared org credentials available to you/);
  serviceCreds.listServiceCredentials = listServiceCredentials;
  await acl.revoke(tenant, org, encodeRef(serviceCredRef("composio")), org, "admin@default-org");
  assert.doesNotMatch(await prompt("revoked"), /COMPOSIO_API_KEY/);
  await grantCred(acl, org, "composio");
  await serviceCreds.setServiceCredential(org, {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "synthetic-composio-secret",
    host: "backend.composio.dev",
    enabled: false,
  });
  assert.doesNotMatch(await prompt("disabled"), /COMPOSIO_API_KEY/);
});

test("org credentials are delivered only when requested and read live after rotation", async () => {
  const config = signedConfig();
  const { app, sandbox, serviceCreds, acl } = buildApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  await grantCred(acl, org, "browse-model-key");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-model-key",
    name: "Browse model key",
    delivery: "env",
    envKey: "BROWSE_LAB_ANTHROPIC_KEY",
    secret: "model-org-key",
    host: "",
  });
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };

  const request = `!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel", "browse-model-key"] })}`;
  let res = await app.turn(dm(request, { conversation: { kind: "dm", threadRef: "dm:U1:env1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
  assert.equal(executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY, "steel-org-key");
  assert.equal(
    executions.findLast((handle) => handle.env?.BROWSE_LAB_ANTHROPIC_KEY)?.env?.BROWSE_LAB_ANTHROPIC_KEY,
    "model-org-key",
  );

  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-rotated",
    host: "",
  });
  res = await app.turn(dm(request, { conversation: { kind: "dm", threadRef: "dm:U1:env2" } }));
  assert.equal(res.status, "ok");
  assert.equal(
    executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY,
    "steel-rotated",
    "secret is read for each execution",
  );
});

test("a disabled or broker-delivery credential never rides provision env", async () => {
  const config = signedConfig();
  const { app, sandbox, serviceCreds, acl } = buildApp(config);
  const org = scopeId("org", "default-org");
  await grantCred(acl, org, "x-firehose");
  await grantCred(acl, org, "browse-steel");
  await serviceCreds.setServiceCredential(org, {
    slug: "x-firehose",
    name: "X",
    secret: "broker-bearer",
    host: "api.x.com",
  });
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
    enabled: false,
  });
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };

  const res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:env3" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  const env = captures.at(-1)?.env ?? {};
  assert.equal(env.STEEL_API_KEY, undefined, "disabled env credential stays home");
  assert.ok(
    !Object.values(env).includes("broker-bearer"),
    "a broker credential's secret never appears in the sandbox env",
  );
});

test("a credential flipped away from env between the metadata read and the secret read stays home", async () => {
  const config = signedConfig({ maxAttempts: 1 });
  const built = buildApp(config);
  const { sandbox, serviceCreds, acl } = built;
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const realGet = serviceCreds.getServiceCredentialSecret.bind(serviceCreds);
  serviceCreds.getServiceCredentialSecret = async (scope, slug) => {
    const rec = await realGet(scope, slug);
    return rec && slug === "browse-steel" ? { ...rec, delivery: "broker", envKey: undefined, host: "steel.dev" } : rec;
  };
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };

  assert.match(
    await failedTurnError(
      built,
      dm(`!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`, {
        conversation: { kind: "dm", threadRef: "dm:U1:env4" },
      }),
    ),
    /Service credential is no longer available/,
  );
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
});

test("env-delivery credentials are not offered to an external audience", async () => {
  const config = signedConfig();
  const { app, sandbox, serviceCreds, acl } = buildApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };

  const externalRoom = await app.turn(
    dm("!sysprompt", {
      conversation: {
        kind: "channel",
        threadRef: "ch:C9:t9",
        channelRef: "C9",
        audience: [internalActor],
        publishMembers: [internalActor, { externalId: "visitor", isExternalGuest: true }],
      },
    }),
  );
  assert.equal(externalRoom.status, "ok");
  assert.doesNotMatch(externalRoom.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "a room with externals gets no org env credentials");
});

test("a channel cron receives env credentials only when the directory proves an all-internal roster", async () => {
  const config = signedConfig();
  const { app, sandbox, serviceCreds, acl, deliveries, identity } = buildApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([
    { principalId: "U1", displayName: "One", type: "internal" },
    { principalId: "U2", displayName: "Two", type: "internal" },
  ]);
  await directory.replaceChannels(
    [
      { channelId: "C-internal", name: "internal" },
      { channelId: "C-unsynced", name: "unsynced" },
      { channelId: "C-shared", name: "shared", isExternal: true },
      { channelId: "C-guest", name: "guest" },
    ],
    [
      { channelId: "C-internal", principalId: "U1" },
      { channelId: "C-internal", principalId: "U2" },
      { channelId: "C-shared", principalId: "U1" },
      { channelId: "C-shared", principalId: "U2" },
      { channelId: "C-guest", principalId: "U1" },
      { channelId: "C-guest", principalId: "visitor" },
    ],
    undefined,
    ["C-internal", "C-shared", "C-guest"],
  );
  const fire = async (channelId: string) => {
    const out = await runTrigger(
      {
        deliveries,
        idempotency: createIdempotencyStore(testMap()),
        identity,
        run: (req) => app.turn(req),
        directory,
      },
      {
        owner: "U1",
        ownerScopeId: scopeId("channel", channelId),
        input:
          channelId === "C-internal"
            ? `!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`
            : "!sysprompt",
        fireKey: `cron:${channelId}:1`,
        surface: "cron",
      },
    );
    assert.equal(out.status, "ok", `the ${channelId} cron turn runs`);
    assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
    if (channelId !== "C-internal") {
      assert.doesNotMatch(out.reply ?? "", /browse-steel/);
      return undefined;
    }
    return executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY;
  };
  assert.equal(await fire("C-internal"), "steel-org-key", "an all-internal synced roster admits the env credential");
  assert.equal(await fire("C-unsynced"), undefined, "a channel with no synced roster stays fail-closed");
  assert.equal(await fire("C-shared"), undefined, "an externally shared channel stays fail-closed");
  assert.equal(await fire("C-guest"), undefined, "a roster with a non-internal principal stays fail-closed");
});

test("env-delivery credentials are gated by service-cred grants — no grant, no env var; a person grant admits only that person", async () => {
  const config = signedConfig();
  const { app, sandbox, serviceCreds, acl } = buildApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (owner, opts) => {
    if (opts) captures.push(opts);
    return realProvision(owner, opts);
  };

  let res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:gate1" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "ungranted env credential stays home");

  await grantCred(acl, org, "browse-steel", scopeId("personal", "somebody-else"));
  res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:gate2" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "a grant to someone else does not admit this actor");

  await grantCred(acl, org, "browse-steel", scopeId("personal", "U1"));
  res = await app.turn(
    dm(`!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`, {
      conversation: { kind: "dm", threadRef: "dm:U1:gate3" },
    }),
  );
  assert.equal(res.status, "ok");
  assert.equal(
    executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY,
    "steel-org-key",
    "a personal grant to the actor admits the env var",
  );
});

test("admin-configured browse step limit rides provision env (BROWSE_LAB_MAX_STEPS)", async () => {
  const config = signedConfig();
  const built = buildApp(config);
  const { app, sandbox } = built;
  const captured = captureProvision(sandbox);

  const res = await app.turn(dm("!run echo steps"));
  assert.equal(res.status, "ok");
  assert.equal(
    captured.opts?.env?.BROWSE_LAB_MAX_STEPS,
    undefined,
    "no injection when unset — the skill's own default applies",
  );
  assert.equal(
    captured.opts?.env?.BROWSE_LAB_MODEL,
    "claude-opus-5",
    "with no override the browse model follows the deployment base model",
  );
  assert.equal(captured.opts?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed", "the runner uses core model routing");

  await built.config.setBrowseMaxSteps("org:default-org", 120);
  const res2 = await app.turn(dm("!run echo steps again"));
  assert.equal(res2.status, "ok");
  assert.equal(captured.opts?.env?.BROWSE_LAB_MAX_STEPS, "120", "the configured limit rides the provision env");
});

test("browse follows a live org base model change, not the process-start default", async () => {
  const config = signedConfig();
  const built = buildApp(config);
  const { app, sandbox } = built;
  const captured = captureProvision(sandbox);

  let res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:live1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captured.opts?.env?.BROWSE_LAB_MODEL, "claude-opus-5", "starts on the deployment default");

  await built.config.setBaseModel("org:default-org", "gpt-5.6-sol");
  res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:live2" } }));
  assert.equal(res.status, "ok");
  assert.equal(
    captured.opts?.env?.BROWSE_LAB_MODEL,
    "gpt-5.6-sol",
    "an admin changing the org base model moves browse too, without a restart",
  );
  assert.equal(captured.opts?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed");
});

test("an OpenAI deployment provisions managed browser access without its provider key", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-")),
    orgId: "acme",
    signingSecret: "test-secret",
    apiBaseUrl: "https://core.example.com",
    modelId: "gpt-5.6-sol",
    openaiApiKey: "openai-org-key",
  });
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);

  const res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:oa1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captured.opts?.env?.BROWSE_LAB_MODEL, "gpt-5.6-sol");
  assert.equal(captured.opts?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed", "core selects the provider");
  assert.ok(!Object.values(captured.opts?.env ?? {}).includes("openai-org-key"));
  const claims = await verifyCapabilityToken(captured.opts!.env!.BROWSE_LAB_MODEL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.browserModel, "gpt-5.6-sol");
  assert.equal(claims?.browserAccount, "company");
});

test("turn timezone rides the prompt and control-plane capability token", async () => {
  const config = signedConfig();
  const { app, sandbox } = buildApp(config);
  const captured = captureProvision(sandbox);

  const res = await app.turn(dm("!run echo tz", { timezone: "America/New_York" }));
  assert.equal(res.status, "ok");
  const claims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.timezone, "America/New_York");
  assert.equal(claims!.surface, "test");

  const slackThread = { kind: "dm" as const, threadRef: "dm:U1:slack-wake" };
  await app.turn(dm("!run echo slack", { surface: "slack", conversation: slackThread }));
  captured.opts = undefined;
  await app.turn(dm("!run echo wake", { surface: "monitor", conversation: slackThread }));
  const wake = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(wake!.surface, "slack", "a wake in a Slack thread keeps the conversation's surface");
  captured.opts = undefined;
  await app.turn(dm("!run echo web", { surface: "web", conversation: slackThread }));
  const web = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(web!.surface, "web", "a live web UI turn is a web turn even in a Slack-labelled conversation");

  const prompt = await app.turn(
    dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:tz-prompt" }, timezone: "America/New_York" }),
  );
  assert.match(prompt.reply ?? "", /\(America\/New_York\)/);

  captured.opts = undefined;
  const invalid = await app.turn(
    dm("!run echo bad-tz", { conversation: { kind: "dm", threadRef: "dm:U1:bad-tz" }, timezone: "not-a-zone" }),
  );
  assert.equal(invalid.status, "ok");
  const invalidClaims = await verifyCapabilityToken(captured.opts!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(invalidClaims!.timezone, undefined, "invalid surface timezones are omitted from the token");
});

test("the egress claim keeps the control-plane host reachable under an allowlist or a matching denylist", () => {
  const core = "https://core.example.com";

  const a = egressClaimAllowingControlPlane({ allowedHosts: ["api.github.com"] }, core)!;
  assert.deepEqual(a.allowedHosts, ["api.github.com", "core.example.com"]);
  assert.equal(egressDecision("core.example.com", a).allow, true);
  assert.equal(egressDecision("evil.com", a).allow, false, "the allowlist still bites everything else");

  const d = egressClaimAllowingControlPlane({ allowedHosts: [], deniedHosts: ["example.com", "tracker.io"] }, core)!;
  assert.equal(egressDecision("core.example.com", d).allow, true, "core must not be denied");
  assert.equal(egressDecision("tracker.io", d).allow, false, "unrelated denies survive");

  assert.equal(egressClaimAllowingControlPlane({ allowedHosts: [] }, core), undefined);

  const auto = egressClaimAllowingControlPlane({ allowedHosts: [] }, core, true)!;
  assert.deepEqual(auto, {
    allowedHosts: [],
    denyPrivateNetworks: true,
    privateNetworkAllowedHosts: ["core.example.com"],
  });
  assert.equal(egressDecision("api.github.com", auto).allow, true, "Auto keeps public internet capability");

  const withoutControlPlane = egressClaimAllowingControlPlane({ allowedHosts: [] }, "", true)!;
  assert.deepEqual(withoutControlPlane, { allowedHosts: [], denyPrivateNetworks: true });
});
