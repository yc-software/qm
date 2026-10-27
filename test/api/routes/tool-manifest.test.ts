import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAgentTools } from "../../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../../src/harness/turn-tool-state.ts";
import { toolManifest, type ToolManifestInput } from "../../../src/harness/tool-manifest.ts";
import type { McpToolDescriptor } from "../../../src/mcp/mcp-tool-service.ts";
import { createServer } from "../../../src/api/server.ts";
import { mintPortalIdentity } from "../../../src/auth/portal-identity.ts";
import { signRequest } from "../../../src/auth/source-auth.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";

const connector = (name: string, readOnly: boolean): McpToolDescriptor => ({
  name,
  serverId: "acme",
  remoteName: name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  readOnly,
  needsApproval: false,
});
const connectors = [connector("acme_search", true), connector("acme_write", false), connector("memory", true)];

function actionsOf(tool: { parameters: unknown }): string[] | undefined {
  const action = (tool.parameters as { properties?: { action?: { anyOf?: Array<{ const?: string }> } } }).properties
    ?.action;
  return action?.anyOf?.map((variant) => variant.const!);
}

test("createAgentTools returns exactly the manifest's present tools, in order, with its actions", () => {
  const bools = [false, true];
  for (const controlTools of bools)
    for (const surfaceTools of bools)
      for (const surfaceName of [undefined, "slack", "web"])
        for (const delegateWork of bools)
          for (const sessionTools of bools)
            for (const readOnly of bools)
              for (const privileged of bools) {
                const ref = {
                  current: privileged
                    ? { installSharedCanvas: async () => null, admin: { operationsAvailable: true } }
                    : { admin: { operationsAvailable: false } },
                } as unknown as TurnToolStateInit;
                const clientTools = [{ name: "page_read", description: "Read", inputSchema: { type: "object" } }];
                const tools = createAgentTools(createTurnToolState(ref), {
                  controlTools,
                  surfaceTools,
                  surfaceName,
                  delegateWork,
                  sessionTools,
                  readOnly,
                  mcpTools: connectors,
                  clientTools,
                });
                const input: ToolManifestInput = {
                  controlTools,
                  surfaceTools,
                  surfaceName,
                  delegateWork,
                  sessionTools,
                  readOnly,
                  canvasInstall: privileged,
                  adminOperations: privileged,
                  connectorTools: connectors,
                  clientTools: ["page_read"],
                };
                const present = toolManifest(input).filter((entry) => entry.present);
                const label = JSON.stringify(input);
                assert.deepEqual(
                  tools.map((tool) => tool.name),
                  present.map((entry) => entry.name),
                  label,
                );
                for (const entry of present.filter((candidate) => candidate.actions))
                  assert.deepEqual(actionsOf(tools.find((tool) => tool.name === entry.name)!), entry.actions, label);
              }
});

test("the manifest explains absent tools", () => {
  const entries = toolManifest({
    controlTools: false,
    surfaceTools: false,
    surfaceName: "web",
    delegateWork: false,
    sessionTools: true,
    readOnly: true,
    canvasInstall: false,
    adminOperations: false,
    connectorTools: connectors,
    clientTools: [],
  });
  const reason = (name: string) => entries.find((entry) => entry.name === name)?.reason;
  assert.equal(
    reason("cron"),
    "Schedules future and recurring work. Off until an admin sets up this server's control API.",
  );
  assert.equal(
    reason("web"),
    "Lets the agent post, react and read messages in the web app on its own. Off in your conversations, where the agent's reply appears directly; on when it posts on its own, as in scheduled runs.",
  );
  assert.equal(reason("execute"), "Runs commands on a sandbox computer. Off because this run is read-only.");
  assert.equal(reason("acme_write"), "Off because this run is read-only and this tool makes changes.");
  assert.equal(entries.find((entry) => entry.source === "connector" && entry.name === "memory")?.present, false);
  assert.equal(reason("acme_search"), "From the acme connector.");
  assert.deepEqual(
    entries.filter((entry) => entry.present).map((entry) => entry.name),
    ["memory", "history", "subagents", "swarm", "sessions", "finish_silently", "runtime", "acme_search"],
  );
});

test("GET /v1/tool-manifest lists the signed-in person's web tools with their connector tools", async () => {
  const secret = "tool-manifest-test-signing-secret";
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: secret,
    requireSignedPortalIdentity: true,
    capabilitySecret: `${secret}capability`,
    portalIdentitySecret: `${secret}portal`,
    apiBaseUrl: "http://api.invalid",
    mcpToolService: {
      toolDefsFor: async (principalId?: string) => (principalId === "alice@default-org" ? connectors : []),
    } as never,
  });
  server.listen(0);
  const get = async (principalId: string) => {
    const path = `/v1/tool-manifest?principalId=${encodeURIComponent(principalId)}`;
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      headers: {
        "x-timestamp": String(ts),
        "x-signature": signRequest(secret, ts, `GET\n${path}\n`),
        "x-portal-identity": await mintPortalIdentity(
          { p: "alice@default-org", exp: Date.now() + 60_000 },
          `${secret}portal`,
        ),
      },
    });
  };
  try {
    assert.equal((await get("bob@default-org")).status, 403);
    const res = await get("alice@default-org");
    assert.equal(res.status, 200);
    const { tools } = (await res.json()) as { tools: Array<{ name: string; present: boolean; actions?: string[] }> };
    const present = tools.filter((tool) => tool.present).map((tool) => tool.name);
    assert.deepEqual(present, [
      "execute",
      "skills",
      "files",
      "apps",
      "memory",
      "history",
      "background",
      "subagents",
      "swarm",
      "sessions",
      "sandbox",
      "cron",
      "webhook",
      "admin",
      "instructions",
      "attach",
      "finish_silently",
      "goal",
      "runtime",
      "context",
      "acme_search",
      "acme_write",
    ]);
    assert.deepEqual(tools.find((tool) => tool.name === "admin")?.actions, ["whoami"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
