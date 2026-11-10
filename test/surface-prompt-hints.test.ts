import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator, type OrchestratorDeps, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import type { SkillStore } from "../src/skills/skill-store.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import type { Surface } from "../src/surfaces/contract.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testSurfaces } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { testConfigStore, testDatabaseUrl, testMap } from "./support/test-database.ts";

const ORG = "default-org";
const actor = { id: "U1", type: "internal" as const, displayName: "Alice" };
type Shape = "dm" | "spine" | "automation";

function fakeSandbox(): Sandbox {
  const unreached = (() => {
    throw new Error("a !sysprompt turn must not touch the sandbox");
  }) as never;
  return {
    profile: {
      backend: "fake",
      writablePersistence: "snapshot_to_workspace",
      processSessions: false,
      spec: { os: "Debian 12 (bookworm)", tools: ["git", "jq"], workdir: "/workspace", homeDir: "/root" },
    },
    provision: unreached,
    run: unreached,
    readFile: unreached,
    writeFile: unreached,
    writeFileBytes: unreached,
    readFileBytes: unreached,
    listDir: unreached,
    removeDir: unreached,
    teardown: unreached,
  };
}

function turnCapture(surfaces: readonly Surface[]) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const mock = createMockAgent();
  const turns: AgentTurnInput[] = [];
  const orchestrator = createOrchestrator({
    ...orchestratorTestDeps(),
    surfaces: createSurfaceRegistry({ surfaces }),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog: createPostgresAuditLog(testDatabaseUrl()),
    agent: {
      ...mock,
      runTurn: (turn) => {
        turns.push(turn);
        return mock.runTurn(turn);
      },
    },
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: {} as OrchestratorDeps["deploy"],
    acl,
    config,
    skills: { visibleFor: async () => [] } as unknown as SkillStore,
    connectorTokens: {
      listConnectorsByOwners: async () => new Map(),
      connectorAccessToken: async () => null,
    } as unknown as ConnectorTokenStore,
    signingSecret: "test-signing-secret",
    apiBaseUrl: "https://api.test",
  });
  let n = 0;
  return async (surface: string | undefined, shape: Shape) => {
    n += 1;
    const result = await orchestrator.handleTurn({
      ...(surface === undefined ? {} : { surface }),
      actor,
      conversation:
        shape === "dm"
          ? { kind: "dm", threadRef: `dm:U1:p${n}`, audience: [actor] }
          : { kind: "channel", threadRef: `ch:C${n}:1.1`, channelRef: `C${n}`, audience: [actor] },
      text: "!sysprompt",
      ...(shape === "dm" ? {} : { surfaceTools: true }),
      origin:
        shape === "automation"
          ? { kind: "automation", destination: { type: "slack", target: `C${n}` } }
          : { kind: "direct" },
    } as OrchestratorInput);
    assert.equal(result.status, shape === "automation" ? "silent" : "ok", (result as { reason?: string }).reason);
    const turn = turns.at(-1)!;
    const name = turn.surfaceName || "slack";
    const tool = createAgentTools(
      { current: {} as ToolContext },
      {
        surfaceTools: true,
        ...(turn.surfaceName ? { surfaceName: turn.surfaceName } : {}),
        ...(turn.surfacePrompt ? { surfacePrompt: turn.surfacePrompt } : {}),
      },
    ).find((t) => t.name === name) as unknown as {
      description: string;
      parameters: { properties: { text: { description: string } } };
    };
    return {
      prompt: turn.systemPrompt,
      tool: tool.description,
      text: tool.parameters.properties.text.description,
    };
  };
}

test("only the Slack surface renders Slack's prompt hints; unregistered surfaces keep the default label and no hints", async () => {
  const surfaces = testSurfaces();
  const slack = surfaces.get("slack")!;
  const hints = Object.values(slack.promptHints);
  const capture = turnCapture([slack]);
  const slackDm = await capture("slack", "dm");
  assert.match(slackDm.prompt, /with Alice over Slack\./);
  assert.ok(slackDm.prompt.includes(`\n\n${slack.promptHints.conversationStyle}\n\nYour reply reaches only`));
  assert.ok(slackDm.prompt.includes(`\n\n${slack.promptHints.linkSyntax}\n\n## System orientation`));
  const slackSpine = await capture("slack", "spine");
  assert.ok(slackSpine.prompt.includes(`no poll.\n\n${slack.promptHints.autonomousStyle}\n\n`));
  for (const rendered of [slackDm, slackSpine]) {
    assert.match(rendered.tool, /^Everything you do on Slack goes through/);
    assert.ok(rendered.text.endsWith(`the surface renders it. ${slack.promptHints.mentionSyntax}`));
  }
  for (const surface of ["web", "monitor", "acme"])
    for (const shape of ["dm", "spine"] as const) {
      const rendered = await capture(surface, shape);
      for (const hint of hints) assert.ok(!rendered.prompt.includes(hint) && !rendered.text.includes(hint), surface);
      if (surface !== "web") assert.match(rendered.prompt, /(over|via) Slack\./, surface);
      assert.match(rendered.tool, new RegExp(`^Everything you do on ${surface} goes through`), surface);
      assert.ok(rendered.text.endsWith("the surface renders it."), surface);
    }
  for (const surface of [undefined, ""])
    for (const shape of ["dm", "spine"] as const) {
      const rendered = await capture(surface, shape);
      for (const hint of hints) assert.ok(!rendered.prompt.includes(hint), shape);
      assert.match(rendered.prompt, /(over|via) Slack\./, shape);
      assert.match(rendered.tool, /^Everything you do on Slack goes through/, shape);
      assert.ok(rendered.text.endsWith(`the surface renders it. ${slack.promptHints.mentionSyntax}`), shape);
    }
  for (const surface of ["cron", "monitor", "web"]) {
    const rendered = await capture(surface, "automation");
    for (const hint of [slack.promptHints.autonomousStyle, slack.promptHints.linkSyntax])
      assert.ok(!rendered.prompt.includes(hint), surface);
    assert.match(rendered.tool, /^Everything you do on Slack goes through/);
    assert.ok(rendered.text.endsWith(`the surface renders it. ${slack.promptHints.mentionSyntax}`));
  }
});

test("a registered surface supplies its own label, prompt hints and mention syntax", async () => {
  const acme: Surface = {
    kind: "acme",
    label: "Acme",
    capabilities: {
      mirrored: false,
      liveReplies: false,
      nativeActor: false,
      externalParticipants: false,
      textOnly: false,
    },
    promptHints: {
      mentionSyntax: "Mention people as @handle.",
      linkSyntax: "Links render as plain Markdown.",
      autonomousStyle: "Acme posts can run long.",
      conversationStyle: "Acme replies can run long.",
    },
    post: async () => {},
    containerOf: (target) => target,
    principalFor: () => ({ externalId: "u" }),
    mention: (user) => `@${user.id}`,
    native: () => null,
  };
  const capture = turnCapture([acme]);
  const spine = await capture("acme", "spine");
  assert.match(
    spine.prompt,
    /in a channel conversation via Acme\. Your words reach people ONLY through the `acme` tool/,
  );
  assert.ok(spine.prompt.includes("no poll.\n\nAcme posts can run long.\n\n"));
  assert.ok(spine.prompt.includes("\n\nLinks render as plain Markdown.\n\n"));
  assert.match(spine.tool, /^Everything you do on Acme goes through this tool/);
  assert.ok(spine.text.endsWith("the surface renders it. Mention people as @handle."));
  const dm = await capture("acme", "dm");
  assert.match(dm.prompt, /with Alice over Acme\./);
  assert.ok(dm.prompt.includes("\n\nAcme replies can run long.\n\nYour reply reaches only"));
});
