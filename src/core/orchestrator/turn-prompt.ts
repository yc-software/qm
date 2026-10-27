import { surfaceProfile, surfaceHas } from "../../surfaces/surface.ts";
import { DEFAULT_CRON_TIMEZONE } from "../../cron/schedule.ts";
import { isBackendCredential } from "../../credentials/keychain.ts";
import { requiresDelegation } from "../../subagents/delegation.ts";
import { type Destination, turnSource } from "../../types.ts";
import { renderGatewayContext } from "../gateway-context.ts";
import { applyPromptVars, loadProtocolFile, type PromptVars } from "../../resolution/prompt-vars.ts";
import { cleanBrandingLabel, resolveBranding } from "../../resolution/branding.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";
import { supportsScopeProfile } from "../../sandbox/sandbox.ts";
import { isPollSurface } from "../../triggers/run-trigger.ts";
import {
  renderKeychainManifest,
  type PublicServiceCredential,
  type KeychainManifestInput,
} from "../../credentials/keychain.ts";
import {
  configuredConnectorProviders,
  connectorStatusIsStale,
  refreshConnectorStatus,
} from "../../credentials/connector-status.ts";
import { renderConnectedAppsBlock } from "../environment-facts.ts";
import { securityScreenChunks } from "../../security/security-screen.ts";
import { isIdeasConversation } from "../../onboarding/onboarding.ts";
import { INBOX_DIR, TURN_FILES_DIR, sharedFilesSystemSection, turnFileId } from "../attachments.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import { personKey, samePerson } from "../../directory/person.ts";
import { hashId } from "../../util/crypto.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import {
  MAX_AUTO_ATTACHMENT_SCREEN_BYTES,
  deliveryCandidatesFor,
  filterConnectorSkills,
  loadActiveBundles,
} from "./turn-helpers.ts";
import {
  currentTimeBlock,
  deliveryMenu,
  renderConversationRoster,
  renderProjectHomeChannel,
  renderReachRoster,
  renderStandingObligations,
} from "./prompt-blocks.ts";

import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { ScreenTrace } from "./inbound-screen.ts";
import type { SecurityObserver } from "./security-screen.ts";
const SHARED_CORE_MD = loadProtocolFile("shared-core");
const MODE_CONVERSATION_MD = loadProtocolFile("mode-conversation");
const MODE_AUTONOMOUS_MD = loadProtocolFile("mode-autonomous");
const MODE_FALLBACK_MD = loadProtocolFile("mode-fallback");
const DELEGATE_WORK_MD = loadProtocolFile("turn-delegate-work");
const EXTERNAL_SLACK_MD = loadProtocolFile("turn-external-slack");
const PRIVATE_SESSION_MESSAGE_MD = loadProtocolFile("turn-private-session-message");
const PROACTIVE_OPENER_MD = loadProtocolFile("turn-proactive-opener");
const IDEAS_CONVERSATION_MD = loadProtocolFile("turn-ideas-conversation");

interface FrameTurnArgs {
  screenTrace: ScreenTrace;
  context: Awaited<ReturnType<typeof resolveTurnContext>>;
  memoryStrategy: MemoryStrategy;
  observeSecurityData: SecurityObserver;
}

export async function frameTurnPrompt(ctx: TurnCtx, turn: FrameTurnArgs) {
  const {
    deps,
    input,
    actor,
    conversation,
    external,
    automatedTurn,
    sessionTurn,
    delegationEnabled,
    turnTimezone,
    resolution,
    scopeId,
    useMemory,
  } = ctx;
  const { context, memoryStrategy } = turn;
  const { memoryScopeId } = context;
  const profile = surfaceProfile(input.surface);
  const isWeb = profile.traits.includes("transcript");
  const surfaceTool = input.surface ?? "slack";
  const branding = await resolveBranding(deps.config, resolution.orgScopeId, deps.brandingDefault);
  const botName = branding.selfLabel ?? "QM";
  const orgName = branding.orgName ?? "this organization";
  const rawHandle = cleanBrandingLabel(input.gatewayContext?.botHandle?.replace(/^@/, ""));
  const botHandle = rawHandle && rawHandle.toLowerCase() !== botName.toLowerCase() ? rawHandle : undefined;
  let modeName = "mode-fallback";
  if (input.surfaceTools) modeName = "mode-autonomous";
  else if (!automatedTurn && !(sessionTurn && input.envelopeWrapped) && (conversation.kind === "dm" || isWeb))
    modeName = "mode-conversation";
  let frameMd = MODE_FALLBACK_MD;
  if (modeName === "mode-autonomous") frameMd = MODE_AUTONOMOUS_MD;
  else if (modeName === "mode-conversation") frameMd = MODE_CONVERSATION_MD;
  const frameVars: PromptVars = {
    botName,
    surfaceTool,
    surfaceLabel: isWeb ? `the ${botName} web app` : deps.surfaceLabel?.(surfaceTool) || "Slack",
    conversationType: { dm: "private 1:1", group: "group conversation", channel: "channel conversation" }[
      conversation.kind
    ],
    web: profile.promptFlavor === "web",
    slack: profile.promptFlavor === "slack",
  };
  if (modeName === "mode-conversation") {
    frameVars.userName = cleanBrandingLabel(actor.displayName) ?? "there";
    frameVars.userEmail = actor.id.includes("@") ? actor.id : undefined;
  }
  const surfaceName =
    input.origin.kind === "automation" && input.origin.destination ? "slack" : (input.surface ?? "slack");
  const sessionSyscalls = external ? undefined : deps.sessionSyscalls;
  const delegateWork = requiresDelegation(input, delegationEnabled);
  let modeFrame = applyPromptVars(frameMd, frameVars);
  if (delegateWork) modeFrame += `\n\n${DELEGATE_WORK_MD}`;
  if (modeName === "mode-conversation" && input.proactiveOpener) {
    modeFrame += `\n${PROACTIVE_OPENER_MD}`;
  }
  const sharedCore = applyPromptVars(SHARED_CORE_MD, {
    botName,
    botHandle,
    orgName,
    web: profile.promptFlavor === "web",
    slack: profile.promptFlavor === "slack",
    sessions: profile.traits.includes("sidebar") && surfaceHas(surfaceName, "sidebar") && Boolean(sessionSyscalls),
  });
  let systemPrompt = `${modeFrame}\n\n${resolution.systemPrompt}\n\n${sharedCore}`;
  if (external) systemPrompt += `\n\n${EXTERNAL_SLACK_MD}`;
  const turnContextBlocks: Record<string, string> = {};
  if (input.privateSessionMessage) systemPrompt += `\n\n${PRIVATE_SESSION_MESSAGE_MD}`;

  const scopeProfile = supportsScopeProfile(deps.sandbox)
    ? await deps.sandbox
        .profileFor(memoryScopeId)
        .catch(swallowAs("orchestrator: scope profile read", deps.sandbox.profile))
    : deps.sandbox.profile;
  const strategyLines = useMemory ? (memoryStrategy.promptLines?.() ?? []) : [];
  if (strategyLines.length) {
    systemPrompt += `\n\n${strategyLines.join("\n")}`;
  }

  const { delivery, defaultDestination, cronBlock } = turnDelivery(ctx);
  await deps.skillsReady;
  const configuredProviders =
    !external && deps.resolveConnectorClient
      ? await configuredConnectorProviders(deps.resolveConnectorClient).catch(
          swallowAs("orchestrator: configured connector providers", []),
        )
      : [];
  const observedSkillScreens = new Set<string>();
  const visibleSkillsForTurn = (sources?: readonly string[]) =>
    listVisibleSkills(ctx, turn, configuredProviders, observedSkillScreens, sources);
  const skillSourceContext = await context.listSkills([scopeId, resolution.orgScopeId]);
  const otherSkillSources = skillSourceContext.skillSources
    .filter((source) => source !== scopeId && source !== resolution.orgScopeId)
    .sort();
  if (otherSkillSources.length)
    systemPrompt += `\n\nAdditional skill sources: ${otherSkillSources.join(", ")}. Use skills list/search with source to discover their authorized skills; read with the same source.`;
  const nativeSkills = filterConnectorSkills(skillSourceContext.skills, configuredProviders);
  const transferId = turnFileId(input.runId, input.attempt);
  const turnSessionDir = `${TURN_FILES_DIR}/${hashId([conversation.threadRef], 24)}`;
  const turnFilesDir = `${turnSessionDir}/${transferId}`;
  const turnInboxDir = `${turnFilesDir}/${INBOX_DIR}`;

  if (!external && deps.deploymentLayer?.hints.length) {
    systemPrompt += `\n\n## Deployment tool hints\n${deps.deploymentLayer.hints.map((hint) => `- ${hint}`).join("\n")}`;
  }
  const gatewayBlock = renderGatewayContext(input.surface, input.gatewayContext);
  if (gatewayBlock) turnContextBlocks["Where you are"] = gatewayBlock;
  const homeChannel =
    conversation.kind === "group" && conversation.channelRef
      ? await deps.managedGroups
          ?.slackChannel?.(conversation.channelRef)
          .catch(swallowAs("orchestrator: project home channel read", undefined))
      : undefined;
  if (homeChannel) turnContextBlocks["Project home channel"] = renderProjectHomeChannel(homeChannel.channelName);
  turnContextBlocks["Where scheduled tasks post"] = cronBlock;
  const sharedFilesBlock = sharedFilesSystemSection(resolution.grantedHandles);
  if (sharedFilesBlock) turnContextBlocks["Files shared with you"] = sharedFilesBlock;

  const timeBlock = currentTimeBlock(turnTimezone ?? DEFAULT_CRON_TIMEZONE, Date.now());

  const memoryHeading = memoryHeadingFor(conversation);
  const onboardingBlock = isIdeasConversation(input) ? IDEAS_CONVERSATION_MD : "";
  return {
    systemPrompt,
    surfaceName,
    sessionSyscalls,
    delegateWork,
    turnContextBlocks,
    scopeProfile,
    delivery,
    defaultDestination,
    configuredProviders,
    visibleSkillsForTurn,
    nativeSkills,
    transferId,
    turnSessionDir,
    turnFilesDir,
    turnInboxDir,
    timeBlock,
    memoryHeading,
    onboardingBlock,
  };
}

function turnDelivery({ deps, input, scopeId }: TurnCtx) {
  const delivery = deliveryCandidatesFor(input.surface, input.deliveryTarget, input.deliveryCandidates, scopeId);
  const source = turnSource(input);
  if (source)
    for (const candidate of delivery.candidates) {
      candidate.account = source.account;
      candidate.workspaceId = source.workspaceId;
    }
  const defaultCandidate = delivery.candidates.find((c) => c.key === delivery.defaultKey);
  let defaultDestination: Destination | undefined;
  if (defaultCandidate) {
    defaultDestination = {
      type: defaultCandidate.type,
      target: defaultCandidate.target,
      ...(defaultCandidate.account ? { account: defaultCandidate.account } : {}),
      ...(defaultCandidate.workspaceId ? { workspaceId: defaultCandidate.workspaceId } : {}),
      ...(defaultCandidate.audienceScopeId ? { audienceScopeId: defaultCandidate.audienceScopeId } : {}),
    };
  } else if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination) {
    defaultDestination = input.origin.destination;
  }
  const cronBlock =
    delivery.candidates.length > 1 && deps.signingSecret && deps.apiBaseUrl
      ? `\n\n${deliveryMenu(delivery.candidates, delivery.defaultKey)}`
      : "";
  return { delivery, defaultDestination, cronBlock };
}

async function listVisibleSkills(
  { deps, input, actor, scopeId }: TurnCtx,
  { context, screenTrace, observeSecurityData }: FrameTurnArgs,
  configuredProviders: Awaited<ReturnType<typeof configuredConnectorProviders>>,
  observedSkillScreens: Set<string>,
  sources?: readonly string[],
): Promise<SkillResolution[]> {
  const current = await context.listSkills(sources);
  const allowed = filterConnectorSkills(current.skills, configuredProviders);
  for (const entry of allowed) {
    const skill = entry.skill;
    if (!skill || !current.sharingSources.includes(skill.scopeId)) continue;
    const snapshot = structuredClone(entry);
    void (async () => {
      const bundles = deps.skillBundles
        ? await loadActiveBundles(deps.skillBundles, [snapshot]).catch(swallowAs("skill screening: load bundles", null))
        : [];
      const payload = JSON.stringify({ manifest: snapshot.skill!.manifest, bundles });
      const key = hashId([skill.scopeId, skill.id, payload], 64);
      if (observedSkillScreens.has(key)) return;
      observedSkillScreens.add(key);
      if (bundles === null || Buffer.byteLength(payload, "utf8") > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) return;
      for (const chunk of securityScreenChunks("tool_result:shared_skill", payload))
        await observeSecurityData(chunk, actor.id, scopeId, {
          ...screenTrace,
          hook: "tool_response",
          request: input.text,
          surface: "shared_skill",
          origin: input.origin.kind,
        });
    })().catch(swallowAs("orchestrator: observed skill screen", undefined));
  }
  for (const entry of allowed) {
    if (!entry.skill || !current.sharingSources.includes(entry.skill.scopeId)) continue;
    deps.auditLog.record({
      at: Date.now(),
      principalId: actor.id,
      action: "sharing.cross_context_read",
      resource: `skill:${entry.skill.id}`,
      scopeLabel: scopeId,
      detail: JSON.stringify({ actor: actor.id, source: entry.skill.scopeId, target: scopeId }),
    });
  }
  return allowed;
}

function memoryHeadingFor(conversation: TurnCtx["conversation"]): string {
  let memoryContext = "a channel";
  if (conversation.kind === "dm") memoryContext = "a direct message";
  else if (conversation.channelName) memoryContext = `#${conversation.channelName}`;
  else if (conversation.kind === "group") memoryContext = "a group conversation";
  return `\n\n## What you remember\nYou're in ${memoryContext}; use these authorized memories freely, but preferences tagged with another scope heading or \`(said in …)\` apply only there.\n\n`;
}

const COMPOSIO_MD = loadProtocolFile("turn-composio");
const ORG_ADMIN_MD = loadProtocolFile("turn-org-admin");
const SCHEDULED_DESTINATION_MD = loadProtocolFile("turn-scheduled-destination");
const POLL_SILENCE_MD = loadProtocolFile("turn-poll-silence");
const USER_REPLY_RULES_MD = loadProtocolFile("user-reply-rules");

export async function finishSystemPrompt(
  ctx: TurnCtx,
  framed: Pick<
    Awaited<ReturnType<typeof frameTurnPrompt>>,
    "systemPrompt" | "turnContextBlocks" | "configuredProviders" | "timeBlock" | "onboardingBlock"
  >,
  catalog: {
    openSpeakerKeychain: boolean;
    credentialDescriptions: NonNullable<KeychainManifestInput["execution"]>;
    serviceCredRecords: PublicServiceCredential[];
    grantedCredSlugs: Set<string>;
    actorIsOrgAdmin: boolean;
  },
  directoryViews: {
    reachableChannelsFor: (directory: DirectoryStore, principalId: string) => Promise<DirectoryChannel[]>;
    directoryIndexFor: (directory: DirectoryStore) => Promise<Map<string, DirectoryMember>>;
  },
): Promise<{ systemPrompt: string; volatileContext: string }> {
  const { deps, input, actor, conversation, external, automatedTurn, strictReadOnly, reachAvailable } = ctx;
  const { turnContextBlocks, configuredProviders, timeBlock, onboardingBlock } = framed;
  const { openSpeakerKeychain, credentialDescriptions, serviceCredRecords, grantedCredSlugs, actorIsOrgAdmin } =
    catalog;
  const { reachableChannelsFor, directoryIndexFor } = directoryViews;
  let systemPrompt = framed.systemPrompt;
  if (
    serviceCredRecords.some(
      (cred) => isBackendCredential(cred) && cred.enabled && cred.hasSecret && grantedCredSlugs.has(cred.slug),
    )
  )
    systemPrompt += `\n\n${COMPOSIO_MD}`;
  if (actorIsOrgAdmin) {
    systemPrompt += `\n\n${ORG_ADMIN_MD}`;
  }
  await addStandingObligations(ctx, turnContextBlocks);
  if (input.origin.kind === "automation" && input.origin.destination && !input.surfaceTools) {
    systemPrompt += `\n\n${SCHEDULED_DESTINATION_MD}`;
  }
  if (automatedTurn && input.surface && isPollSurface(input.surface)) {
    systemPrompt += `\n\n${POLL_SILENCE_MD}`;
  }
  if (reachAvailable) {
    const roster = renderReachRoster(
      await reachableChannelsFor(deps.directory!, actor.id),
      actor.displayName ?? "this person",
    );
    if (roster) turnContextBlocks["Other computers you can reach"] = roster;
  }
  if (!external && deps.directory) await addConversationRoster(ctx, turnContextBlocks, directoryIndexFor);
  if (!strictReadOnly && (deps.keychain || credentialDescriptions.length))
    await addKeychainManifest(ctx, turnContextBlocks, openSpeakerKeychain, credentialDescriptions);
  if (!strictReadOnly && deps.resolveConnectorClient && conversation.kind === "dm")
    await addConnectedApps(ctx, turnContextBlocks, configuredProviders);
  systemPrompt += `\n\n${USER_REPLY_RULES_MD.trim()}`;
  const stableSystemBytes = systemPrompt.length;
  if (timeBlock) systemPrompt += `\n\n${timeBlock}`;
  if (onboardingBlock) systemPrompt += `\n\n${onboardingBlock}`;
  const volatileContext = systemPrompt.slice(stableSystemBytes).trim();
  systemPrompt = systemPrompt.slice(0, stableSystemBytes);
  return { systemPrompt, volatileContext };
}

async function addStandingObligations(
  { deps, scopeId, turnTimezone }: TurnCtx,
  turnContextBlocks: Record<string, string>,
): Promise<void> {
  if (!(deps.signingSecret && deps.apiBaseUrl && (deps.crons || deps.webhooks || deps.monitors))) return;
  const nowMs = Date.now();
  const obligations = await Promise.all([
    deps.crons?.byOwner(scopeId) ?? [],
    deps.webhooks?.byOwner(scopeId) ?? [],
    deps.monitors?.byOwner(scopeId) ?? [],
  ])
    .then(([crons, hooks, mons]) =>
      renderStandingObligations(
        crons.filter(
          (c) =>
            c.enabled &&
            !c.archived &&
            c.ownerScopeId === scopeId &&
            (c.schedule.cron != null || c.schedule.everyMs != null || (c.schedule.firstFireAt ?? c.createdAt) > nowMs),
        ),
        hooks.filter((w) => w.enabled && w.ownerScopeId === scopeId),
        mons.filter((m) => m.enabled && m.ownerScopeId === scopeId && m.expiresAt > nowMs),
        turnTimezone,
      ),
    )
    .catch(swallowAs("orchestrator: standing-obligations read", null));
  turnContextBlocks["Already scheduled here"] =
    obligations ??
    "## Already scheduled here\nScheduled-work status is unavailable; check the live inventories before scheduling.";
}

async function addConversationRoster(
  { deps, actor, conversation }: TurnCtx,
  turnContextBlocks: Record<string, string>,
  directoryIndexFor: (directory: DirectoryStore) => Promise<Map<string, DirectoryMember>>,
): Promise<void> {
  const rosterBlock = await (async () => {
    const audienceMembers = conversation.audience.filter((p) => p.type === "internal");
    const participants = [
      ...(audienceMembers.some((p) => samePerson(p.id, actor.id)) ? [] : [actor]),
      ...audienceMembers,
    ];
    const index = await directoryIndexFor(deps.directory!);
    const seen = new Set<string>();
    const resolved: DirectoryMember[] = [];
    for (const p of participants) {
      if (seen.has(personKey(p.id))) continue;
      seen.add(personKey(p.id));
      const m = index.get(personKey(p.id));
      if (m) resolved.push(m);
      else if (p.displayName) resolved.push({ principalId: p.id, displayName: p.displayName, type: "internal" });
    }
    return renderConversationRoster(resolved);
  })().catch(swallowAs("orchestrator: conversation roster", null));
  if (rosterBlock) turnContextBlocks["Who’s in this conversation"] = rosterBlock;
}

async function addKeychainManifest(
  { deps, actor, conversation, external, scopeId }: TurnCtx,
  turnContextBlocks: Record<string, string>,
  openSpeakerKeychain: boolean,
  credentialDescriptions: NonNullable<KeychainManifestInput["execution"]>,
): Promise<void> {
  const audienceMembers = conversation.audience.filter((p) => p.type === "internal");
  const members = [...(audienceMembers.some((p) => samePerson(p.id, actor.id)) ? [] : [actor]), ...audienceMembers].map(
    (p) => ({ id: p.id, ...(p.displayName ? { displayName: p.displayName } : {}) }),
  );
  const [entriesByOwner, connectorsByOwner, scopeGrants, scopeAsks] = await Promise.all([
    !external ? (deps.keychain?.listByOwners(members.map((m) => m.id)) ?? new Map()) : new Map(),
    !external ? (deps.keychain?.listConnectorsByOwners(members.map((m) => m.id)) ?? new Map()) : new Map(),
    !external ? (deps.keychain?.grantsForScope(scopeId) ?? []) : [],
    !external ? (deps.keychain?.listAsks({ requesterScopeId: scopeId }) ?? []) : [],
  ]);
  const keychainBlock = renderKeychainManifest({
    scopeId,
    conversationKind: conversation.kind,
    openSpeakerKeychain,
    actorId: actor.id,
    members,
    entriesByOwner,
    connectorsByOwner,
    scopeGrants,
    execution: credentialDescriptions,
    scopeAsks,
  });
  if (keychainBlock) turnContextBlocks["Credentials"] = keychainBlock;
}

async function addConnectedApps(
  { deps, actor }: TurnCtx,
  turnContextBlocks: Record<string, string>,
  configuredProviders: Awaited<ReturnType<typeof configuredConnectorProviders>>,
): Promise<void> {
  let status = null;
  try {
    status = deps.connectorStatusCache ? await deps.connectorStatusCache.get(actor.id) : null;
    if (deps.connectorTokens && deps.connectorStatusCache && connectorStatusIsStale(status, Date.now())) {
      status = await refreshConnectorStatus(deps.connectorTokens, actor.id, Date.now());
      await deps.connectorStatusCache.put(status);
    }
  } catch (e) {
    swallow("orchestrator: connected-app status", e);
  }
  const connectionsUrl = deps.publicWebUrl ? `${deps.publicWebUrl}/keychain` : undefined;
  turnContextBlocks["Connected apps"] = renderConnectedAppsBlock(status, configuredProviders, connectionsUrl);
}
