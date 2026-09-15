import type { SecurityScreener } from "../src/security/security-screener.ts";
import { createSkillBundleStore, type SkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
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
import { createSkillStore, type SkillStore } from "../src/skills/skill-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { ManagedGroupDirectory } from "../src/resolution/scope-membership.ts";
import type { IsCurrentSharedScopeMember } from "../src/resolution/scope-membership.ts";

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

function readSandbox(): Sandbox {
  return {
    ...fakeSandbox(),
    provision: async () => ({ id: "read", rootDir: "/workspace" }),
    readFile: async () => null,
    teardown: async () => {},
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
    memoryPolicy?: import("../src/memory/policy.ts").MemoryPolicy;
    crons?: CronStore;
    sandbox?: Sandbox;
    skills?: SkillStore;
    skillBundles?: SkillBundleStore;
    securityScreener?: SecurityScreener;
    managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members" | "version" | "withVersion" | "slackChannel">;
    isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
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
  const sessions = createMemorySessionStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files,
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
  return { orchestrator, memory, config, workspace, sessions, files, auditLog, acl };
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
    "Sandbox environment profile",
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

  assert.match(prompt, /## Sandboxes/);
  assert.match(prompt, /Core is home; sandboxes are optional resources/);
  assert.match(prompt, /\$AGENT_API_URL/);
});

test("Open carries only the live actor's personal reads into a shared turn and audits actual access", async () => {
  const teammate: Principal = { id: "U2", type: "internal" };
  const { orchestrator, config, workspace, files, auditLog } = buildOrchestrator({
    sandbox: readSandbox(),
    isCurrentSharedScopeMember: async (_principalId, sourceScope) => sourceScope === scopeId("channel", "C1"),
  });
  const personal = scopeId("personal", actor.id);
  const teammatePersonal = scopeId("personal", teammate.id);
  const channelScope = scopeId("channel", "C1");
  await workspace.write(personal, "private.txt", "ACTOR_PRIVATE_FILE");
  await workspace.write(teammatePersonal, "teammate.txt", "TEAMMATE_PRIVATE_FILE");
  await workspace.write(personal, "private.bin", new Uint8Array([255, 254, 0, 1]));
  const artifactId = "2".repeat(32);
  await files.put({
    id: artifactId,
    ownerScopeId: personal,
    createdBy: actor.id,
    name: "private-artifact.txt",
    path: `artifacts/${artifactId}/private-artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("ACTOR_PRIVATE_ARTIFACT"),
    direction: "in",
  });
  const channel = (thread: string, text: string, origin: OrchestratorInput["origin"]): OrchestratorInput => ({
    surface: "test",
    actor,
    conversation: {
      kind: "channel",
      threadRef: thread,
      channelRef: "C1",
      audience: [actor, teammate],
      publishMembers: [actor, teammate],
    },
    text,
    origin,
  });

  const isolated = await orchestrator.handleTurn(channel("C1:isolated", "!sysprompt", { kind: "human" }));
  assert.doesNotMatch(isolated.reply ?? "", /shared\/open-personal-U1\/private\.txt/);

  await config.setSharingPosture(scopeId("org", ORG), "open");
  const open = await orchestrator.handleTurn(
    channel("C1:open", "!read shared/open-personal-U1/private.txt", { kind: "human" }),
  );
  assert.equal(open.reply, "ACTOR_PRIVATE_FILE");
  const binary = await orchestrator.handleTurn(
    channel("C1:binary", "!read shared/open-personal-U1/private.bin", { kind: "human" }),
  );
  assert.match(binary.reply ?? "", /Binary files require an explicit share/);
  const artifact = await orchestrator.handleTurn(
    channel("C1:artifact", `!read shared/open-personal-U1/artifacts/${artifactId}/private-artifact.txt`, {
      kind: "human",
    }),
  );
  assert.equal(artifact.reply, "ACTOR_PRIVATE_ARTIFACT");
  const teammateRead = await orchestrator.handleTurn(channel("C1:teammate", "!sysprompt", { kind: "human" }));
  assert.doesNotMatch(teammateRead.reply ?? "", /shared\/open-personal-U2\/teammate\.txt/);
  await workspace.write(personal, "private.txt", "NEW_PRIVATE_CONTENT");
  const nextActor = await orchestrator.handleTurn({
    ...channel("C1:open", "!read shared/open-personal-U1/private.txt", { kind: "human" }),
    actor: teammate,
  });
  assert.doesNotMatch(nextActor.reply ?? "", /NEW_PRIVATE_CONTENT/);
  const nextActorOwn = await orchestrator.handleTurn({
    ...channel("C1:open", "!read shared/open-personal-U2/teammate.txt", { kind: "human" }),
    actor: teammate,
  });
  assert.equal(nextActorOwn.reply, "TEAMMATE_PRIVATE_FILE");

  const automated = await orchestrator.handleTurn(channel("C1:automation", "!sysprompt", { kind: "automation" }));
  assert.doesNotMatch(automated.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  const incompleteRoster = await orchestrator.handleTurn({
    ...channel("C1:incomplete", "!sysprompt", { kind: "human" }),
    conversation: {
      kind: "channel",
      threadRef: "C1:incomplete",
      channelRef: "C1",
      audience: [actor, teammate],
    },
  });
  assert.doesNotMatch(incompleteRoster.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  await config.setExternalSlackParticipants(scopeId("org", ORG), true);
  const external = await orchestrator.handleTurn({
    surface: "slack",
    actor,
    conversation: {
      kind: "channel",
      threadRef: "C1:external",
      channelRef: "C1",
      audience: [actor, { id: "guest@example.com", type: "guest" }],
    },
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.equal(external.status, "ok");
  assert.doesNotMatch(external.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  assert.equal((await workspace.list(channelScope)).includes("private.txt"), false);
  const carryAudit = (await auditLog.events()).find((event) => event.action === "sharing.cross_context_read");
  assert.equal(carryAudit?.principalId, actor.id);
  assert.deepEqual(JSON.parse(carryAudit?.detail ?? "{}"), {
    actor: actor.id,
    source: personal,
    target: channelScope,
  });
});

test("Open labels and audits a carried personal skill without granting it to the room", async () => {
  const personal = scopeId("personal", actor.id);
  const skills = createSkillStore();
  const skill = await skills.create({
    scopeId: personal,
    createdBy: actor.id,
    manifest: {
      name: "private-method",
      description: "Use a private working method",
      body: "Keep the method private.",
      requiredCapabilities: [],
    },
  });
  await skills.review(skill.id, actor.id, []);
  await skills.publish(skill.id);
  const { orchestrator, config, auditLog, acl } = buildOrchestrator({
    skills,
    isCurrentSharedScopeMember: async () => true,
  });
  await config.setSharingPosture(scopeId("org", ORG), "open");
  const result = await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: {
      kind: "channel",
      threadRef: "C1:skill",
      channelRef: "C1",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.match(result.reply ?? "", /\*\*private-method\*\* \[from personal:U1\]/);
  const event = (await auditLog.events()).find(
    (candidate) => candidate.action === "sharing.cross_context_read" && candidate.resource === `skill:${skill.id}`,
  );
  assert.deepEqual(JSON.parse(event?.detail ?? "{}"), {
    actor: actor.id,
    source: personal,
    target: scopeId("channel", "C1"),
  });
  assert.deepEqual(await acl.list(), []);
});

test("Open loads included memories in both directions with provenance and capture stays in the room", async () => {
  let member = true;
  const { orchestrator, config, memory, workspace } = buildOrchestrator({
    sandbox: readSandbox(),
    isCurrentSharedScopeMember: async (principalId, sourceScope) =>
      member && principalId === actor.id && sourceScope === scopeId("channel", "C1"),
  });
  const personal = scopeId("personal", actor.id);
  const channelScope = scopeId("channel", "C1");
  await config.setSharingPosture(scopeId("org", ORG), "open");
  await memory.capture(personal, ["PERSONAL_OPEN_MEMORY"], Date.now(), actor.id);
  const channelConversation: Conversation = {
    kind: "channel",
    threadRef: "C1:memory",
    channelRef: "C1",
    audience: [actor],
    publishMembers: [actor],
  };
  const prompt = await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: channelConversation,
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.match(prompt.reply ?? "", /Sharing posture: Open/);
  assert.match(prompt.reply ?? "", /can reveal private information in a shared reply/);
  assert.match(prompt.reply ?? "", /### personal:U1[\s\S]*PERSONAL_OPEN_MEMORY/);

  await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: { ...channelConversation, threadRef: "C1:capture" },
    text: "!memoryremember ROOM_ONLY_MEMORY",
    origin: { kind: "human" },
  });
  assert.match(await memory.read(channelScope), /ROOM_ONLY_MEMORY/);
  assert.doesNotMatch(await memory.read(personal), /ROOM_ONLY_MEMORY/);

  const search = await orchestrator.handleTurn(
    dm("dm:U1:open-search", "!memorysearch ROOM_ONLY_MEMORY", {
      origin: { kind: "human" },
    }),
  );
  assert.match(search.reply ?? "", /\[channel:C1\].*ROOM_ONLY_MEMORY/);
  await workspace.write(channelScope, "decision.txt", "ROOM_DECISION_FILE");
  const sharedFile = await orchestrator.handleTurn(
    dm("dm:U1:room-file", "!read shared/open-channel-C1/decision.txt", { origin: { kind: "human" } }),
  );
  assert.equal(sharedFile.reply, "ROOM_DECISION_FILE");

  const dmPrompt = await orchestrator.handleTurn(
    dm("dm:U1:search-only", "!sysprompt", {
      origin: { kind: "human" },
    }),
  );
  assert.match(dmPrompt.reply ?? "", /### channel:C1[\s\S]*ROOM_ONLY_MEMORY/);
  assert.match(dmPrompt.reply ?? "", /included, authorized memories/);
  assert.doesNotMatch(dmPrompt.reply ?? "", /apply it only if that tag matches here/);

  member = false;
  const revoked = await orchestrator.handleTurn(
    dm("dm:U1:revoked", "!memorysearch ROOM_ONLY_MEMORY", {
      origin: { kind: "human" },
    }),
  );
  assert.doesNotMatch(revoked.reply ?? "", /ROOM_ONLY_MEMORY/);
  const revokedFile = await orchestrator.handleTurn(
    dm("dm:U1:room-file", "!read shared/open-channel-C1/decision.txt", { origin: { kind: "human" } }),
  );
  assert.doesNotMatch(revokedFile.reply ?? "", /ROOM_DECISION_FILE/);

  member = true;
  await config.setSharingPosture(channelScope, "isolated");
  const vetoed = await orchestrator.handleTurn(
    dm("dm:U1:vetoed", "!memorysearch ROOM_ONLY_MEMORY", {
      origin: { kind: "human" },
    }),
  );
  assert.doesNotMatch(vetoed.reply ?? "", /ROOM_ONLY_MEMORY/);
});

test("the system prompt is byte-identical across two turns a minute apart; the clock rides the environment note", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { orchestrator: orch } = buildOrchestrator();

  const turn = (): OrchestratorInput =>
    dm("dm:U1:cache-stable", "!sysprompt", {
      timezone: "America/New_York",
      deliveryCandidates: [
        { target: "C1", label: "#general" },
        { target: "C2", label: "#random" },
      ],
    });
  const systemOf = (reply: string): string => reply.split("\n\n<environment>")[0]!;
  const environmentOf = (reply: string): string => reply.slice(systemOf(reply).length);

  const first = await orch.handleTurn(turn());
  t.mock.timers.tick(61_000);
  const second = await orch.handleTurn(turn());
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");

  for (const title of [
    "Sandbox environment profile",
    "Skills",
    "Where you are",
    "Where scheduled tasks post",
    "Your logins",
    "Connected apps",
  ]) {
    assert.ok(systemOf(first.reply ?? "").includes(`\n## ${title}\n`), `expected "## ${title}" in the system prompt`);
  }
  for (const title of ["The user's local time", "What you remember"]) {
    assert.ok(
      !systemOf(first.reply ?? "").includes(`\n## ${title}\n`),
      `"## ${title}" must not be in the system prompt`,
    );
  }
  assert.match(environmentOf(first.reply ?? ""), /## The user's local time/);
  assert.notEqual(environmentOf(second.reply ?? ""), environmentOf(first.reply ?? ""), "the clock moved a minute");
  assert.equal(
    systemOf(second.reply ?? ""),
    systemOf(first.reply ?? ""),
    "the system prompt must be byte-identical across turns or every cached message block behind it is invalidated",
  );
});

test("the cached prefix survives skill-store reordering + a recordUse-style metadata update", async () => {
  const mkSkill = (name: string, lastUsedAt?: number) => ({
    skill: { manifest: { name, description: `does ${name}` }, lastUsedAt },
    shadowed: [],
  });
  let visible = [mkSkill("alpha"), mkSkill("midway"), mkSkill("zeta")];
  const churningSkills = { visibleFor: async () => [...visible] } as unknown as SkillStore;
  const { orchestrator: orch } = buildOrchestrator({ skills: churningSkills });

  const prefixOf = (prompt: string): string => prompt.split("\n\n<environment>")[0]!;
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

test("'Sandbox environment profile' renders the substrate profile's spec; no resize menu renders", async () => {
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

for (const mode of ["off", "writable", "skip"] as const) {
  test(`Open respects memory ${mode}`, async () => {
    const { orchestrator, config, memory } = buildOrchestrator({
      sandbox: readSandbox(),
      memoryPolicy: { recall: mode === "skip" ? "visible" : mode, capture: "off" },
      isCurrentSharedScopeMember: async () => true,
    });
    await config.setSharingPosture(scopeId("org", ORG), "open");
    await memory.capture(scopeId("personal", actor.id), ["DO_NOT_RECALL_PRIVATE_NOTE"], Date.now(), actor.id);
    for (const text of [
      "!sysprompt",
      "!memorysearch DO_NOT_RECALL_PRIVATE_NOTE",
      "!read shared/open-personal-U1/memory/MEMORY.md",
    ]) {
      const result = await orchestrator.handleTurn({
        surface: "test",
        actor,
        conversation: {
          kind: "channel",
          channelRef: "C1",
          threadRef: `C1:disabled:${mode}:${text}`,
          audience: [actor],
          publishMembers: [actor],
        },
        origin: { kind: "human" },
        text,
        ...(mode === "skip" ? { skipMemory: true } : {}),
      });
      assert.doesNotMatch(result.reply ?? "", /DO_NOT_RECALL_PRIVATE_NOTE/);
    }
  });
}

test("Open source memory is never exported into a reusable sandbox bearer token", async () => {
  let env: Record<string, string> | undefined;
  const box: Sandbox = {
    ...readSandbox(),
    provision: async (_layers, opts) => {
      env = opts?.env;
      return { id: "open-token", rootDir: "/workspace" };
    },
    run: async () => ({ stdout: "ok", stderr: "", code: 0, timedOut: false }),
    writeFile: async () => {},
    writeFileBytes: async () => {},
    listDir: async () => [],
    removeDir: async () => {},
  };
  const { orchestrator, config, memory } = buildOrchestrator({
    sandbox: box,
    isCurrentSharedScopeMember: async () => true,
  });
  const personal = scopeId("personal", actor.id);
  const room = scopeId("channel", "C1");
  await config.setSharingPosture(scopeId("org", ORG), "open");
  await memory.capture(personal, ["OPEN_TOKEN_PRIVATE"], Date.now(), actor.id);
  const result = await orchestrator.handleTurn({
    surface: "test",
    actor,
    origin: { kind: "human" },
    conversation: {
      kind: "channel",
      channelRef: "C1",
      threadRef: "C1:token",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!run echo ok",
  });
  assert.equal(result.status, "ok", result.reason);
  assert.ok(env?.AGENT_API_TOKEN);
  const claims = await verifyCapabilityToken(env.AGENT_API_TOKEN, "test-signing-secret");
  assert.ok(claims);
  assert.ok(claims.memory?.read.includes(room));
  assert.equal(claims.memory?.read.includes(personal), false);
  await memory.capture(room, ["ROOM_TOKEN_PRIVATE"], Date.now(), actor.id);
  const dmResult = await orchestrator.handleTurn(dm("dm:U1:open-token", "!run echo ok", { origin: { kind: "human" } }));
  assert.equal(dmResult.status, "ok", dmResult.reason);
  const dmClaims = await verifyCapabilityToken(env.AGENT_API_TOKEN, "test-signing-secret");
  assert.ok(dmClaims?.memory?.read.includes(personal));
  assert.equal(dmClaims?.memory?.read.includes(room), false);
});

for (const location of [
  "description",
  "body",
  "asset",
  "bundle",
  "unavailable",
  "multibyte",
  "bundle-error",
] as const) {
  test(`Open screens carried skill ${location} before exposing its index or materialized content`, async () => {
    const skills = createSkillStore();
    const bundles = createSkillBundleStore();
    const owner = scopeId("personal", actor.id);
    const room = scopeId("channel", "C1");
    let marker = "!security-risk";
    if (location === "unavailable") marker = "!security-screen-unavailable";
    if (location === "multibyte") marker = "字".repeat(7000);
    const create = async (scope: string, name: string) => {
      const carried = scope === owner;
      const skill = await skills.create({
        scopeId: scope,
        createdBy: actor.id,
        manifest: {
          name,
          description: carried && location === "description" ? marker : "A useful method",
          body: carried && ["body", "unavailable", "multibyte"].includes(location) ? marker : "Do useful work.",
          requiredCapabilities: [],
          files: carried && location === "asset" ? [{ path: "helper.sh", content: marker }] : [],
        },
        ...(carried && ["bundle", "bundle-error"].includes(location)
          ? { pack: { packId: "test-pack", commit: "1", upstreamName: name } }
          : {}),
      });
      await skills.review(skill.id, actor.id, []);
      await skills.publish(skill.id);
    };
    await create(owner, "carried-method");
    await create(room, "local-method");
    await bundles.put({
      packId: "test-pack",
      commit: "1",
      hash: "bundle-hash",
      files: [{ path: "shared-helper.sh", content: marker }],
    });
    if (location === "bundle-error")
      bundles.get = async () => {
        throw new Error("bundle temporarily unavailable");
      };
    const disk = new Map<string, string>();
    const sandbox: Sandbox = {
      ...readSandbox(),
      readFile: async (_handle, path) => disk.get(path) ?? null,
      writeFile: async (_handle, path, body) => {
        disk.set(path, body);
      },
      writeFileBytes: async (_handle, path, bytes) => {
        disk.set(path, Buffer.from(bytes).toString("utf8"));
      },
      removeDir: async (_handle, path) => {
        for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
      },
      listDir: async () => [],
    };
    const { orchestrator, config } = buildOrchestrator({
      skills,
      skillBundles: bundles,
      sandbox,
      isCurrentSharedScopeMember: async () => true,
    });
    await config.setSharingPosture(scopeId("org", ORG), "open");
    const result = await orchestrator.handleTurn({
      surface: "test",
      actor,
      origin: { kind: "human" },
      conversation: {
        kind: "channel",
        channelRef: "C1",
        threadRef: `C1:screen-${location}`,
        audience: [actor],
        publishMembers: [actor],
      },
      text: "!sysprompt",
    });
    assert.equal(result.status, "ok", result.reason);
    assert.doesNotMatch(result.reply ?? "", /carried-method/);
    assert.match(result.reply ?? "", /local-method/);
    const read = await orchestrator.handleTurn({
      surface: "test",
      actor,
      origin: { kind: "human" },
      conversation: {
        kind: "channel",
        channelRef: "C1",
        threadRef: `C1:read-screen-${location}`,
        audience: [actor],
        publishMembers: [actor],
      },
      text: "!read skills/carried-method/SKILL.md",
    });
    assert.equal(read.status, "ok", read.reason);
    assert.doesNotMatch(read.reply ?? "", /!security-risk|!security-screen-unavailable/);
    assert.equal(disk.has("skills/carried-method/SKILL.md"), false);
    assert.ok(disk.has("skills/local-method/SKILL.md"));
  });
}

test("Open uses the exact skill snapshot that passed screening despite an in-flight source update", async () => {
  const skills = createSkillStore();
  const owner = scopeId("personal", actor.id);
  const skill = await skills.create({
    scopeId: owner,
    createdBy: actor.id,
    manifest: {
      name: "snapshot-method",
      description: "SAFE_DESCRIPTION",
      body: "SAFE_BODY",
      requiredCapabilities: [],
    },
  });
  await skills.review(skill.id, actor.id, []);
  await skills.publish(skill.id);
  let updated = false;
  const securityScreener: SecurityScreener = {
    provider: "test",
    shadow: false,
    classify: async ({ payload }) => {
      if (!updated && payload.includes("SAFE_DESCRIPTION")) {
        updated = true;
        await skills.update(skill.id, {
          ...skill.manifest,
          description: "UNSCREENED_UPDATE !security-risk",
          body: "UNSCREENED_BODY !security-risk",
        });
      }
      return { verdict: { decision: payload.includes("!security-risk") ? "strict" : "auto" }, score: 0, threshold: 1 };
    },
  };
  const { orchestrator, config } = buildOrchestrator({
    skills,
    securityScreener,
    isCurrentSharedScopeMember: async () => true,
  });
  await config.setSharingPosture(scopeId("org", ORG), "open");
  const result = await orchestrator.handleTurn({
    surface: "test",
    actor,
    origin: { kind: "human" },
    conversation: {
      kind: "channel",
      channelRef: "C1",
      threadRef: "C1:skill-snapshot",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!sysprompt",
  });
  assert.equal(result.status, "ok", result.reason);
  assert.equal(updated, true);
  assert.match(result.reply ?? "", /SAFE_DESCRIPTION/);
  assert.doesNotMatch(result.reply ?? "", /UNSCREENED_UPDATE|UNSCREENED_BODY/);
});
