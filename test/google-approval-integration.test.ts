import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { defineHarness } from "../src/harness/harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { withOperatorTokenFallback } from "../src/credentials/connector-token.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { NeedsApproval } from "../src/tools/primitives.ts";
import { scopeId, type CommandApprovalGrant, type PendingApprovalRecord, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const actor: Principal = { id: "U1", type: "internal" };
const other: Principal = { id: "U2", type: "internal" };
const googleHosts = [
  "www.googleapis.com",
  "drive.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "slides.googleapis.com",
  "gmail.googleapis.com",
  "calendar.googleapis.com",
];

async function scenario(
  t: TestContext,
  options: { returnedApproval?: boolean; guarded?: boolean; manifest?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "google-approval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const approvalGrants = createMemoryMap<CommandApprovalGrant>();
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("google-approval-test-key"),
  });
  const connectorTokens = withOperatorTokenFallback(keychain, googleHosts, {
    get: async () => "operator-google-token",
  });
  const requests: Array<{ url: URL; method: string; authorization: string | null; body?: string }> = [];
  let version = "1";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body?.toString(),
    });
    if (url.pathname.endsWith("/about")) return Response.json({ user: { permissionId: "permission-u1" } });
    if (method === "PATCH") return Response.json({ id: "file-one", trashed: true });
    if (url.pathname.endsWith("/files")) return Response.json({ files: [] });
    return Response.json({
      id: url.pathname.split("/").at(-1),
      name: "Integration document",
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
      version,
      modifiedTime: "2026-09-18T00:00:00Z",
      capabilities: { canTrash: true },
    });
  };
  const environments: Array<Record<string, string>> = [];
  const unavailable = async () => {
    throw new Error("unexpected sandbox operation");
  };
  const sandbox: Sandbox = {
    profile: { backend: "fake", writablePersistence: "snapshot_to_workspace", processSessions: false },
    provision: async (_layers, opts) => {
      environments.push({ ...opts?.env });
      return { id: "test-box", rootDir: root, env: opts?.env };
    },
    run: async () => ({ stdout: "ok", stderr: "", code: 0, timedOut: false }),
    readFile: async () => "",
    writeFile: async () => undefined,
    writeFileBytes: async () => undefined,
    readFileBytes: unavailable,
    listDir: async () => [],
    removeDir: async () => undefined,
    teardown: async () => undefined,
  };
  let action: { name: string; args: Record<string, unknown> } | undefined = {
    name: "google_workspace_trash",
    args: { fileId: "file-one" },
  };
  let execute = false;
  const toolNames: string[][] = [];
  const systemPrompts: string[] = [];
  const harness = defineHarness(
    {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(),
    },
    {
      async runTurn(turn) {
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        toolNames.push(turn.tools.mcpToolDefs().map((tool) => tool.name));
        systemPrompts.push(turn.systemPrompt);
        if (execute) await turn.tools.execute("pwd");
        let reply = "Tools inspected";
        try {
          if (action) reply = await turn.tools.callMcpTool(action.name, action.args);
        } catch (error) {
          if (!(error instanceof NeedsApproval) || !options.returnedApproval) throw error;
          return {
            reply: "",
            pausedOnApproval: true,
            pendingApprovals: [
              {
                command: error.command,
                reason: error.approvalReason,
                kind: error.kind,
                approvalKey: error.approvalKey,
                grantModes: error.grantModes,
              },
            ],
          };
        }
        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
        return { reply, modelCalls: 1 };
      },
      async screenSecurity() {
        return { decision: "auto" as const };
      },
    },
  );
  const config = createMemoryConfigStore("default-org");
  await config.setApprovalGrantModes(scopeId("org", "default-org"), { session: true, always: true });
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(root);
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService("default-org", config, acl),
    config,
    sessions,
    runs,
    approvals,
    approvalGrants,
    keychain,
    connectorTokens,
    googleWorkspaceGuarded: options.guarded ?? true,
    ...(options.manifest ? { signingSecret: "test-signing", apiBaseUrl: "http://core.test" } : {}),
    googleWorkspaceFetch: fetchImpl,
    isCurrentSharedScopeMember: async () => true,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy: createDeployService({
      deployStore: createDeployStore(),
      provider: createDockerDeployProvider(),
      deployDir: join(root, "deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries: createDeliveryStore(),
  });
  const input = (extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:google", audience: [actor] },
    origin: { kind: "human" },
    text: "Move the test document to trash",
    ...extra,
  });
  const connect = async (owner = actor.id, accountType?: string) => {
    for (const host of googleHosts)
      await keychain.setConnectorToken(
        host,
        owner,
        { accessToken: `google-${owner}-${accountType ?? "default"}` },
        accountType,
      );
  };
  return {
    orchestrator,
    input,
    connect,
    requests,
    approvals,
    approvalGrants,
    config,
    toolNames,
    systemPrompts,
    keychain,
    environments,
    changeVersion: () => {
      version = "2";
    },
    inspect: () => {
      action = undefined;
    },
    execute: () => {
      action = undefined;
      execute = true;
    },
    request: (args: Record<string, unknown>) => {
      action = { name: "google_workspace_request", args };
    },
    trash: (fileId: string) => {
      action = { name: "google_workspace_trash", args: { fileId } };
    },
  };
}

for (const returnedApproval of [false, true]) {
  test(`Google trash ${returnedApproval ? "returned" : "thrown"} approval permits exactly one mutation`, async (t) => {
    const r = await scenario(t, { returnedApproval });
    await r.connect();
    const blocked = await r.orchestrator.handleTurn(r.input());
    assert.equal(blocked.status, "pending_approval");
    const approval = blocked.pendingApprovals?.[0];
    assert.ok(approval);
    assert.deepEqual(approval.grantModes, { session: false, always: false });
    assert.match(approval.command, /Integration document/);
    assert.match(approval.command, /file-one/);
    assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
    assert.deepEqual((await r.approvals.get(approval.requestId))?.grantModes, { session: false, always: false });

    for (const scope of ["session", "always"] as const) {
      const invalid = await r.orchestrator.handleTurn(
        r.input({ approval: { requestId: approval.requestId, approved: true, scope } }),
      );
      assert.equal(invalid.status, "pending_approval");
      assert.equal(invalid.pendingApprovals?.[0]?.requestId, approval.requestId);
      assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
      assert.equal((await r.approvalGrants.all()).length, 0);
    }

    const approved = await r.orchestrator.handleTurn(
      r.input({ approval: { requestId: approval.requestId, approved: true } }),
    );
    assert.equal(approved.status, "ok");
    const writes = r.requests.filter((request) => request.method === "PATCH");
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.authorization, "Bearer google-U1-default");
    assert.deepEqual(JSON.parse(writes[0]!.body!), { trashed: true });
    const replay = await r.orchestrator.handleTurn(
      r.input({ approval: { requestId: approval.requestId, approved: true } }),
    );
    assert.equal(replay.status, "refused");
    r.trash("file-two");
    const next = await r.orchestrator.handleTurn(r.input());
    assert.equal(next.status, "pending_approval");
    assert.notEqual(next.pendingApprovals?.[0]?.requestId, approval.requestId);
    assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 1);
  });
}

test("Google trash rejects another actor and consumes denial without mutating", async (t) => {
  const r = await scenario(t);
  await r.connect();
  await r.config.setSharingPosture(scopeId("org", "default-org"), "open");
  const conversation = {
    kind: "channel" as const,
    channelRef: "C1",
    threadRef: "channel:C1:google",
    audience: [actor, other],
    publishMembers: [actor, other],
  };
  const blocked = await r.orchestrator.handleTurn(r.input({ conversation }));
  const approval = blocked.pendingApprovals?.[0];
  assert.ok(approval);
  const foreign = await r.orchestrator.handleTurn(
    r.input({ conversation, actor: other, approval: { requestId: approval.requestId, approved: true } }),
  );
  assert.equal(foreign.status, "refused");
  assert.match(foreign.reason ?? "", /only the person/);
  const denied = await r.orchestrator.handleTurn(
    r.input({ conversation, approval: { requestId: approval.requestId, approved: false } }),
  );
  assert.equal(denied.status, "refused");
  assert.equal(await r.approvals.get(approval.requestId), null);
  const replay = await r.orchestrator.handleTurn(
    r.input({ conversation, approval: { requestId: approval.requestId, approved: true } }),
  );
  assert.equal(replay.status, "refused");
  assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
});

test("Google trash cannot inherit a stored standing approval", async (t) => {
  const r = await scenario(t);
  await r.connect();
  const first = await r.orchestrator.handleTurn(r.input());
  const approval = first.pendingApprovals?.[0];
  assert.ok(approval);
  await r.approvalGrants.put("standing-google-grant", {
    actorId: actor.id,
    command: approval.command,
    approvalKey: approval.approvalKey,
    scope: "always",
    createdAt: Date.now(),
  });
  const next = await r.orchestrator.handleTurn(r.input());
  assert.equal(next.status, "pending_approval");
  assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
});

for (const returnedApproval of [false, true]) {
  test(`a denied Google ${returnedApproval ? "returned" : "thrown"} approval cannot authorize a new identical request`, async (t) => {
    const r = await scenario(t, { returnedApproval });
    await r.connect();
    const first = await r.orchestrator.handleTurn(r.input());
    const oldApproval = first.pendingApprovals?.[0];
    assert.ok(oldApproval);
    const denied = await r.orchestrator.handleTurn(
      r.input({ approval: { requestId: oldApproval.requestId, approved: false } }),
    );
    assert.equal(denied.status, "refused");
    assert.equal(await r.approvals.get(oldApproval.requestId), null);
    const second = await r.orchestrator.handleTurn(r.input());
    const newApproval = second.pendingApprovals?.[0];
    assert.ok(newApproval);
    assert.equal(newApproval.approvalKey, oldApproval.approvalKey);
    assert.notEqual(newApproval.requestId, oldApproval.requestId);
    const replay = await r.orchestrator.handleTurn(
      r.input({ approval: { requestId: oldApproval.requestId, approved: true } }),
    );
    assert.equal(replay.status, "refused");
    assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
    assert.ok(await r.approvals.get(newApproval.requestId));
    const current = await r.orchestrator.handleTurn(
      r.input({ approval: { requestId: newApproval.requestId, approved: true } }),
    );
    assert.equal(current.status, "ok");
    assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 1);
  });
}

test("a changed Google file gets a distinct approval and the stale card cannot authorize it", async (t) => {
  const r = await scenario(t);
  await r.connect();
  const first = await r.orchestrator.handleTurn(r.input());
  const oldApproval = first.pendingApprovals?.[0];
  assert.ok(oldApproval);
  r.changeVersion();
  const changed = await r.orchestrator.handleTurn(r.input());
  const newApproval = changed.pendingApprovals?.[0];
  assert.ok(newApproval);
  assert.notEqual(newApproval.approvalKey, oldApproval.approvalKey);
  assert.notEqual(newApproval.requestId, oldApproval.requestId);
  const stale = await r.orchestrator.handleTurn(
    r.input({ approval: { requestId: oldApproval.requestId, approved: true } }),
  );
  assert.notEqual(stale.status, "ok");
  assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 0);
  const current = await r.orchestrator.handleTurn(
    r.input({ approval: { requestId: newApproval.requestId, approved: true } }),
  );
  assert.equal(current.status, "ok");
  assert.equal(r.requests.filter((request) => request.method === "PATCH").length, 1);
});

test("guarded Google operations use the caller's core keychain and never an operator or account fallback", async (t) => {
  const r = await scenario(t);
  r.request({ service: "drive", method: "GET", path: "/drive/v3/files" });
  await r.connect(other.id);
  await r.connect(actor.id, "personal");
  await assert.rejects(r.orchestrator.handleTurn(r.input()), /Connect the selected Google account first/);
  assert.equal(r.requests.length, 0);
  await r.connect();
  const mine = await r.orchestrator.handleTurn(r.input());
  assert.equal(mine.status, "ok");
  assert.ok(r.requests.length > 0);
  assert.ok(r.requests.every((request) => request.authorization === "Bearer google-U1-default"));
  assert.doesNotMatch(JSON.stringify(mine), /google-U1-default|operator-google-token/);
});

test("guarded mode suppresses raw Google tokens from the command environment", async (t) => {
  const r = await scenario(t);
  await r.connect();
  r.execute();
  const result = await r.orchestrator.handleTurn(r.input());
  assert.equal(result.status, "ok");
  assert.ok(r.environments.length > 0);
  assert.doesNotMatch(JSON.stringify(r.environments), /google-U1|operator-google-token|VAULT_TOKEN_.*GOOGLEAPIS/);
});

test("Google tools follow the existing shared-conversation personal-keychain gate", async (t) => {
  const r = await scenario(t);
  r.inspect();
  await r.connect();
  const conversation = {
    kind: "channel" as const,
    channelRef: "C2",
    threadRef: "channel:C2:google",
    audience: [actor, other],
    publishMembers: [actor, other],
  };
  await r.orchestrator.handleTurn(r.input({ conversation }));
  assert.ok(!r.toolNames.at(-1)?.includes("google_workspace_request"));
  await r.config.setSharingPosture(scopeId("org", "default-org"), "open");
  await r.orchestrator.handleTurn(r.input({ conversation }));
  assert.ok(r.toolNames.at(-1)?.includes("google_workspace_request"));
  await r.orchestrator.handleTurn(r.input({ conversation, origin: { kind: "automation", useOwnerKeychain: true } }));
  assert.ok(!r.toolNames.at(-1)?.includes("google_workspace_request"));
  await r.orchestrator.handleTurn(r.input({ origin: { kind: "automation", useOwnerKeychain: true } }));
  assert.ok(!r.toolNames.at(-1)?.includes("google_workspace_request"));
});

test("unguarded mode leaves Google tools unavailable", async (t) => {
  const r = await scenario(t, { guarded: false });
  r.inspect();
  await r.orchestrator.handleTurn(r.input());
  assert.ok(!r.toolNames.at(-1)?.includes("google_workspace_request"));
  assert.ok(!r.toolNames.at(-1)?.includes("google_workspace_trash"));
});

for (const guarded of [true, false]) {
  test(`Google connector grant inventory matches guarded=${guarded}`, async (t) => {
    const r = await scenario(t, { guarded, manifest: true });
    await r.connect();
    await r.keychain.setConnectorToken("slack.com", actor.id, { accessToken: "test-slack" });
    const connectors = (await r.keychain.listConnectorsByOwners([actor.id])).get(actor.id)!;
    const asks = await Promise.all(
      ["www.googleapis.com", "slack.com"].map(async (host) => {
        const credential = connectors.find((item) => item.host === host)!;
        return (
          await r.keychain.createAsk({
            credentialId: credential.credentialId,
            requesterId: other.id,
            requesterScopeId: "channel:C1",
            purpose: `Use ${host}`,
          })
        ).ask;
      }),
    );
    r.inspect();
    await r.orchestrator.handleTurn(
      r.input({
        conversation: {
          kind: "channel",
          channelRef: "C1",
          threadRef: "channel:manifest",
          audience: [actor, other],
          publishMembers: [actor, other],
        },
      }),
    );
    const prompt = r.systemPrompts.at(-1)!;
    assert.match(prompt, /connected app slack\.com/);
    if (guarded) assert.doesNotMatch(prompt, /connected app (www|gmail|docs|sheets|slides)\.googleapis\.com/);
    else assert.match(prompt, /connected app www\.googleapis\.com/);
    assert.equal(prompt.includes(asks[0]!.id), !guarded);
    assert.ok(prompt.includes(asks[1]!.id));
    await r.orchestrator.handleTurn(r.input());
    const ownerPrompt = r.systemPrompts.at(-1)!;
    assert.equal(ownerPrompt.includes(asks[0]!.id), !guarded);
    assert.ok(ownerPrompt.includes(asks[1]!.id));
  });
}
