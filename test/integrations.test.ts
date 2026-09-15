import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential, type KeychainGrant } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createIntegrationHelper, type IntegrationRequest } from "../src/connectors/integrations.ts";
import { orgId, orgScope } from "../src/config.ts";
import { personalScope, type ScopeId } from "../src/types.ts";
import { NeedsApproval } from "../src/tools/primitives.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { brokerCredentialCall } from "../src/api/credential-broker.ts";

const projectKey = "project-only-sentinel";
const owner = "alice@example.com";
const tool = {
  slug: "GOOGLECALENDAR_EVENTS_LIST",
  name: "List events",
  version: "20260901_00",
  no_auth: false,
  toolkit: { slug: "googlecalendar", name: "Calendar" },
  input_parameters: { type: "object", properties: { calendar_id: { type: "string" } } },
};
async function fixture() {
  const creds = createMemoryMap<KeychainCredential>();
  const grants = createMemoryMap<KeychainGrant>();
  const keychain = createKeychain({
    creds,
    grants,
    asks: createMemoryMap(),
    key: deriveConnectorKey("synthetic-keychain-key"),
  });
  await keychain.setServiceCredential(orgScope(), {
    slug: "apps",
    name: "Apps",
    secret: projectKey,
    host: "backend.composio.dev",
    provider: "composio",
  });
  const connection = await keychain.saveConnection(owner, {
    provider: "composio",
    credential: "apps",
    toolkit: "googlecalendar",
    accountId: "ca_alice",
  });
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    assert.equal(new URL(String(url)).origin, "https://backend.composio.dev");
    assert.equal(new Headers(init?.headers).get("x-api-key"), projectKey);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.includes("/tools/execute/"))
      return Response.json({ data: { items: ["synthetic-event"] }, error: null, successful: true });
    if (path.includes("/connected_accounts/")) return Response.json({ deleted: true });
    return Response.json(tool);
  });
  let allowed = true;
  let approved = false;
  const audits: string[] = [];
  const commands: string[] = [];
  const helper = (actorId = owner, scopeId: ScopeId = personalScope(actorId)) =>
    createIntegrationHelper({
      keychain,
      orgScopeId: orgScope(),
      scopeId,
      actorId,
      grantedCredentials: async () => (allowed ? ["apps"] : []),
      approve: (command) => {
        commands.push(command);
        if (!approved) throw new NeedsApproval(command, "Approve this operation");
      },
      audit: (action, resource) => {
        audits.push(`${action}:${resource}`);
      },
    });
  const request: IntegrationRequest = {
    action: "execute",
    tool: tool.slug,
    arguments: { calendar_id: "primary" },
    connection: connection.id,
  };
  return {
    keychain,
    creds,
    grants,
    connection,
    calls,
    commands,
    audits,
    helper,
    request,
    allow: (value: boolean) => {
      allowed = value;
    },
    approve: () => {
      approved = true;
    },
    close: () => http.mock.restore(),
  };
}

test("universal provider is encrypted, metadata-only, and unavailable through generic broker", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.keychain.listServiceCredentials(orgScope()))[0]?.provider, "composio");
    assert.equal(JSON.stringify(await f.creds.all()).includes(projectKey), false);
    let dispatched = false;
    const result = await brokerCredentialCall({
      claims: { actorId: owner, scopeId: personalScope(owner), credentials: ["apps"], exp: Date.now() + 1000 },
      body: { credential: "apps", url: "https://backend.composio.dev/api/v3.1/connected_accounts" },
      orgScopeId: orgScope(),
      reader: f.keychain,
      fetchImpl: async () => {
        dispatched = true;
        throw new Error("unreachable");
      },
    });
    assert.equal(result.status, 404);
    assert.equal(dispatched, false);
    assert.equal(JSON.stringify(result).includes(projectKey), false);
  } finally {
    f.close();
  }
});

test("provider flags cannot be combined with env delivery or a different host", async () => {
  const f = await fixture();
  try {
    for (const input of [{ delivery: "env" as const, envKey: "COMPOSIO_API_KEY", host: "" }, { host: "example.com" }]) {
      await assert.rejects(
        f.keychain.setServiceCredential(orgScope(), {
          slug: "bad",
          name: "Bad",
          secret: projectKey,
          provider: "composio",
          ...input,
        }),
        /server-only/,
      );
    }
  } finally {
    f.close();
  }
});

test("connection references cannot materialize, even under an owner grant", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.keychain.materializeOwnById(owner, f.connection.id, personalScope(owner)),
      /never materialized/,
    );
    const grant = await f.keychain.createGrant({
      credentialId: f.connection.id,
      ownerId: owner,
      audienceScopeId: "channel:team",
      mode: "standing",
      purpose: "Calendar here",
    });
    await assert.rejects(f.keychain.materialize(grant.id, "channel:team", "bob@example.com"), /not grantable/);
    assert.equal(await f.keychain.readOwnSecret(owner, f.connection.id), null);
    assert.deepEqual(await f.keychain.materializeOwn(owner), []);
  } finally {
    f.close();
  }
});

test("helper fails closed on permission revocation and reports availability without keys", async () => {
  const f = await fixture();
  try {
    const status = await f.helper()({ action: "status" });
    assert.equal(JSON.stringify(status).includes(projectKey), false);
    f.allow(false);
    assert.deepEqual(await f.helper()({ action: "status" }), { available: false, providers: [] });
    await assert.rejects(f.helper()(f.request), /No unambiguous/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("native call pauses for exact approval then dispatches only the bound account", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.helper()(f.request), NeedsApproval);
    assert.equal(f.calls.filter((c) => c.body).length, 0);
    assert.match(f.commands[0]!, /GOOGLECALENDAR_EVENTS_LIST/);
    assert.match(f.commands[0]!, /calendar_id/);
    f.approve();
    const result = await f.helper()(f.request);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      data: { items: ["synthetic-event"] },
      error: null,
      successful: true,
    });
    const execution = f.calls.find((c) => c.body)!;
    assert.equal(execution.body?.connected_account_id, "ca_alice");
    assert.match(String(execution.body?.user_id), /^qm_[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(projectKey), false);
    assert.ok(f.audits.includes(`integration.execute:${tool.slug}`));
  } finally {
    f.close();
  }
});

test("another principal and an ungranted shared conversation cannot select an owner's connection", async () => {
  const f = await fixture();
  f.approve();
  try {
    assert.deepEqual(await f.helper("bob@example.com")({ action: "connections" }), []);
    await assert.rejects(f.helper("bob@example.com")(f.request), /authorized|Choose/);
    await assert.rejects(f.helper(owner, "channel:team")(f.request), /authorized|Choose/);
    assert.equal(f.calls.filter((c) => c.body).length, 0);
  } finally {
    f.close();
  }
});

test("one-time connection grants are consumed once, after operation approval", async () => {
  const f = await fixture();
  try {
    const grant = await f.keychain.createGrant({
      credentialId: f.connection.id,
      ownerId: owner,
      audienceScopeId: "channel:team",
      mode: "once",
      purpose: "Read Calendar once",
    });
    await assert.rejects(f.helper("bob@example.com", "channel:team")(f.request), NeedsApproval);
    assert.equal((await f.keychain.getGrant(grant.id))?.status, "active");
    f.approve();
    await f.helper("bob@example.com", "channel:team")(f.request);
    assert.equal((await f.keychain.getGrant(grant.id))?.status, "used");
    await assert.rejects(f.helper("bob@example.com", "channel:team")(f.request));
    assert.equal(f.calls.filter((c) => c.body).length, 1);
  } finally {
    f.close();
  }
});

test("concurrent uses cannot both consume a one-time grant", async () => {
  const f = await fixture();
  try {
    await f.keychain.createGrant({
      credentialId: f.connection.id,
      ownerId: owner,
      audienceScopeId: "channel:team",
      mode: "once",
      purpose: "One call",
    });
    const results = await Promise.allSettled([
      f.keychain.useConnection(f.connection.id, "channel:team", "bob@example.com"),
      f.keychain.useConnection(f.connection.id, "channel:team", "bob@example.com"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    f.close();
  }
});

test("cross-company stored references are not eligible", async () => {
  const f = await fixture();
  f.approve();
  try {
    await f.creds.merge(f.connection.id, { orgId: `${orgId()}-other` });
    await assert.rejects(f.helper()(f.request));
    assert.equal(f.calls.filter((c) => c.body).length, 0);
  } finally {
    f.close();
  }
});

test("disconnect removes local access before provider deletion", async () => {
  const f = await fixture();
  f.approve();
  try {
    await f.helper()({ action: "disconnect", connection: f.connection.id });
    assert.equal(await f.keychain.getCredential(f.connection.id), null);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0]!.path, /connected_accounts\/ca_alice$/);
    await assert.rejects(f.helper()(f.request));
  } finally {
    f.close();
  }
});

test("the common native tool surfaces NeedsApproval instead of converting it into a retryable error", async () => {
  const f = await fixture();
  try {
    const entries: Array<{ type: string; payload: unknown }> = [];
    const ref: ToolContextRef = {
      scopeLabel: personalScope(owner),
      emit: (entry) => {
        entries.push(entry);
      },
      current: { integrations: f.helper() } as ToolContextRef["current"],
      pendingApprovals: [],
    };
    const native = createAgentTools(ref).find((t) => t.name === "integrations")!;
    const result = await (native.execute as (id: string, args: unknown) => Promise<unknown>)("call-1", f.request);
    assert.equal((entries.find((e) => e.type === "tool_call")?.payload as { tool?: string })?.tool, "integrations");
    assert.equal(ref.pausedOnApproval, true);
    assert.equal(ref.pendingApprovals?.length, 1);
    assert.match(JSON.stringify(result), /human approval/);
    assert.equal(f.calls.filter((c) => c.body).length, 0);
  } finally {
    f.close();
  }
});
