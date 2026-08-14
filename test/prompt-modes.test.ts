import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore, type OrgBranding } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
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

const ORG = "default-org";

const actor: Principal = { id: "U1", type: "internal", displayName: "Alice" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a !sysprompt turn must not touch the sandbox");
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
  get: async () => ({ scopeId: "x", checkedAt: Date.now(), connectors: {} }),
  put: async () => {},
};

const connectorStatusCache: ConnectorStatusCache = {
  get: async () => ({ principalId: actor.id, checkedAt: Date.now(), providers: {} }),
  put: async () => {},
};

const connectorTokens = {
  connectorAccessToken: async () => null,
  connectorTokenStatus: () => {
    throw new Error("connector tokens must not be swept when the status cache is fresh");
  },
} as unknown as ConnectorTokenStore;

const skills = {
  visibleFor: async () => [],
} as unknown as SkillStore;

function buildOrchestrator(
  opts: {
    orgSoul?: string;
    scopeSoulFor?: { conversation: Conversation; soul: string };
    branding?: OrgBranding;
    brandingDefault?: OrgBranding;
  } = {},
) {
  const config = createMemoryConfigStore(ORG);
  if (opts.orgSoul !== undefined) config.setSoul(scopeId("org", ORG), opts.orgSoul);
  if (opts.branding) config.setBranding(scopeId("org", ORG), opts.branding);

  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "pm-")));
  const memory = createMemoryService(workspace);
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "pm-deploy"),
    auditLog,
    acl,
  });
  const resolution = createResolutionService(ORG, config, acl);

  if (opts.scopeSoulFor) {
    const scope = resolution.scopeFor(opts.scopeSoulFor.conversation, actor);
    config.setSoul(scope, opts.scopeSoulFor.soul);
  }

  return createOrchestrator({
    identity: createIdentityService(),
    resolution,
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
    ...(opts.brandingDefault ? { brandingDefault: opts.brandingDefault } : {}),
    skills,
    livenessCache,
    connectorTokens,
    connectorStatusCache,
    signingSecret: "test-signing-secret",
    apiBaseUrl: "https://api.test",
  });
}

const dmConversation: Conversation = { kind: "dm", threadRef: "dm:U1:pm1", audience: [actor] };
const channelConversation: Conversation = {
  kind: "channel",
  threadRef: "ch:C1:pm1",
  channelRef: "C1",
  audience: [actor],
};

const slackDm = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  surface: "slack",
  actor,
  conversation: dmConversation,
  text,
  ...extra,
  origin: extra.origin ?? { kind: "direct" },
});

const spineChannelTurn = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  surface: "slack",
  actor,
  conversation: channelConversation,
  text,
  surfaceTools: true,
  ...extra,
  origin: extra.origin ?? { kind: "direct" },
});

async function sysprompt(orch: ReturnType<typeof createOrchestrator>, input: OrchestratorInput): Promise<string> {
  const res = await orch.handleTurn({ ...input, text: "!sysprompt" });
  assert.equal(res.status, "ok", (res as { reason?: string }).reason);
  const prompt = res.reply ?? "";
  assert.notEqual(prompt, "", "expected !sysprompt to echo the assembled system prompt as the reply");
  return prompt;
}

function assertNoTemplateTokens(prompt: string, label: string) {
  assert.doesNotMatch(
    prompt,
    /\{\{/,
    `${label}: an unreplaced {{...}} template token leaked into the assembled prompt`,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

test("Mode 1 (DM): live-conversation frame, org policy once, no template leaks, no Mode-2 language", async () => {
  const ORG_SOUL = "ORG-POLICY-MARKER: be terse and never promise a refund.";
  const orch = buildOrchestrator({ orgSoul: ORG_SOUL });
  const prompt = await sysprompt(orch, slackDm(""));

  assertNoTemplateTokens(prompt, "Mode 1 (DM)");

  assert.match(
    prompt,
    /You are QM, in a live, private 1:1 with Alice(?: \([^)]+\))? over Slack\./,
    "expected the mode-conversation.md opening sentence, vars filled in for this DM turn",
  );

  assert.match(prompt, /What you write IS your reply/);

  assert.equal(
    countOccurrences(prompt, ORG_SOUL),
    1,
    "org policy text must appear exactly once in a DM prompt with no scope soul",
  );

  assert.doesNotMatch(prompt, /no one ever reads this transcript/);
  assert.doesNotMatch(prompt, /stay_silent/);
  assert.match(prompt, /You are QM/);
});

test("Mode 1 (DM): org policy still renders exactly once when the scope soul duplicates it verbatim", async () => {
  const ORG_SOUL = "ORG-POLICY-MARKER-2: escalate security incidents immediately.";
  const orch = buildOrchestrator({
    orgSoul: ORG_SOUL,
    scopeSoulFor: { conversation: dmConversation, soul: ORG_SOUL },
  });
  const prompt = await sysprompt(orch, slackDm(""));

  assertNoTemplateTokens(prompt, "Mode 1 (DM, duplicate scope soul)");
  assert.equal(
    countOccurrences(prompt, ORG_SOUL),
    1,
    "resolve() must dedupe when the scope soul is string-equal (after trim) to the org soul — " +
      "CONTRACT.md §3 'Org-policy dedupe'",
  );
});

test("Mode 2 (spine channel): autonomous-worklog frame, org policy once, no template leaks, no Mode-1 language", async () => {
  const ORG_SOUL = "ORG-POLICY-MARKER-3: never share customer PII outside the org.";
  const orch = buildOrchestrator({ orgSoul: ORG_SOUL });
  const prompt = await sysprompt(orch, spineChannelTurn(""));

  assertNoTemplateTokens(prompt, "Mode 2 (spine channel)");

  assert.match(
    prompt,
    /no one ever reads this transcript/,
    "expected mode-autonomous.md's stated invariant that this transcript has no human reader",
  );

  assert.equal(
    countOccurrences(prompt, ORG_SOUL),
    1,
    "org policy text must appear exactly once in a spine-channel prompt with no scope soul",
  );

  assert.doesNotMatch(prompt, /your reply is what the person reads/);
  assert.doesNotMatch(prompt, /\/v1\/reach/);
});

test("Mode 2 (spine channel): org policy still renders exactly once when the scope soul duplicates it verbatim", async () => {
  const ORG_SOUL = "ORG-POLICY-MARKER-4: all deploys require a second approver.";
  const orch = buildOrchestrator({
    orgSoul: ORG_SOUL,
    scopeSoulFor: { conversation: channelConversation, soul: ORG_SOUL },
  });
  const prompt = await sysprompt(orch, spineChannelTurn(""));

  assertNoTemplateTokens(prompt, "Mode 2 (spine channel, duplicate scope soul)");
  assert.equal(
    countOccurrences(prompt, ORG_SOUL),
    1,
    "resolve() must dedupe the channel's own soul against the org soul the same way it does for a DM",
  );
});

test("Mode 1 and Mode 2 frames are mutually exclusive within one prompt", async () => {
  const dmPrompt = await sysprompt(buildOrchestrator(), slackDm(""));
  const spinePrompt = await sysprompt(buildOrchestrator(), spineChannelTurn(""));

  assert.match(dmPrompt, /live, private 1:1/);
  assert.doesNotMatch(dmPrompt, /no one ever reads this transcript/);

  assert.match(spinePrompt, /no one ever reads this transcript/);
  assert.doesNotMatch(spinePrompt, /live, private 1:1/);
});

test("shared-core platform guidance reaches both the DM and the spine prompt", async () => {
  for (const prompt of [
    await sysprompt(buildOrchestrator(), slackDm("")),
    await sysprompt(buildOrchestrator(), spineChannelTurn("")),
  ]) {
    assert.match(prompt, /## Your computer/);
    assert.match(prompt, /## Files/);
    assert.match(prompt, /## Memory/);
    assert.match(prompt, /## Auth/);
    assert.match(prompt, /## Using skills/);
    assert.doesNotMatch(prompt, /## Scheduling & self-configuration/);
  }
});

test("identity defaults to QM and 'this organization' when no branding is configured", async () => {
  const prompt = await sysprompt(buildOrchestrator(), slackDm(""));
  assert.match(prompt, /# QM\n/);
  assert.match(prompt, /You are QM — the shared assistant platform for this organization\./);
});

test("org branding renames the assistant and the organization across both modes", async () => {
  const branding: OrgBranding = { selfLabel: "straylight", orgName: "Straylight Industries" };
  const dmPrompt = await sysprompt(buildOrchestrator({ branding }), slackDm(""));
  assert.match(dmPrompt, /# straylight\n/);
  assert.match(dmPrompt, /You are straylight — the shared assistant platform for Straylight Industries\./);
  assert.match(dmPrompt, /You are straylight, in a live, private 1:1 with Alice/);
  assert.doesNotMatch(dmPrompt, /You are QM/);

  const spinePrompt = await sysprompt(buildOrchestrator({ branding }), spineChannelTurn(""));
  assert.match(spinePrompt, /You are straylight, present in this conversation on its own/);
  assert.doesNotMatch(spinePrompt, /You are QM/);
});

test("web conversation surface label carries the configured name", async () => {
  const branding: OrgBranding = { selfLabel: "straylight" };
  const webPrompt = await sysprompt(buildOrchestrator({ branding }), {
    surface: "web",
    actor,
    conversation: dmConversation,
    text: "",
    origin: { kind: "direct" },
  });
  assert.match(webPrompt, /over the straylight web app\./);
});

test("a Slack handle differing from the identity name appears as a mention adjunct in every mode", async () => {
  const branding: OrgBranding = { selfLabel: "straylight" };
  const withHandle = await sysprompt(
    buildOrchestrator({ branding }),
    spineChannelTurn("", { gatewayContext: { botHandle: "qm-bot" } }),
  );
  assert.match(withHandle, /You are straylight \(@qm-bot in Slack\) — the shared assistant platform/);

  const dmWithHandle = await sysprompt(
    buildOrchestrator({ branding }),
    slackDm("", { gatewayContext: { botHandle: "qm-bot" } }),
  );
  assert.match(dmWithHandle, /You are straylight \(@qm-bot in Slack\) — the shared assistant platform/);

  const matchingHandle = await sysprompt(
    buildOrchestrator({ branding }),
    spineChannelTurn("", { gatewayContext: { botHandle: "Straylight" } }),
  );
  assert.match(matchingHandle, /You are straylight — the shared assistant platform/);
  assert.doesNotMatch(matchingHandle, /in Slack\)/);

  const atHandle = await sysprompt(
    buildOrchestrator({ branding }),
    spineChannelTurn("", { gatewayContext: { botHandle: "@qm-bot" } }),
  );
  assert.match(atHandle, /\(@qm-bot in Slack\)/);
  assert.doesNotMatch(atHandle, /@@/);

  const atMatchingHandle = await sysprompt(
    buildOrchestrator({ branding }),
    spineChannelTurn("", { gatewayContext: { botHandle: "@straylight" } }),
  );
  assert.doesNotMatch(atMatchingHandle, /in Slack\)/);

  const hostileHandle = await sysprompt(
    buildOrchestrator({ branding }),
    spineChannelTurn("", { gatewayContext: { botHandle: "{{qm-bot}}" } }),
  );
  assert.match(hostileHandle, /\(@qm-bot in Slack\)/);
  assert.doesNotMatch(hostileHandle, /\{\{/);
});

test("a display name containing template tokens cannot break prompt rendering", async () => {
  const hostileActor: Principal = { id: "U9", type: "internal", displayName: "Al{{ice}}" };
  const prompt = await sysprompt(buildOrchestrator(), {
    surface: "slack",
    actor: hostileActor,
    conversation: { kind: "dm", threadRef: "dm:U9:pm9", audience: [hostileActor] },
    text: "",
    origin: { kind: "direct" },
  });
  assert.match(prompt, /1:1 with Alice/);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("template tokens in a stored branding value are stripped, never rendered or thrown", async () => {
  const prompt = await sysprompt(
    buildOrchestrator({ branding: { selfLabel: "{{straylight}}", orgName: "Acme {{Corp}}" } }),
    slackDm(""),
  );
  assert.match(prompt, /You are straylight — the shared assistant platform for Acme Corp\./);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("env brandingDefault names the assistant when the store has no branding, and the store wins over it", async () => {
  const brandingDefault: OrgBranding = { selfLabel: "envbot", orgName: "Env Org" };
  const fromEnv = await sysprompt(buildOrchestrator({ brandingDefault }), slackDm(""));
  assert.match(fromEnv, /You are envbot — the shared assistant platform for Env Org\./);

  const fromStore = await sysprompt(
    buildOrchestrator({ brandingDefault, branding: { selfLabel: "storebot" } }),
    slackDm(""),
  );
  assert.match(fromStore, /You are storebot — the shared assistant platform for Env Org\./);
});

test("Mode 2 (spine channel): static prose stays within the word-count ceiling (excl. live tail + soul)", async () => {
  const ORG_SOUL = "ORG-POLICY-MARKER-5: keep it short.";
  const orch = buildOrchestrator({ orgSoul: ORG_SOUL });
  const prompt = await sysprompt(orch, spineChannelTurn("", { timezone: "America/New_York" }));

  const VOLATILE_BOUNDARY = "\n\n## The user's local time";
  const boundaryAt = prompt.indexOf(VOLATILE_BOUNDARY);
  assert.notEqual(
    boundaryAt,
    -1,
    "expected the cached-prefix/volatile-tail boundary ('## The user's local time') to still exist — " +
      "if compose renamed or moved this heading, update VOLATILE_BOUNDARY here to match",
  );
  const cachedPrefix = prompt.slice(0, boundaryAt);

  const staticProse = cachedPrefix.split(ORG_SOUL).join("");

  const wordCount = staticProse.trim().split(/\s+/).filter(Boolean).length;

  assert.ok(
    wordCount <= 1400,
    `spine-channel static prose is ${wordCount} words, over the 1400-word ceiling (CONTRACT.md S13). ` +
      "This is expected to fail until the menu deletions in CONTRACT.md S5 land.",
  );
});
