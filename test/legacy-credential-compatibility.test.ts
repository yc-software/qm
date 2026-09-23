import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { buildApp } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, verifyCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { TurnRequest } from "../src/types.ts";

const scope = "personal:U_LEGACY";
const secret = "legacy-compatibility-ingress".repeat(3);
const turn = (command: string, sandboxId?: string, credentials?: string[]): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U_LEGACY" },
  liveActor: true,
  conversation: { kind: "dm", threadRef: "dm:legacy-compatibility" },
  text: `!execute ${JSON.stringify({ command, ...(sandboxId ? { sandboxId } : {}), ...(credentials ? { credentials } : {}) })}`,
});

test("existing legacy credentials stay ambient across flag changes while explicitly isolated boxes require requests", async () => {
  const built = buildApp(
    testConfig({ sandboxResourcesEnabled: true, signingSecret: secret, apiBaseUrl: "http://core.internal" }),
  );
  await built.keychain!.save({
    ownerId: "U_LEGACY",
    service: "compat",
    envKey: "COMPAT_TOKEN",
    secret: "legacy-value",
  });
  const legacy = await built.sandboxResources.create("U_LEGACY", scope, "sprites", "existing");
  await built.sandboxResources.setDefault("U_LEGACY", scope, legacy.id);
  await built.config.setSecurityPosture("org:default-org", "dangerous");
  await built.config.setSecurityPosture(scope, "dangerous");
  const tokens: Array<{ mode?: string; token?: string }> = [];
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = async (layers, options) => {
    const handle = await provision(layers, options);
    tokens.push({ mode: handle.executionMode, token: options?.egressToken });
    return handle;
  };
  const authenticated = 'test "$COMPAT_TOKEN" = legacy-value && echo authenticated';
  assert.equal((await built.app.turn(turn(authenticated))).reply, "authenticated");
  await built.featureFlags.setEnabled("command_scoped_credentials", scope, true, "admin");
  assert.equal((await built.app.turn(turn(authenticated))).reply, "authenticated");
  const isolated = await built.sandboxResources.create("U_LEGACY", scope, "sprites", "isolated", undefined, {
    executionMode: "isolated",
  });
  assert.equal((await built.app.turn(turn('test -z "$COMPAT_TOKEN" && echo absent', isolated.id))).reply, "absent");
  const credential = (await built.keychain!.listByOwner("U_LEGACY"))[0]!;
  const { credentialHandle } = await import("../src/credentials/keychain.ts");
  assert.equal(
    (await built.app.turn(turn(authenticated, isolated.id, [credentialHandle(credential.id)]))).reply,
    "authenticated",
  );
  await built.featureFlags.setEnabled("command_scoped_credentials", scope, false, "admin");
  assert.equal((await built.app.turn(turn('test -z "$COMPAT_TOKEN" && echo absent', isolated.id))).reply, "absent");
  assert.equal((await built.app.turn(turn(authenticated))).reply, "authenticated");
  for (const record of tokens) {
    assert.ok(record.token);
    const claims = await verifyCapabilityToken(record.token, TEST_CAPABILITY_SECRET);
    assert.equal(claims?.egress?.denyPrivateNetworks ?? false, record.mode === "isolated");
  }
  assert.ok(tokens.some((record) => record.mode === "isolated"));
  assert.ok(tokens.some((record) => record.mode === "legacy"));
});

test("keychain use preserves legacy own and grant authorization while isolated and invalid bindings never consume grants", async () => {
  const built = buildApp(testConfig({ sandboxResourcesEnabled: true, signingSecret: secret }));
  const credential = await built.keychain!.save({
    ownerId: "U_LEGACY",
    service: "compat",
    envKey: "COMPAT_TOKEN",
    secret: "legacy-value",
  });
  const server = createServer(built.app, {
    signingSecret: secret,
    capabilitySecret: TEST_CAPABILITY_SECRET,
    keychain: built.keychain,
    sandbox: built.sandbox,
    sandboxResources: built.sandboxResources,
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const use = async (claims: object, body: object) =>
    fetch(`http://127.0.0.1:${address.port}/v1/keychain/use`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await mintCapabilityToken(
          { actorId: "U_LEGACY", scopeId: scope, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000, ...claims },
          TEST_CAPABILITY_SECRET,
        ),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await use({}, { credential: credential.id })).status, 403);
    const old = await use({ liveActor: true }, { credential: credential.id });
    assert.equal(old.status, 200);
    assert.match(await old.text(), /COMPAT_TOKEN/);
    const grant = await built.keychain!.createGrant({
      credentialId: credential.id,
      ownerId: "U_LEGACY",
      audienceScopeId: scope,
      mode: "once",
      purpose: "compat",
    });
    assert.equal((await use({ executionMode: "isolated" }, { grant: grant.id })).status, 410);
    assert.equal(
      (await use({ executionMode: "legacy", sandboxId: "missing-resource" }, { grant: grant.id })).status,
      403,
    );
    assert.equal((await built.keychain!.getGrant(grant.id))?.status, "active");
    assert.equal((await use({ executionMode: "legacy" }, { grant: grant.id })).status, 200);
    assert.equal((await use({ executionMode: "legacy" }, { grant: grant.id })).status, 410);
    await built.featureFlags.setEnabled("command_scoped_credentials", scope, true, "admin");
    const isolated = await built.sandboxResources.create("U_LEGACY", scope, "sprites", "isolated", undefined, {
      executionMode: "isolated",
    });
    assert.equal(
      (await use({ executionMode: "legacy", sandboxId: isolated.id, liveActor: true }, { credential: credential.id }))
        .status,
      410,
    );
    await built.sandboxResources.setDefault("U_LEGACY", scope, isolated.id);
    assert.equal((await use({ liveActor: true }, { credential: credential.id })).status, 410);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("legacy computers preserve connector, shared service broker and resident login workflows", async () => {
  const built = buildApp(testConfig({ signingSecret: secret, apiBaseUrl: "http://core.internal" }));
  await built.connectorTokens.setConnectorToken("api.github.com", "U_LEGACY", { accessToken: "connector-value" });
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "shared-read",
    name: "Shared read",
    host: "read.example",
    secret: "synthetic",
    delivery: "broker",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:shared-read",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });
  let captured: Record<string, string> | undefined;
  const run = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = async (handle, command, options) => {
    if (command.includes("legacy-workflow")) captured = handle.env;
    return run(handle, command, options);
  };
  const result = await built.app.turn(
    turn('mkdir -p ~/.config/gh; printf "oauth_token: durable-login" > ~/.config/gh/hosts.yml; echo legacy-workflow'),
  );
  assert.equal(result.reply, "legacy-workflow");
  assert.equal(captured?.VAULT_TOKEN_API_GITHUB_COM, "connector-value");
  const claims = await verifyCapabilityToken(captured!.AGENT_CREDENTIAL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.deepEqual(claims?.credentials, ["shared-read"]);
  const control = await verifyCapabilityToken(captured!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(control?.executionMode, "legacy");
  assert.equal(
    (await built.keychain!.listByOwner("U_LEGACY")).some((credential) => credential.service === "gh"),
    true,
  );
  const handle = await built.sandbox.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
  await built.sandbox.teardown(handle, { destroy: true });
  const restored = await built.app.turn(
    turn('test "$(cat ~/.config/gh/hosts.yml)" = "oauth_token: durable-login" && echo restored'),
  );
  assert.equal(restored.reply, "restored");
});

test("register_login keeps the legacy resident workflow and rejects isolated execution files", async () => {
  const { createOrchestrator } = await import("../src/core/orchestrator.ts");
  const { createResolutionService } = await import("../src/resolution/resolution-service.ts");
  const { createMockHarness } = await import("../src/harness/mock-harness.ts");
  for (const executionMode of ["legacy", "isolated"] as const) {
    const built = buildApp(testConfig({ signingSecret: secret, sandboxResourcesEnabled: true }));
    if (executionMode === "isolated")
      await built.featureFlags.setEnabled("command_scoped_credentials", scope, true, "admin");
    const resource = await built.sandboxResources.create("U_LEGACY", scope, "sprites", executionMode, undefined, {
      executionMode,
    });
    await built.sandboxResources.setDefault("U_LEGACY", scope, resource.id);
    const harness = createMockHarness();
    harness.turns.runTurn = async (input) => {
      const result = await input.tools.execute("mkdir -p ~/.compatcli && printf durable-login > ~/.compatcli/token");
      assert.equal(result.code, 0);
      if (executionMode === "legacy")
        await input.tools.registerLogin!("compatcli", [{ path: ".compatcli", kind: "directory" }]);
      else
        await assert.rejects(
          input.tools.registerLogin!("compatcli", [{ path: ".compatcli", kind: "directory" }]),
          /same execute call/,
        );
      return { reply: "checked" };
    };
    const orchestrator = createOrchestrator({
      ...built,
      runtime: undefined,
      resolution: createResolutionService("default-org", built.config, built.acl),
      deploy: {} as never,
      harness,
    });
    const actor = { id: "U_LEGACY", type: "internal" as const, teamIds: [] };
    assert.equal(
      (
        await orchestrator.handleTurn({
          surface: "test",
          actor,
          conversation: { kind: "dm", threadRef: `dm:${executionMode}`, audience: [actor] },
          origin: { kind: "human" },
          text: "record login",
        })
      ).reply,
      "checked",
    );
    assert.equal(
      (await built.keychain!.listByOwner(actor.id)).some((credential) => credential.service === "compatcli"),
      executionMode === "legacy",
    );
  }
});
