import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorDeps, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import type { SkillStore } from "../src/skills/skill-store.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { externalSlackNamespace } from "../src/slack/external-access.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import { createSlackSurface } from "../src/surfaces/slack/adapter.ts";
import type { Surface } from "../src/surfaces/contract.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testConfigStore, testDatabaseUrl, testMap } from "./support/test-database.ts";

const ORG = "default-org";
const actor = { id: "U1", type: "internal" as const, displayName: "Alice" };
const policy = { companyDomains: ["example.com"], companyTeamIds: ["TCOMPANY"], serviceCredentials: ["safe"] };
const namespace = externalSlackNamespace("T1", policy);
const SHAPES = ["dm", "channel", "spine", "automation", "external"] as const;
type Shape = (typeof SHAPES)[number];

const fixture = JSON.parse(readFileSync(new URL("./fixtures/surface-prompts.json", import.meta.url), "utf8")) as {
  strings: string[];
  cases: Record<string, { surfaceName: string; prompt: number[]; toolLabel: string; mention: number }>;
};

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

function turnCapture(surfaces: readonly Surface[], external: boolean) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const mock = createMockAgent();
  const turns: AgentTurnInput[] = [];
  const deps: OrchestratorDeps = {
    ...singleProcessDeps(),
    surfaces: createSurfaceRegistry({ surfaces }),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    workspace: createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "surface-prompts-"))),
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog: createPostgresAuditLog(testDatabaseUrl()),
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 1000, windowMs: 60_000 }),
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
    ...(external ? { externalSlackPolicies: { batch: policy } } : {}),
    skills: { visibleFor: async () => [] } as unknown as SkillStore,
    connectorTokens: {
      listConnectorsByOwners: async () => new Map(),
      connectorAccessToken: async () => null,
    } as unknown as ConnectorTokenStore,
    signingSecret: "test-signing-secret",
    apiBaseUrl: "https://api.test",
  };
  const orchestrator = createOrchestrator(deps);
  return async (input: OrchestratorInput): Promise<AgentTurnInput> => {
    const result = await orchestrator.handleTurn(input);
    assert.equal(result.status, "ok", (result as { reason?: string }).reason);
    return turns.at(-1)!;
  };
}

function input(surface: string | undefined, shape: Shape, n: number): OrchestratorInput {
  let conversation: OrchestratorInput["conversation"] = {
    kind: "channel",
    threadRef: `ch:C${n}:1.1`,
    channelRef: `C${n}`,
    audience: [actor],
  };
  if (shape === "dm") conversation = { kind: "dm", threadRef: `dm:U1:p${n}`, audience: [actor] };
  if (shape === "external")
    conversation = {
      kind: "channel",
      threadRef: `${namespace}:C${n}:1.1`,
      channelRef: `${namespace}:C${n}`,
      audience: [actor],
    };
  return {
    ...(surface ? { surface } : {}),
    actor,
    conversation,
    text: "!sysprompt",
    ...(shape === "spine" || shape === "automation" ? { surfaceTools: true } : {}),
    ...(shape === "external" ? { externalSlack: { accountId: "batch", teamId: "T1", userId: "U1", ...policy } } : {}),
    origin:
      shape === "automation"
        ? { kind: "automation", destination: { type: "slack", target: `C${n}` } }
        : { kind: "direct" },
  } as OrchestratorInput;
}

function renderedTool(turn: AgentTurnInput) {
  const name = turn.surfaceName ?? "slack";
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
  return { description: tool.description, text: tool.parameters.properties.text.description };
}

test("Slack-registered prompts and surface tool text match the pre-registry rendering for every surface value", async () => {
  const slack = [createSlackSurface({ deliveries: createDeliveryStore() })];
  const plain = turnCapture(slack, false);
  const external = turnCapture(slack, true);
  const turns = new Map<string, AgentTurnInput>();
  let n = 0;
  for (const surface of ["slack", "web", "monitor", "cron", "bookface", undefined])
    for (const shape of SHAPES) {
      n += 1;
      turns.set(
        `${surface ?? "(unset)"}/${shape}`,
        await (shape === "external" ? external : plain)(input(surface, shape, n)),
      );
    }
  const commonLines = (turn: AgentTurnInput) => turn.systemPrompt.split("\n").filter((line) => /slack/i.test(line));
  const everywhere = [...turns.values()]
    .map((turn) => new Set(commonLines(turn)))
    .reduce((acc, lines) => new Set([...acc].filter((line) => lines.has(line))));
  assert.deepEqual([...turns.keys()].sort(), Object.keys(fixture.cases).sort());
  for (const [key, turn] of turns) {
    const expected = fixture.cases[key]!;
    const tool = renderedTool(turn);
    assert.equal(turn.surfaceName, expected.surfaceName, key);
    assert.deepEqual(
      commonLines(turn).filter((line) => !everywhere.has(line)),
      expected.prompt.map((i) => fixture.strings[i]),
      key,
    );
    assert.equal(
      /Everything you do on (.*?) goes through this tool/.exec(tool.description)?.[1],
      expected.toolLabel,
      key,
    );
    assert.equal(tool.text.split("the surface renders it.")[1], fixture.strings[expected.mention], key);
  }
});

test("a registered surface supplies its own label, prompt hints and mention syntax", async () => {
  const bookface: Surface = {
    kind: "bookface",
    label: "Bookface",
    capabilities: {
      threads: false,
      mirrored: false,
      firstBlockAck: false,
      replyEngagement: false,
      actingUser: false,
      externalParticipants: false,
      rateLimitNotice: false,
    },
    promptHints: () => ({
      mentionSyntax: "Mention people as @handle.",
      linkSyntax: "Links render as plain Markdown.",
      autonomousStyle: "Bookface posts can run long.",
      conversationStyle: "Bookface replies can run long.",
    }),
    post: async () => {},
    principalFor: () => ({ externalId: "u" }),
    mention: (user) => `@${user.id}`,
    native: () => null,
  };
  const capture = turnCapture([bookface], false);
  const spine = await capture(input("bookface", "spine", 100));
  assert.match(
    spine.systemPrompt,
    /in a channel conversation via Bookface\. Your words reach people ONLY through the `bookface` tool/,
  );
  assert.match(spine.systemPrompt, /no poll\.\n\nBookface posts can run long\.\n/);
  assert.match(spine.systemPrompt, /\nLinks render as plain Markdown\.\n/);
  assert.doesNotMatch(spine.systemPrompt, /Slack-style links|You're on Slack/);
  const tool = renderedTool(spine);
  assert.match(tool.description, /^Everything you do on Bookface goes through this tool/);
  assert.match(tool.text, /the surface renders it\. Mention people as @handle\.$/);
  const dm = await capture(input("bookface", "dm", 101));
  assert.match(dm.systemPrompt, /with Alice over Bookface\./);
  assert.match(dm.systemPrompt, /\n\nBookface replies can run long\.\n\n/);
  assert.doesNotMatch(dm.systemPrompt, /This is Slack/);
});
