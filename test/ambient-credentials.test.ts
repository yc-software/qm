import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { sleep } from "../src/util/async.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";

async function fixture(t: TestContext, kind: "channel" | "group" = "channel", isPrivate = true) {
  const b = buildApp(
    testConfig({ signingSecret: "ambient-test-ingress-secret-at-least-32-characters", apiBaseUrl: "http://core.test" }),
  );
  const container = kind === "group" ? "G1" : "C1";
  const scope = `${kind}:${container}` as const;
  await b.config.hydrate?.();
  await b.identity.hydrate();
  await b.deploymentLayerReady;
  await b.config.setSharingPosture("org:default-org", "open");
  await b.directory.replace([
    { principalId: "U1", type: "internal", displayName: "Alice" },
    { principalId: "U2", type: "internal", displayName: "Bob" },
  ]);
  const roster = async (ids = ["U1", "U2"]) => {
    if (kind === "group") {
      await b.directory.replaceGroups(ids.map((principalId) => ({ groupId: container, principalId })));
    } else {
      await b.directory.replaceChannels(
        [{ channelId: container, name: "review", isPrivate, rosterAllInternal: true }],
        ids.map((principalId) => ({ channelId: container, principalId })),
      );
    }
  };
  await roster();
  await b.app.setChannelPolicy(container, "!engage !run echo ready", "U1");
  for (const credential of [
    { slug: "repo", name: "Repository", host: "api.example.com", secret: "shared-broker-secret" },
    {
      slug: "env",
      name: "CLI",
      host: "",
      secret: "shared-env-secret",
      delivery: "env" as const,
      envKey: "SHARED_TOKEN",
    },
  ]) {
    await b.serviceCreds.setServiceCredential("org:default-org", credential);
    await b.acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(credential.slug)),
      granteeScopeId: scope,
      permission: "read",
      grantedBy: "U1",
    });
  }
  await b.keychain!.save({ ownerId: "U1", service: "personal", secret: "personal-secret", envKey: "PERSONAL_TOKEN" });
  const captures: ProvisionOptions[] = [];
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = (layers, options) => {
    if (options) captures.push(options);
    return provision(layers, options);
  };
  let calls = 0;
  const server = createServer(b.app, {
    signingSecret: "ambient-test-ingress-secret-at-least-32-characters",
    capabilitySecret: TEST_CAPABILITY_SECRET,
    config: b.config,
    identity: b.identity,
    serviceCreds: b.serviceCreds,
    acl: b.acl,
    keychain: b.keychain,
    connectorTokens: b.keychain,
    brokerFetch: async (_url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, "Bearer shared-broker-secret");
      return { status: 200, text: async () => "repository response" };
    },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  b.runtime.start();
  t.after(async () => {
    await b.runtime.stop();
    b.scheduler.stop();
    b.deploymentLayerRefresh.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const fire = async () => {
    const previous = captures.length;
    await b.app.ingestSurfaceEvents([
      {
        container,
        kind,
        ts: `${Date.now()}.1`,
        authorId: "U1",
        text: "A change is ready for review",
        createdAt: Date.now(),
      },
    ]);
    for (let i = 0; i < 100 && captures.length === previous; i++) await sleep(50);
    assert.ok(captures.length > previous, "ambient worker reached execution");
    return captures.at(-1)!.env!;
  };
  const broker = (token: string) =>
    fetch(`${base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({ credential: "repo", method: "GET", url: "https://api.example.com/repo" }),
    });
  return { ...b, container, scope, roster, fire, broker, base, calls: () => calls };
}

for (const [kind, isPrivate] of [
  ["channel", true],
  ["channel", false],
  ["group", true],
] as const) {
  test(`Open proactive credentials: ${kind} private=${isPrivate}`, async (t) => {
    const b = await fixture(t, kind, isPrivate);
    const env = await b.fire();
    assert.equal(env.SHARED_TOKEN, "shared-env-secret");
    assert.equal(env.PERSONAL_TOKEN, undefined);
    assert.ok(!Object.values(env).includes("shared-broker-secret"));
    const claims = await verifyCapabilityToken(env.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
    assert.equal(claims?.actorId, "system:ambient:default-org");
    assert.equal(claims?.liveActor, undefined);
    assert.equal(claims?.liveAuthor, undefined);
    assert.equal(claims?.keychainMembers, undefined);
    assert.deepEqual(claims?.members?.map((m) => m.id).sort(), ["U1", "U2"]);
    const response = await b.broker(env.AGENT_CREDENTIAL_TOKEN!);
    assert.equal(response.status, 200, await response.text());
    assert.equal(b.calls(), 1);
    await b.keychain!.setConnectorToken("api.github.com", "U1", { accessToken: "personal-oauth" });
    const revoke = await fetch(`${b.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": env.AGENT_API_TOKEN! },
      body: JSON.stringify({ host: "api.github.com", principalId: "U1" }),
    });
    assert.equal(revoke.status, 400);
    assert.equal(await b.keychain!.connectorAccessToken("api.github.com", "U1"), "personal-oauth");
    await b.roster(["U1"]);
    assert.equal((await b.broker(env.AGENT_CREDENTIAL_TOKEN!)).status, 403);
    assert.equal(b.calls(), 1);
  });
}

test("Open ambient capability rechecks posture, policy, identity, and roster on every call", async (t) => {
  const b = await fixture(t);
  const env = await b.fire();
  const token = env.AGENT_CREDENTIAL_TOKEN!;
  assert.equal((await b.broker(token)).status, 200);
  await b.config.setSharingPosture(b.scope, "isolated");
  assert.equal((await b.broker(token)).status, 403);
  await b.config.clearSharingPosture(b.scope);
  await b.app.setChannelPolicy(b.container, "!engage", "U1", undefined, undefined, false);
  assert.equal((await b.broker(token)).status, 403);
  await b.app.setChannelPolicy(b.container, "!engage", "U1", undefined, undefined, true);
  b.config.setOrgAmbient(false);
  assert.equal((await b.broker(token)).status, 403);
  b.config.setOrgAmbient(true);
  await b.identity.deactivate("U2");
  assert.equal((await b.broker(token)).status, 403);
  await b.identity.reactivate("U2");
  assert.equal((await b.broker(token)).status, 200);
});

test("Isolated ambient work does not acquire credential environment or broker access", async (t) => {
  const b = await fixture(t);
  await b.config.setSharingPosture(b.scope, "isolated");
  const env = await b.fire();
  assert.equal(env.SHARED_TOKEN, undefined);
  assert.equal(env.AGENT_CREDENTIAL_TOKEN, undefined);
  const response = await fetch(`${b.base}/v1/soul`, { headers: { "x-agent-capability": env.AGENT_API_TOKEN! } });
  assert.equal(response.status, 403);
});

for (const missing of ["unknown", "incomplete", "external"] as const) {
  test(`Ambient credentials fail closed with ${missing} channel roster`, async (t) => {
    const b = await fixture(t);
    if (missing === "unknown") await b.directory.replaceChannels([]);
    if (missing === "incomplete") await b.roster(["U1", "unknown-person"]);
    if (missing === "external") {
      await b.directory.replaceChannels(
        [{ channelId: b.container, name: "review", isPrivate: true, isExternal: true }],
        ["U1", "U2"].map((principalId) => ({ channelId: b.container, principalId })),
      );
    }
    const env = await b.fire();
    assert.equal(env.SHARED_TOKEN, undefined);
    assert.equal(env.AGENT_CREDENTIAL_TOKEN, undefined);
    assert.equal(
      (
        await fetch(`${b.base}/v1/soul`, {
          headers: { "x-agent-capability": env.AGENT_API_TOKEN! },
        })
      ).status,
      403,
    );
  });
}

test("Open ambient workers still need a credential grant to their conversation", async (t) => {
  const b = await fixture(t);
  for (const slug of ["repo", "env"]) {
    await b.acl.revoke("org:default-org", encodeRef(serviceCredRef(slug)), b.scope, "U1");
  }
  const env = await b.fire();
  assert.equal(env.SHARED_TOKEN, undefined);
  assert.equal(env.AGENT_CREDENTIAL_TOKEN, undefined);
});

test("Isolated public-channel ambient tools retain ordinary channel access", async (t) => {
  const b = await fixture(t, "channel", false);
  const env = await b.fire();
  await b.config.setSharingPosture(b.scope, "isolated");
  const response = await fetch(`${b.base}/v1/soul`, {
    headers: { "x-agent-capability": env.AGENT_API_TOKEN! },
  });
  assert.equal(response.status, 200);
  assert.equal((await b.broker(env.AGENT_CREDENTIAL_TOKEN!)).status, 403);
});
