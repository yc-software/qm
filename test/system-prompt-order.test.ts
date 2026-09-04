import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createCronStore, type CronStore } from "../src/cron/cron-store.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { LivenessCache } from "../src/credentials/resident-auth.ts";
import type { ConnectorStatusCache } from "../src/credentials/connector-status.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import type { SkillStore } from "../src/skills/skill-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { ManagedGroupDirectory } from "../src/resolution/scope-membership.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational !sysprompt turn must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "snapshot_to_workspace",
      processSessions: false,
      spec: { os: "Debian 12 (bookworm)", tools: ["git", "jq"], workdir: "/workspace", homeDir: "/root" },
    },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

const livenessCache: LivenessCache = {
  get: async () => ({ scopeId: "x", checkedAt: Date.now(), connectors: { gh: "active" } }),
  put: async () => {},
};

const connectorStatusCache: ConnectorStatusCache = {
  get: async () => ({ principalId: actor.id, checkedAt: Date.now(), providers: { google: { connected: true } } }),
  put: async () => {},
};
const connectorTokens = {
  connectorAccessToken: async () => null,
  connectorTokenStatus: () => {
    throw new Error("connector tokens must not be swept when the status cache is fresh");
  },
} as unknown as ConnectorTokenStore;

const skills = {
  visibleFor: async () => [{ skill: { manifest: { name: "deploy", description: "Deploy the app" } }, shadowed: [] }],
} as unknown as SkillStore;

function buildOrchestrator(
  extra: {
    crons?: CronStore;
    sandbox?: Sandbox;
    skills?: SkillStore;
    managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members" | "version" | "withVersion" | "slackChannel">;
  } = {},
) {
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "spo-")));
  const memory = createMemoryService(workspace);
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "spo-deploy"),
    auditLog,
    acl,
  });
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createMemorySessionStore(),
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory,
    deploy,
    acl,
    config,
    skills,
    livenessCache,
    connectorTokens,
    connectorStatusCache,
    resolveConnectorClient: async (provider) => {
      if (provider !== "google") throw new Error("not configured");
      return { id: "client", secret: "secret", clientRef: "test" };
    },
    signingSecret: "test-signing-secret",
    apiBaseUrl: "https://api.test",
    ...extra,
  });
  return { orchestrator, memory };
}

const dm = (thread: string, text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  text,
  ...extra,
  origin: extra.origin ?? { kind: "direct" },
});

const slackDm = (thread: string, text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  ...dm(thread, text, extra),
  surface: "slack",
});

test("system prompt is ordered cached-prefix → volatile tail, with memory LAST (after every other block)", async () => {
  const { orchestrator: orch, memory } = buildOrchestrator();

  await memory.capture(scopeId("personal", actor.id), ["my favorite color is chartreuse"], Date.now());

  let prompt = "";
  for (let i = 0; i < 200 && !/chartreuse/.test(prompt); i++) {
    await new Promise((r) => setTimeout(r, 10));
    const b = await orch.handleTurn(
      dm(`dm:U1:tB${i}`, "!sysprompt", {
        deliveryCandidates: [
          { target: "C1", label: "#general" },
          { target: "C2", label: "#random" },
        ],
      }),
    );
    assert.equal(b.status, "ok");
    prompt = b.reply ?? "";
  }

  const headingAt = (title: string): number => {
    const at = prompt.indexOf(`\n## ${title}\n`);
    assert.notEqual(at, -1, `expected block "## ${title}" to be present as its own heading`);
    return at;
  };

  const ordered = [
    "This machine",
    "Skills",
    "Where you are",
    "Where scheduled tasks post",
    "Your logins",
    "Connected apps",
    "What you remember",
  ];
  const positions = ordered.map((title) => ({ title, at: headingAt(title) }));
  positions.reduce((prev, cur) => {
    assert.ok(cur.at > prev.at, `"## ${cur.title}" must come AFTER "## ${prev.title}" (got ${cur.at} vs ${prev.at})`);
    return cur;
  });

  assert.ok(
    headingAt("What you remember") > headingAt("Connected apps"),
    "memory (## What you remember) must be appended AFTER ## Connected apps (most-volatile-last)",
  );
  assert.match(prompt, /chartreuse/);

  assert.match(prompt, /## Your computer/);
  assert.match(prompt, /a sandboxed Linux machine whose disk persists/);
  assert.match(prompt, /\$AGENT_API_URL/);
});

test("the cached prefix is byte-identical across two turns of one conversation (only the volatile tail changes)", async () => {
  const { orchestrator: orch } = buildOrchestrator();

  const VOLATILE_BOUNDARY = "\n\n## The user's local time";
  const prefixOf = (prompt: string): string => {
    const at = prompt.indexOf(VOLATILE_BOUNDARY);
    assert.notEqual(at, -1, "the volatile tail must open with ## The user's local time");
    return prompt.slice(0, at);
  };

  const turn = (): OrchestratorInput =>
    dm("dm:U1:cache-stable", "!sysprompt", {
      timezone: "America/New_York",
      deliveryCandidates: [
        { target: "C1", label: "#general" },
        { target: "C2", label: "#random" },
      ],
    });

  const first = await orch.handleTurn(turn());
  const second = await orch.handleTurn(turn());
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");

  const prefixA = prefixOf(first.reply ?? "");
  const prefixB = prefixOf(second.reply ?? "");

  const hasHeading = (text: string, title: string): boolean => text.includes(`\n## ${title}\n`);

  for (const title of ["This machine", "Skills", "Where you are", "Where scheduled tasks post"]) {
    assert.ok(hasHeading(prefixA, title), `expected "## ${title}" inside the cached prefix`);
  }
  for (const title of ["Your logins", "Connected apps", "What you remember"]) {
    assert.ok(!hasHeading(prefixA, title), `"## ${title}" must stay in the volatile tail, not the cached prefix`);
  }

  assert.equal(prefixB, prefixA, "the cached prefix must be byte-identical across two turns of one conversation");
});

test("the cached prefix survives skill-store reordering + a recordUse-style metadata update", async () => {
  const mkSkill = (name: string, lastUsedAt?: number) => ({
    skill: { manifest: { name, description: `does ${name}` }, lastUsedAt },
    shadowed: [],
  });
  let visible = [mkSkill("alpha"), mkSkill("midway"), mkSkill("zeta")];
  const churningSkills = { visibleFor: async () => [...visible] } as unknown as SkillStore;
  const { orchestrator: orch } = buildOrchestrator({ skills: churningSkills });

  const prefixOf = (prompt: string): string => {
    const at = prompt.indexOf("\n\n## The user's local time");
    assert.notEqual(at, -1, "the volatile tail must open with ## The user's local time");
    return prompt.slice(0, at);
  };
  const turn = () => dm("dm:U1:skill-order", "!sysprompt", { timezone: "America/New_York" });

  const first = await orch.handleTurn(turn());
  assert.equal(first.status, "ok");

  visible = [mkSkill("zeta", Date.now()), mkSkill("alpha"), mkSkill("midway")];
  const second = await orch.handleTurn(turn());
  assert.equal(second.status, "ok");

  const prefixA = prefixOf(first.reply ?? "");
  assert.ok(prefixA.includes("**alpha**") && prefixA.includes("**zeta**"), "skills render in the cached prefix");
  assert.equal(
    prefixOf(second.reply ?? ""),
    prefixA,
    "a store-order shuffle + lastUsedAt update must not change a byte of the cached prefix",
  );
});

test("standing obligations: this scope's pending triggers render; other scopes' and immediate one-shots don't", async () => {
  const crons = createCronStore();
  const base = { owner: actor.id, createdBy: actor.id, ownerScopeId: scopeId("personal", actor.id) };
  await crons.create({ ...base, schedule: { everyMs: 300_000 }, action: "poll the vendor status page" });
  await crons.create({ ...base, schedule: { firstFireAt: Date.now() + 86_400_000 }, action: "follow up with legal" });
  await crons.create({ ...base, schedule: { firstFireAt: Date.now() - 1000 }, message: "hi alice" });
  await crons.create({
    ...base,
    ownerScopeId: scopeId("channel", "C9"),
    schedule: { everyMs: 300_000 },
    action: "channel-only digest",
  });

  const { orchestrator: orch } = buildOrchestrator({ crons });
  const b = await orch.handleTurn(dm("dm:U1:obl", "!sysprompt"));
  assert.equal(b.status, "ok");
  const prompt = b.reply ?? "";

  assert.match(prompt, /schedule the wake-up in the same turn/);
  assert.match(prompt, /\n## Already scheduled here\n/);
  assert.match(prompt, /poll the vendor status page/);
  assert.match(prompt, /follow up with legal/);
  assert.doesNotMatch(prompt, /hi alice/);
  assert.doesNotMatch(prompt, /channel-only digest/);
});

test("'This machine' renders the substrate profile's spec; no resize menu renders", async () => {
  const sized: Sandbox = {
    ...fakeSandbox(),
    profile: {
      ...fakeSandbox().profile,
      spec: { ...fakeSandbox().profile.spec, cpus: 4, memoryMb: 8192 },
    },
  };
  const b = await buildOrchestrator({ sandbox: sized }).orchestrator.handleTurn(dm("dm:U1:rz1", "!sysprompt"));
  assert.equal(b.status, "ok");
  const prompt = b.reply ?? "";
  assert.doesNotMatch(prompt, /## Resizing this computer/);
  assert.match(prompt, /4 vCPU \/ 8 GB RAM/, "the This-machine block shows the profile spec");
});

test("Slack turns get the terse-response style instruction; other surfaces do not", async () => {
  const { orchestrator: orch } = buildOrchestrator();

  const slack = await orch.handleTurn(slackDm("dm:U1:slack-style", "!sysprompt"));
  assert.equal(slack.status, "ok");
  assert.doesNotMatch(slack.reply ?? "", /## Talking on Slack/);
  assert.match(slack.reply ?? "", /This is Slack: keep each reply to a couple of sentences/);

  const nonSlack = await orch.handleTurn(dm("dm:U1:non-slack-style", "!sysprompt"));
  assert.equal(nonSlack.status, "ok");
  assert.doesNotMatch(nonSlack.reply ?? "", /## Talking on Slack/);
  assert.doesNotMatch(nonSlack.reply ?? "", /a couple of sentences/);
});
test("a project session names its linked Slack home channel; unlinked projects get no block", async () => {
  const managedGroups = {
    recognizes: (ref: string) => ref.startsWith("web-project-"),
    membership: async () => true,
    members: async () => [actor.id],
    version: async () => "1",
    withVersion: async <T>(_ref: string, _version: string | undefined, fn: () => Promise<T>) => fn(),
    slackChannel: async (ref: string) =>
      ref === "web-project-linked" ? { channelId: "C-ENG", channelName: "eng" } : undefined,
  };
  const { orchestrator: orch } = buildOrchestrator({ managedGroups });

  const group = (ref: string, thread: string): OrchestratorInput => ({
    surface: "test",
    actor,
    conversation: {
      kind: "group",
      threadRef: thread,
      channelRef: ref,
      channelName: "Proj",
      audience: [actor],
    } as Conversation,
    text: "!sysprompt",
    scopeVersion: "1",
    sessionParticipantIds: [actor.id],
    origin: { kind: "direct" },
  });

  const linked = await orch.handleTurn(group("web-project-linked", "grp:linked:1"));
  assert.equal(linked.status, "ok", `refused: ${(linked as { reason?: string }).reason}`);
  const prompt = linked.reply ?? "";
  assert.match(prompt, /## Project home channel/);
  assert.match(prompt, /#eng/);
  assert.match(prompt, /channel: "eng"/);

  const unlinked = await orch.handleTurn(group("web-project-bare", "grp:bare:1"));
  assert.equal(unlinked.status, "ok");
  assert.ok(!(unlinked.reply ?? "").includes("## Project home channel"));
});
