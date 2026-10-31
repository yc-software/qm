import assert from "node:assert/strict";
import { test } from "node:test";
import { surfaceLabel, surfaceToolName } from "../src/surfaces/surface-capabilities.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/surfaces/surface-tools.ts";
import { createPostgresChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a cron firing into a discord destination exposes the discord tool", () => {
  assert.equal(surfaceToolName("cron", "discord"), "discord");
  assert.equal(surfaceToolName("cron", "principal"), "slack");
  assert.equal(surfaceToolName("discord", undefined), "discord");
  assert.equal(surfaceToolName(undefined, undefined), "slack");
});

test("labels come from the registry", () => {
  assert.equal(surfaceLabel("discord"), "Discord");
  assert.equal(surfaceLabel("slack"), "Slack");
});

test("the discord surface tool describes Discord and never the Slack mention syntax", () => {
  const tools = createAgentTools({ current: null }, { surfaceTools: true, surfaceName: "discord" } as never);
  const tool = tools.find((t) => t.name === "discord")!;
  const json = JSON.stringify(tool);
  assert.match(json, /on Discord/);
  assert.doesNotMatch(json, /subteam/);
});

test("setting ambientEnabled on a surface without coreAmbient is refused", async () => {
  const channelPolicy = createPostgresChannelPolicyStore(testDatabaseUrl());
  const tools = createSurfaceToolDeps({
    deps: { deliveries: {}, channelPolicy, auditLog: { record() {} } },
    input: { surfaceTools: true, surface: "discord" },
    actor: { id: "U1" },
    conversation: { kind: "channel", channelRef: "C1" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: {},
    fileRegistration: {},
    provision: async () => ({ rootDir: "/root/workspace" }),
    postProvenance() {
      return {};
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext)!;

  const result = await tools.setStandingOrder("watch", undefined, true);
  assert.equal(result.ok, false);
  assert.match(result.message, /ambient on\/off is not a setting on this surface/);
});

test("setting ambientEnabled on an unset surface is accepted", async () => {
  const channelPolicy = createPostgresChannelPolicyStore(testDatabaseUrl());
  const tools = createSurfaceToolDeps({
    deps: { deliveries: {}, channelPolicy, auditLog: { record() {} } },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel", channelRef: "C1" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: {},
    fileRegistration: {},
    provision: async () => ({ rootDir: "/root/workspace" }),
    postProvenance() {
      return {};
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext)!;

  const result = await tools.setStandingOrder("watch", undefined, true);
  assert.equal(result.ok, true);
  const stored = await channelPolicy.get("C1");
  assert.equal(stored?.ambientEnabled, true);
});
