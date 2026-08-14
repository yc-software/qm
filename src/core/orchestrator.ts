import type {
  CommandApprovalGrant,
  DeliveryProvenance,
  Destination,
  EntryType,
  ScopeId,
  SessionEntry,
  SessionType,
  TurnResult,
  PendingApproval,
  PendingApprovalRecord,
} from "../types.ts";
import { scopeId as toScopeId, personalScope } from "../types.ts";
import { turnOriginRequestFields } from "./turn-origin.ts";
import { resolveTurnFastMode } from "./turn-options.ts";
import { orgId } from "../config.ts";
import { renderGatewayContext } from "./gateway-context.ts";
import { deriveTurnOutcome, approvalBlocksInput } from "./turn-outcome.ts";
import { applyPromptVars, loadProtocolFile, type PromptVars } from "../resolution/prompt-vars.ts";
import { cleanBrandingLabel, resolveBranding } from "../resolution/branding.ts";
import { resolveReachableChannel } from "../resolution/scope-reach.ts";
import { reachEnqueue } from "../reach/reach.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../directory/directory-store.ts";
import { resolveEnvironmentId } from "../environments/environment-store.ts";
import type { GapPhase, LeaseAttempt, SessionStore } from "../sessions/session-store.ts";
import { isOverheardEntry } from "../sessions/session-store.ts";
import { supportsProcessSessions, supportsScopeProfile } from "../sandbox/sandbox.ts";
import { createBackgroundBroker } from "../connectors/background-exec-broker.ts";
import { createMonitorBroker, readBackgroundOutputTail } from "../monitors/monitor-broker.ts";
import { isPollSurface, isSilentPollReply } from "../triggers/run-trigger.ts";
import { envKey } from "../credentials/connector-token.ts";
import { renderKeychainManifest, type MaterializedEnvCred } from "../credentials/keychain.ts";
import { captureDeviceFlowLogins, deviceFlowCredOwner } from "../credentials/device-flow-persist.ts";
import type { DeviceFlowCutoverMode } from "../credentials/device-flow-cutover.ts";
import { type ResidentAuthConnector, RESIDENT_AUTH_CONNECTORS, mergeConnectors } from "../credentials/resident-auth.ts";
import {
  configuredConnectorProviders,
  connectorStatusIsStale,
  refreshConnectorStatus,
} from "../credentials/connector-status.ts";
import { renderComputerBlock, renderResidentLoginsBlock, renderConnectedAppsBlock } from "./environment-facts.ts";
import { PROVIDERS } from "../connectors/oauth.ts";
import { estimateCostUsd } from "../ratelimit/budget.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  OAUTH_CONSENT_AUD,
  CREDENTIAL_BROKER_AUD,
  EGRESS_PROXY_AUD,
  isValidCapabilityTimezone,
  type CapabilityClaims,
} from "../auth/capability-token.ts";
import type { GapWork, HarnessLlmRequestRecord } from "../harness/harness.ts";
import { forModelContext } from "../harness/context-compaction.ts";
import {
  renderSecurityPolicyPrompt,
  securityScreenPayload,
  UNSCREENED_REASON,
  unscreenedNotice,
} from "../security/security-posture.ts";
import { commandApprovalId } from "./approval-id.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { DEFAULT_MEMORY_POLICY, recallMemoryScopes, writableMemoryScope } from "../memory/policy.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { collectBlob, createMemoryBlobTransferStore } from "../persistence/blob-transfer.ts";
import { createSkillMaterializer, skillsIndex, SKILLS_DIR } from "../skills/materialize.ts";
import {
  detectOnboardingStatus,
  onboardingSkillVisible,
  PROACTIVE_OPENER_PROMPT,
  renderPendingOnboardingPrompt,
} from "../onboarding/onboarding.ts";
import { createToolContext, NeedsApproval, CommandDenied } from "../tools/primitives.ts";
import { evaluateCommandWithLayer } from "../policy/command-policy.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import { shq } from "../util/shell.ts";
import type { FileArtifact } from "../files/file-artifact-store.ts";
import { filterHistoryForAudience, principalEntitledToScope } from "../resolution/context-filter.ts";
import {
  filterTapeForAudience,
  foldTape,
  healFoldInterrupt,
  lastImportLacksScopes,
  lintFold,
  rehydrateFoldImages,
  tapeEventsEntitled,
  tapeNeedsInterruptHeal,
} from "../harness/tape-fold.ts";
import { searchSessionEntries } from "../sessions/history-search.ts";
import { defaultPublishAudience } from "../resolution/publish-audience.ts";
import {
  INBOX_DIR,
  OUTBOX_DIR,
  SHARED_DIR,
  TURN_FILES_DIR,
  collectOutbound,
  deliveryManifest,
  environmentNote,
  fileEventPayload,
  inboundIssueList,
  inboundManifest,
  isVisionAttachment,
  MAX_HISTORY_IMAGE_BYTES,
  materializeInbound,
  recentDeliveryNote,
  safeAttachmentName,
  senderNote,
  sharedFilesSystemSection,
  turnFileId,
  type ArtifactRegistration,
} from "./attachments.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { findTrailingPartialTurn, resumeNote } from "./turn-resume.ts";
import {
  coverageImportEvent,
  reconstructMessagesFromHistory,
  recordedMessageTimestamps,
  renderOverheard,
  selectOverheardToImport,
  type OverheardEntryPayload,
} from "../harness/replay.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { jsonbSafeStringify } from "../util/text.ts";
import { NonRetryableTurnError, turnFailureMessage, type TurnFailurePayload } from "./turn-error.ts";
import { personKey, samePerson } from "../directory/person.ts";
import { sleep } from "../util/async.ts";
import { hashId } from "../util/crypto.ts";
import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { SkillResolution, GrantedSkillRef } from "../skills/skill-store.ts";
import type { Orchestrator, OrchestratorDeps, OrchestratorInput } from "./orchestrator/types.ts";
import { resolveModel } from "../model/pi-models.ts";
import {
  MAX_AUTO_ATTACHMENT_SCREEN_BYTES,
  approvalGrantId,
  conversationLabelFor,
  deliveryCandidatesFor,
  egressClaimAllowingControlPlane,
  filterConnectorSkills,
  isScreenableTextAttachment,
  loadTapeImage,
  recentPrincipalDeliveryNote,
  renderTitleTranscript,
  replayableRequest,
  stripAckPrefix,
  stripTurnBoilerplate,
  visibleSkillScopes,
} from "./orchestrator/turn-helpers.ts";
import {
  currentTimeBlock,
  deliveryMenu,
  renderConversationRoster,
  renderProjectHomeChannel,
  renderReachRoster,
  renderStandingObligations,
} from "./orchestrator/prompt-blocks.ts";
import { createCompaction } from "./orchestrator/compaction.ts";
import { createSecurityClassifier } from "./orchestrator/security-screen.ts";
import { createTurnSandboxes } from "./orchestrator/sandboxes.ts";
import { createSurfaceToolDeps, type SpineState } from "./orchestrator/surface-tools.ts";

export {
  egressClaimAllowingControlPlane,
  conversationLabelFor,
  filterConnectorSkills,
  loadTapeImage,
} from "./orchestrator/turn-helpers.ts";
export type { Orchestrator, OrchestratorDeps, OrchestratorInput, SurfaceContextPuller } from "./orchestrator/types.ts";

class ProjectRosterChanged extends Error {}

const ACTIVITY_ENTRY_TYPES = new Set<EntryType>(["tool_call", "tool_result", "approval_request", "approval_resolved"]);

function knownBrowseModel(id: string | null | undefined): { id: string; provider: string } | undefined {
  const provider = id ? resolveModel(id)?.provider : undefined;
  return id && provider ? { id, provider } : undefined;
}

const SHARED_CORE_MD = loadProtocolFile("shared-core");
const MODE_CONVERSATION_MD = loadProtocolFile("mode-conversation");
const MODE_AUTONOMOUS_MD = loadProtocolFile("mode-autonomous");
const MODE_FALLBACK_MD = loadProtocolFile("mode-fallback");

const FIRST_BLOCK_CAPTURE_MAX_CHARS = 20_000;

const DEFAULT_APPROVAL_SUMMARY_TIMEOUT_MS = 6_000;

const CONNECTOR_HOSTS = Object.values(PROVIDERS).flatMap((p) => p.hosts);
const INSTANCE_CACHE_MAX_ENTRIES = 5_000;
const DIRECTORY_INDEX_CACHE_MAX_ENTRIES = 100;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const skillMaterializer = createSkillMaterializer(deps.advisoryLock);
  const residentAuthConnectors = (): ResidentAuthConnector[] =>
    mergeConnectors(RESIDENT_AUTH_CONNECTORS, deps.deploymentLayer?.connectors ?? []);
  const pending = deps.approvals ?? createMemoryMap<PendingApprovalRecord>();
  const approvalGrants = deps.approvalGrants ?? createMemoryMap<CommandApprovalGrant>();
  const memoryPolicy = deps.memoryPolicy ?? DEFAULT_MEMORY_POLICY;
  const memoryStrategy =
    deps.memoryStrategy ?? createPerTurnStrategy({ harness: deps.harness.models, memory: deps.memory });
  const blobTransfer = deps.blobTransfer ?? createMemoryBlobTransferStore();

  const pendingCaptures = new Map<ScopeId, Promise<void>>();

  const REACH_ROSTER_TTL_MS = 5 * 60_000;
  const reachRosterCache = new LRUCache<string, DirectoryChannel[]>({
    max: INSTANCE_CACHE_MAX_ENTRIES,
    ttl: REACH_ROSTER_TTL_MS,
  });
  async function reachableChannelsFor(directory: DirectoryStore, principalId: string): Promise<DirectoryChannel[]> {
    const cached = reachRosterCache.get(principalId);
    if (cached) return cached;
    const channels = await directory.listChannelsFor(principalId);
    reachRosterCache.set(principalId, channels);
    return channels;
  }

  const DIRECTORY_INDEX_TTL_MS = REACH_ROSTER_TTL_MS;
  const directoryIndexCache = new LRUCache<string, Map<string, DirectoryMember>>({
    max: DIRECTORY_INDEX_CACHE_MAX_ENTRIES,
    ttl: DIRECTORY_INDEX_TTL_MS,
  });
  async function directoryIndexFor(directory: DirectoryStore): Promise<Map<string, DirectoryMember>> {
    const cached = directoryIndexCache.get("org");
    if (cached) return cached;
    const byId = new Map<string, DirectoryMember>();
    for (const m of await directory.list()) byId.set(personKey(m.principalId), m);
    directoryIndexCache.set("org", byId);
    return byId;
  }

  const securitySteersInFlight = new Set<string>();
  const { compactContextIfNeeded, scheduleBackgroundCompaction } = createCompaction(deps);

  async function approvalSummary(
    scopeId: ScopeId,
    command: string,
    reason: string,
    purpose?: string,
  ): Promise<string | undefined> {
    if (!deps.harness.models.summarizeApproval) return undefined;
    try {
      const summary = await Promise.race([
        deps.harness.models.summarizeApproval(command, reason, purpose),
        sleep(deps.approvalSummaryTimeoutMs ?? DEFAULT_APPROVAL_SUMMARY_TIMEOUT_MS).then(() => undefined),
      ]);
      return summary?.trim() || undefined;
    } catch (e) {
      deps.errors?.record({
        category: "command_policy",
        code: "summary_failed",
        message: errMessage(e),
        scopeLabel: scopeId,
      });
      return undefined;
    }
  }

  const classifySecurityData = createSecurityClassifier(deps);

  async function generateAndStoreTitle(
    sessionId: string,
    scopeId: ScopeId,
    transcript: string,
    principalId?: string,
  ): Promise<string | undefined> {
    if (!deps.harness.models.generateTitle || !transcript.trim()) return undefined;
    try {
      const title = await deps.harness.models.generateTitle(transcript);
      if (title) {
        if (principalId) await deps.sessions.updateParticipantView(sessionId, principalId, { title });
        else await deps.sessions.updateTitle(sessionId, title);
      }
      return title;
    } catch (e) {
      deps.errors?.record({
        category: "session_title",
        code: "generation_failed",
        message: errMessage(e),
        scopeLabel: scopeId,
        sessionId,
      });
      return undefined;
    }
  }

  function recordSessionBusy(busy: {
    site: "turn" | "quarantined_input";
    attempt: LeaseAttempt;
    sessionId: string;
    scopeId: ScopeId;
    runId?: string;
    surface?: string;
  }): void {
    const at = Date.now();
    deps.errors?.record({
      category: "sessions",
      code: "session_busy",
      message: jsonbSafeStringify({
        site: busy.site,
        heldBy: busy.attempt.heldBy ?? null,
        ...(busy.attempt.heldSince !== undefined ? { heldForMs: at - busy.attempt.heldSince } : {}),
        ...(busy.attempt.heldUntil !== undefined ? { expiresInMs: busy.attempt.heldUntil - at } : {}),
        runId: busy.runId ?? null,
        surface: busy.surface ?? null,
      }),
      scopeLabel: busy.scopeId,
      sessionId: busy.sessionId,
    });
  }

  return {
    async screenSecuritySteer({ payload, actor, conversation, sessionId }) {
      const resolution = await deps.resolution.resolve(conversation, actor);
      if (resolution.securityPolicy.inboundScreening === "off") return "allow";
      const scopeLabel = deps.resolution.scopeFor(conversation, actor);
      const block = (cause: string, reason?: string): "block" => {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "security_posture.steer_block",
          resource: conversation.threadRef,
          scopeLabel,
          status: "strict",
          detail: JSON.stringify({ cause, ...(reason ? { reason } : {}) }),
        });
        return "block";
      };
      if (!deps.securityScreener && !deps.harness.models.screenSecurity) return block("no-screener");
      if (!(await deps.rateLimiter.check(actor.id)).allowed) return block("rate-limited");
      if (deps.budget && !(await deps.budget.check(actor.id)).allowed) return block("over-budget");
      if (securitySteersInFlight.has(conversation.threadRef)) return block("steer-in-flight");
      const bounded = securityScreenPayload({
        surface: "external",
        text: "",
        triggered: true,
        securityScreenData: payload,
      });
      if (!bounded || bounded.truncated) return block("oversize-input");
      securitySteersInFlight.add(conversation.threadRef);
      const verdict = await classifySecurityData(
        bounded.content,
        actor.id,
        scopeLabel,
        sessionId
          ? async (rec) => {
              await deps.sessions.recordLlmRequest(sessionId, { ...rec, scopeLabel });
            }
          : undefined,
        { hook: "user_input", surface: "steer", origin: "ambient" },
      ).finally(() => securitySteersInFlight.delete(conversation.threadRef));
      if (verdict?.decision === "auto") {
        if (!verdict.unscreened) return "allow";
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "security_posture.steer_failed_open",
          resource: conversation.threadRef,
          scopeLabel,
          status: "allowed",
          detail: JSON.stringify({ cause: UNSCREENED_REASON }),
        });
        return "unscreened";
      }
      return block("strict-verdict", verdict?.reason);
    },

    async regenerateTitle(sessionId, principalId, participantIds) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      let entries = await deps.sessions.visibleEntries(sessionId, principalId);
      if (participantIds?.length) {
        const views = await Promise.all(
          participantIds.map((memberId) => deps.sessions.visibleEntries(sessionId, memberId)),
        );
        const common = new Set(views[0]!.map((entry) => entry.seq));
        for (const view of views.slice(1)) {
          const visible = new Set(view.map((entry) => entry.seq));
          for (const seq of common) if (!visible.has(seq)) common.delete(seq);
        }
        entries = entries.filter((entry) => common.has(entry.seq));
      }
      if (entries.length === 0) return null;
      const transcript = renderTitleTranscript(entries);
      const title = await generateAndStoreTitle(
        session.id,
        session.scopeId,
        transcript,
        participantIds?.length ? principalId : undefined,
      );
      return { title: title ?? (participantIds ? null : (session.title ?? null)) };
    },

    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      const { actor, conversation } = input;
      const automatedTurn = input.origin.kind === "automation";
      const ambientTurn = input.origin.kind === "ambient";
      const humanTurn = input.origin.kind === "human";
      const messageTs = input.origin.kind === "human" ? input.origin.messageTs : undefined;
      const entryTs =
        input.origin.kind === "human" || input.origin.kind === "ambient" ? input.origin.entryTs : undefined;
      const coreReceivedAt = Date.now();
      let detectMs: number | undefined;
      let compactMs: number | undefined;
      const turnTimezone = isValidCapabilityTimezone(input.timezone) ? input.timezone : undefined;

      if (!deps.identity.isInternal(actor)) {
        return { status: "refused", reason: "internal-only: non-internal principals cannot interact" };
      }
      const managedGroupRef =
        conversation.kind === "group" &&
        conversation.channelRef &&
        deps.managedGroups?.recognizes(conversation.channelRef)
          ? conversation.channelRef
          : undefined;
      const managedRosterIsCurrent = async (): Promise<boolean> => {
        if (!managedGroupRef) return true;
        const expected = new Set(input.sessionParticipantIds ?? []);
        const [current, version] = await Promise.all([
          deps.managedGroups!.members(managedGroupRef).catch(() => undefined),
          deps.managedGroups!.version(managedGroupRef).catch(() => undefined),
        ]);
        return (
          !!current &&
          version === input.scopeVersion &&
          current.includes(actor.id) &&
          current.length === expected.size &&
          current.every((id) => expected.has(id))
        );
      };
      const withManagedRosterVersion = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (!managedGroupRef) return fn();
        const result = await deps.managedGroups!.withVersion(managedGroupRef, input.scopeVersion, fn);
        if (result === undefined) throw new ProjectRosterChanged();
        return result;
      };
      if (!(await managedRosterIsCurrent())) {
        return { status: "refused", reason: "project membership changed; retry from the current project" };
      }
      if (conversation.kind !== "dm" && !deps.identity.audienceIsAllInternal(conversation.audience)) {
        const externalAllowed =
          input.surface === "slack" &&
          (deps.config ? await deps.config.getExternalSlackParticipantsDurable(toScopeId("org", orgId())) : false);
        if (!externalAllowed) {
          return {
            status: "refused",
            reason: "internal-only: shared audience includes a non-internal participant",
          };
        }
      }

      const rl = await deps.rateLimiter.check(actor.id);
      if (!rl.allowed) {
        return {
          status: "refused",
          reason: `rate limit exceeded — try again in ${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s`,
        };
      }

      if (deps.budget) {
        const b = await deps.budget.check(actor.id);
        if (!b.allowed) {
          return {
            status: "refused",
            reason: `budget exceeded ($${b.spentUsd.toFixed(2)} of $${b.limitUsd}); try again later`,
          };
        }
      }

      const resolution = await deps.resolution.resolve(conversation, actor);
      const scopeId = deps.resolution.scopeFor(conversation, actor);
      let participantHistorySeqs: Set<number> | undefined;
      let participantHistoryMaxSeq = -1;
      const filterHistory = (entries: SessionEntry[]): SessionEntry[] =>
        filterHistoryForAudience(
          participantHistorySeqs
            ? entries.filter((entry) => entry.seq > participantHistoryMaxSeq || participantHistorySeqs!.has(entry.seq))
            : entries,
          conversation.audience,
          scopeId,
          resolution.orgScopeId,
        );
      const reconcileSessionParticipants = async (sessionId: string): Promise<void> => {
        const participantIds = input.sessionParticipantIds;
        if (!participantIds?.length) return;
        const desired = new Set(participantIds);
        const existing = await deps.sessions.participantsOf(sessionId);
        await Promise.all(
          existing
            .filter((principalId) => !desired.has(principalId))
            .map((principalId) => deps.sessions.removeParticipant(sessionId, principalId)),
        );
        await Promise.all(participantIds.map((principalId) => deps.sessions.addParticipant(sessionId, principalId)));
        const snapshot = await deps.sessions.getEntries(sessionId);
        participantHistoryMaxSeq = snapshot.reduce((max, entry) => Math.max(max, entry.seq), -1);
        const views = await Promise.all(
          participantIds.map((principalId) => deps.sessions.visibleEntries(sessionId, principalId)),
        );
        participantHistorySeqs = new Set(views[0]!.map((entry) => entry.seq));
        for (const view of views.slice(1)) {
          const visible = new Set(view.map((entry) => entry.seq));
          for (const seq of participantHistorySeqs) if (!visible.has(seq)) participantHistorySeqs.delete(seq);
        }
        await deps.harness.turns.resetSession?.(sessionId);
      };
      const securityPolicy = resolution.securityPolicy;
      const screenSession: { id?: string } = {};
      const pendingScreenRequests: HarnessLlmRequestRecord[] = [];
      const recordScreenRequest = async (rec: HarnessLlmRequestRecord): Promise<void> => {
        if (!screenSession.id) {
          pendingScreenRequests.push(rec);
          return;
        }
        try {
          await deps.sessions.recordLlmRequest(screenSession.id, { ...rec, scopeLabel: scopeId });
        } catch (err) {
          console.error("[orchestrator] failed to persist security screen request snapshot:", errMessage(err));
        }
      };
      let screenedOverheard: OverheardEntryPayload[] = [];
      let seedPriorTurns = false;
      if (securityPolicy.inboundScreening === "external") {
        const existingSession = await deps.sessions.getByThread(conversation.threadRef);
        const existingEntries = existingSession ? await deps.sessions.getEntries(existingSession.id) : [];
        const quarantinedAttachmentSourceIds = new Set(
          existingEntries.flatMap((entry) => {
            const payload = entry.payload as {
              securityTainted?: unknown;
              quarantinedAttachmentSourceIds?: unknown;
            } | null;
            return payload?.securityTainted === true && Array.isArray(payload.quarantinedAttachmentSourceIds)
              ? payload.quarantinedAttachmentSourceIds.filter((id): id is string => typeof id === "string")
              : [];
          }),
        );
        if (quarantinedAttachmentSourceIds.size && input.attachments?.length) {
          input.attachments = input.attachments.filter(
            (attachment) => !attachment.sourceId || !quarantinedAttachmentSourceIds.has(attachment.sourceId),
          );
        }
        const recorded = recordedMessageTimestamps(existingEntries);
        screenedOverheard = conversation.kind === "dm" ? [] : selectOverheardToImport(input.overheard ?? [], recorded);
        const tainted = existingEntries.some(
          (entry) => (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true,
        );
        if (!tainted && input.priorTurns?.length) {
          try {
            const cleanHistory = filterHistory(forModelContext(existingEntries, { includeSecurityTainted: false }));
            seedPriorTurns = reconstructMessagesFromHistory(cleanHistory).length === 0;
          } catch {
            seedPriorTurns = true;
          }
        }
      }
      let hasUnscreenableAttachment = false;
      const attachmentPromptData: Array<{ source: string; content: string }> = [];
      if (securityPolicy.inboundScreening === "external") {
        for (const attachment of input.attachments ?? []) {
          attachmentPromptData.push({
            source: "attachment-metadata",
            content: JSON.stringify({
              name: attachment.name,
              mimetype: attachment.mimetype,
              author: attachment.author,
            }),
          });
          if (
            isVisionAttachment(attachment) ||
            !isScreenableTextAttachment(attachment.mimetype) ||
            attachment.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES
          ) {
            hasUnscreenableAttachment = true;
            continue;
          }
          const opened = await blobTransfer.open(attachment.blobId).catch(() => null);
          if (!opened || opened.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) {
            hasUnscreenableAttachment = true;
            continue;
          }
          const data = await collectBlob(opened.stream).catch(() => null);
          if (!data || data.length > MAX_AUTO_ATTACHMENT_SCREEN_BYTES || data.includes(0)) {
            hasUnscreenableAttachment = true;
            continue;
          }
          attachmentPromptData.push({
            source: `attachment:${safeAttachmentName(attachment.name)}`,
            content: data.toString("utf8"),
          });
        }
      }
      const externalPromptData =
        securityPolicy.inboundScreening === "external"
          ? [
              ...(ambientTurn && actor.displayName?.trim()
                ? [{ source: "sender", content: senderNote(actor.displayName) }]
                : []),
              ...(input.conversationHeader?.trim()
                ? [{ source: "conversation-header", content: input.conversationHeader }]
                : []),
              ...(seedPriorTurns && conversation.kind !== "dm"
                ? (input.priorTurns ?? [])
                    .filter((turn) => turn.role === "user")
                    .map((turn) => ({
                      source: `prior-turn:${turn.role}${turn.name ? `:${turn.name}` : ""}`,
                      content: turn.text,
                    }))
                : []),
              ...screenedOverheard.map((entry) => ({ source: "overheard", content: renderOverheard(entry) })),
              ...attachmentPromptData,
              ...(input.inboundNotes ?? []).map((note) => ({ source: "inbound-file-note", content: note })),
            ]
          : [];
      const screenPayload =
        securityPolicy.inboundScreening === "external"
          ? securityScreenPayload({
              ...input,
              ...turnOriginRequestFields(input.origin),
              overheard: [],
              externalPromptData,
            })
          : null;
      let quarantineScreenedInput = false;
      let inputUnscreened = false;
      if (screenPayload || hasUnscreenableAttachment) {
        const canScreenText =
          !!screenPayload &&
          !screenPayload.truncated &&
          (!!deps.securityScreener || !!deps.harness.models.screenSecurity);
        const verdict = canScreenText
          ? await classifySecurityData(screenPayload!.content, actor.id, scopeId, recordScreenRequest, {
              hook: "user_input",
              surface: input.surface,
              origin: input.origin.kind,
            })
          : undefined;
        let unscreenableCause: "unscreenable-attachment" | "oversize-input" | "no-screener" | undefined;
        if (hasUnscreenableAttachment || !screenPayload) unscreenableCause = "unscreenable-attachment";
        else if (screenPayload.truncated) unscreenableCause = "oversize-input";
        else if (!deps.securityScreener && !deps.harness.models.screenSecurity) unscreenableCause = "no-screener";
        if (verdict?.decision === "strict") {
          quarantineScreenedInput = true;
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor.id,
            action: "security_posture.quarantine",
            resource: input.surface ?? "unknown",
            scopeLabel: scopeId,
            status: "refused",
            detail: JSON.stringify({ cause: "strict-verdict", ...(verdict.reason ? { reason: verdict.reason } : {}) }),
          });
        } else if (unscreenableCause || verdict?.unscreened) {
          inputUnscreened = true;
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor.id,
            action: "security_posture.input_failed_open",
            resource: input.surface ?? "unknown",
            scopeLabel: scopeId,
            status: "allowed",
            detail: JSON.stringify({ cause: unscreenableCause ?? UNSCREENED_REASON }),
          });
        }
      }
      if (quarantineScreenedInput) {
        let type: SessionType = "channel";
        if (conversation.kind === "dm") type = "dm";
        else if (conversation.kind === "group") type = "group";
        const session = await deps.sessions.getOrCreateByThread(
          conversation.threadRef,
          type,
          scopeId,
          conversation.channelName,
          input.surface,
        );
        screenSession.id = session.id;
        if (!input.sessionParticipantIds?.length && !automatedTurn)
          await deps.sessions.addParticipant(session.id, actor.id);
        const attempt = await deps.sessions.acquireLease(session.id, "turn");
        const lease = attempt.lease;
        if (!lease) {
          recordSessionBusy({
            site: "quarantined_input",
            attempt,
            sessionId: session.id,
            scopeId,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.surface ? { surface: input.surface } : {}),
          });
          return { status: "refused", sessionId: session.id, reason: "session busy (another turn is in progress)" };
        }
        try {
          await withManagedRosterVersion(async () => {
            await reconcileSessionParticipants(session.id);
            await Promise.all(pendingScreenRequests.splice(0).map(recordScreenRequest));
            for (const overheard of screenedOverheard) {
              const imported = await deps.sessions.append(lease, {
                type: "user",
                payload: { ...overheard, securityTainted: true },
                scopeLabel: scopeId,
              });
              await deps.sessions
                .appendTape(lease, {
                  kind: "message",
                  payload: {
                    role: "user",
                    content: [{ type: "text", text: renderOverheard(overheard) }],
                    timestamp: imported.createdAt,
                  },
                  scopeLabel: scopeId,
                  entrySeq: imported.seq,
                  meta: { overheard: true, ts: overheard.ts, ...(overheard.name ? { author: overheard.name } : {}) },
                })
                .catch(swallowAs("tape: quarantined overheard import", undefined));
            }
            const payload: Record<string, unknown> = {
              text: input.text,
              securityTainted: true,
              ...((input.attachments ?? []).some((attachment) => attachment.sourceId)
                ? {
                    quarantinedAttachmentSourceIds: input.attachments!.flatMap((attachment) =>
                      attachment.sourceId ? [attachment.sourceId] : [],
                    ),
                  }
                : {}),
              ...(automatedTurn ? { hidden: true } : {}),
              ...((messageTs ?? entryTs) ? { ts: messageTs ?? entryTs } : {}),
              ...(actor.displayName?.trim() ? { name: actor.displayName.trim() } : {}),
              ...(input.displayText?.trim() ? { display: input.displayText } : {}),
            };
            await deps.sessions.append(lease, { type: "user", payload, scopeLabel: scopeId });
            return true;
          });
        } catch (err) {
          if (err instanceof ProjectRosterChanged) {
            return {
              status: "refused",
              sessionId: session.id,
              reason: "project membership changed; retry from the current project",
            };
          }
          throw err;
        } finally {
          await deps.sessions.releaseLease(lease);
        }
        return {
          status: "refused",
          sessionId: session.id,
          refusalKind: "security_quarantine",
          reason: "Auto quarantined suspicious or unscreenable external input before the agent ran.",
        };
      }
      const strictReadOnly = input.readOnly === true;
      const useMemory = input.skipMemory !== true;
      const environmentId = await resolveEnvironmentId(deps.environments, scopeId);
      const rwLayer = resolution.layers.find((l) => l.mode === "rw");
      if (rwLayer && environmentId !== rwLayer.scopeId) rwLayer.scopeId = environmentId;
      for (const layer of resolution.layers) await deps.workspace.ensureScope(layer.scopeId);

      const memoryScopeId = writableMemoryScope(resolution.layers, scopeId);
      const recallScopes = useMemory ? recallMemoryScopes(memoryPolicy, resolution.layers, memoryScopeId) : [];
      const memoryAccess =
        (useMemory && memoryPolicy.capture !== "off") || recallScopes.length > 0
          ? { ...(useMemory && memoryPolicy.capture !== "off" ? { write: memoryScopeId } : {}), read: recallScopes }
          : undefined;
      const skillScopes = visibleSkillScopes(resolution, scopeId);
      const grantedSkills: GrantedSkillRef[] = (
        await deps.acl
          .sharedOfKindForAudience(
            "skill",
            conversation.audience,
            scopeId,
            resolution.orgScopeId,
            principalEntitledToScope,
          )
          .catch(swallowAs("orchestrator: skill grants for audience", []))
      ).map((g) => ({ id: parseRef(g.ref).id, ownerScopeId: g.ownerScopeId }));
      const recalledSections: string[] = [];
      let recallMs = 0;
      for (const recallScope of recallScopes) {
        const recallStart = Date.now();
        const body = (await deps.memory.recall(recallScope)).trim();
        recallMs += Date.now() - recallStart;
        if (!body) continue;
        recalledSections.push(recallScopes.length === 1 ? body : `### ${recallScope}\n${body}`);
      }
      const recalled = recalledSections.join("\n\n");
      const isWeb = input.surface === "web";
      const isSlack = input.surface === "slack";
      const surfaceTool = input.surface ?? "slack";
      const branding = await resolveBranding(deps.config, resolution.orgScopeId, deps.brandingDefault);
      const botName = branding.selfLabel ?? "QM";
      const orgName = branding.orgName ?? "this organization";
      const rawHandle = cleanBrandingLabel(input.gatewayContext?.botHandle?.replace(/^@/, ""), 40);
      const botHandle = rawHandle && rawHandle.toLowerCase() !== botName.toLowerCase() ? rawHandle : undefined;
      let modeName = "mode-fallback";
      if (input.surfaceTools) modeName = "mode-autonomous";
      else if (!automatedTurn && (conversation.kind === "dm" || isWeb)) modeName = "mode-conversation";
      let frameMd = MODE_FALLBACK_MD;
      if (modeName === "mode-autonomous") frameMd = MODE_AUTONOMOUS_MD;
      else if (modeName === "mode-conversation") frameMd = MODE_CONVERSATION_MD;
      let frameVars: PromptVars = {};
      if (modeName === "mode-autonomous") {
        frameVars = { botName, surfaceTool, slack: isSlack };
      } else if (modeName === "mode-conversation") {
        frameVars = {
          botName,
          userName: cleanBrandingLabel(actor.displayName, 80) ?? "there",
          userEmail: actor.id.includes("@") ? actor.id : undefined,
          surfaceLabel: isWeb ? `the ${botName} web app` : "Slack",
          slack: isSlack,
          web: isWeb,
        };
      }
      let modeFrame = applyPromptVars(frameMd, frameVars);
      if (modeName === "mode-conversation" && input.proactiveOpener) {
        modeFrame += "\nNo one has written yet; open the conversation yourself per the onboarding note below.";
      }
      const sharedCore = applyPromptVars(SHARED_CORE_MD, { botName, botHandle, orgName });
      let systemPrompt = `${modeFrame}\n\n${resolution.systemPrompt}\n\n${sharedCore}\n\n${renderSecurityPolicyPrompt(securityPolicy)}`;
      const scopeProfile = supportsScopeProfile(deps.sandbox)
        ? await deps.sandbox
            .profileFor(memoryScopeId)
            .catch(swallowAs("orchestrator: scope profile read", deps.sandbox.profile))
        : deps.sandbox.profile;
      const strategyLines = useMemory ? (memoryStrategy.promptLines?.() ?? []) : [];
      if (strategyLines.length) {
        systemPrompt += `\n\n${strategyLines.join("\n")}`;
      }

      const delivery = deliveryCandidatesFor(input.surface, input.deliveryTarget, input.deliveryCandidates, scopeId);
      const defaultCandidate = delivery.candidates.find((c) => c.key === delivery.defaultKey);
      let defaultDestination: Destination | undefined;
      if (defaultCandidate) {
        defaultDestination = {
          type: defaultCandidate.type,
          target: defaultCandidate.target,
          ...(defaultCandidate.audienceScopeId ? { audienceScopeId: defaultCandidate.audienceScopeId } : {}),
        };
      } else if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination) {
        defaultDestination = input.origin.destination;
      }
      const cronBlock =
        delivery.candidates.length > 1 && deps.signingSecret && deps.apiBaseUrl
          ? `\n\n${deliveryMenu(delivery.candidates, delivery.defaultKey)}`
          : "";

      await deps.skillsReady;
      const configuredProviders = deps.resolveConnectorClient
        ? await configuredConnectorProviders(deps.resolveConnectorClient).catch(
            swallowAs("orchestrator: configured connector providers", []),
          )
        : [];
      const visibleSkillsForTurn = async (): Promise<SkillResolution[]> =>
        filterConnectorSkills((await deps.skills?.visibleFor(skillScopes, grantedSkills)) ?? [], configuredProviders);
      const visibleSkills = await visibleSkillsForTurn();
      const transferId = turnFileId(input.runId, input.attempt);
      const turnSessionDir = `${TURN_FILES_DIR}/${hashId([conversation.threadRef], 24)}`;
      const turnFilesDir = `${turnSessionDir}/${transferId}`;
      const turnInboxDir = `${turnFilesDir}/${INBOX_DIR}`;
      const turnOutboxDir = `${turnFilesDir}/${OUTBOX_DIR}`;
      const turnSharedDir = `${turnFilesDir}/${SHARED_DIR}`;

      const computerBlock = renderComputerBlock(scopeProfile.spec, {
        hasGlobal: resolution.layers.some((l) => l.mountPath === "global"),
        teamCount: resolution.layers.filter((l) => l.mountPath.startsWith("team-")).length,
      });
      if (computerBlock) {
        systemPrompt += `\n\n${computerBlock}`;
        if (deps.scratchExec) {
          systemPrompt +=
            '\nThis describes your durable, scoped computer — `execute` runs here by default. The opt-in scratch box (scope:"scratch") is separate: same OS and tooling, org-global files only, no logins or tokens, wiped after the turn — only for runs that confidently need no follow-up.';
        }
      }
      if (deps.deploymentLayer?.hints.length) {
        systemPrompt += `\n\n## Deployment tool hints\n${deps.deploymentLayer.hints.map((hint) => `- ${hint}`).join("\n")}`;
      }
      if (visibleSkills.length) systemPrompt += `\n\n${skillsIndex(visibleSkills)}`;
      const gatewayBlock = renderGatewayContext(input.surface, input.gatewayContext);
      if (gatewayBlock) systemPrompt += `\n\n${gatewayBlock}`;
      const homeChannel =
        conversation.kind === "group" && conversation.channelRef
          ? await deps.managedGroups
              ?.slackChannel?.(conversation.channelRef)
              .catch(swallowAs("orchestrator: project home channel read", undefined))
          : undefined;
      if (homeChannel) systemPrompt += `\n\n${renderProjectHomeChannel(homeChannel.channelName)}`;
      systemPrompt += cronBlock;
      const sharedFilesBlock = sharedFilesSystemSection(resolution.grantedHandles);
      if (sharedFilesBlock) systemPrompt += `\n\n${sharedFilesBlock}`;

      const stableSystemBytes = systemPrompt.length;
      if (turnTimezone) {
        const timeBlock = currentTimeBlock(turnTimezone, Date.now());
        if (timeBlock) systemPrompt += `\n\n${timeBlock}`;
      }
      let memoryContext = "a channel";
      if (conversation.kind === "dm") memoryContext = "a direct message";
      else if (conversation.channelName) memoryContext = `#${conversation.channelName}`;
      else if (conversation.kind === "group") memoryContext = "a group conversation";
      const memoryBlock = recalled
        ? `\n\n## What you remember\nYou're in ${memoryContext}. A memory tagged \`(said in …)\` was stated in another context — apply it only if that tag matches here; untagged memories are general.\n\n${recalled}`
        : "";

      let onboardingBlock = "";
      if (useMemory && conversation.kind === "dm" && onboardingSkillVisible(visibleSkills)) {
        const fullMemory = await deps.memory.read(memoryScopeId).catch(swallowAs("orchestrator: memory read", ""));
        onboardingBlock = renderPendingOnboardingPrompt(detectOnboardingStatus(fullMemory));
      }

      let type: SessionType = "channel";
      if (conversation.kind === "dm") type = "dm";
      else if (conversation.kind === "group") type = "group";
      let leaseMs = 0;
      const perf = { credsMs: 0 };
      const sessionStart = Date.now();
      const session = await deps.sessions.getOrCreateByThread(
        conversation.threadRef,
        type,
        scopeId,
        conversation.channelName,
        input.surface,
      );
      screenSession.id = session.id;
      leaseMs += Date.now() - sessionStart;
      if (!input.sessionParticipantIds?.length && !automatedTurn)
        await deps.sessions.addParticipant(session.id, actor.id);

      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "turn",
        resource: conversation.threadRef,
        scopeLabel: scopeId,
      });

      const commandUses = new Map<string, number>();
      for (const grant of await approvalGrants.all()) {
        if (!samePerson(grant.actorId, actor.id)) continue;
        if (grant.scope === "session" && grant.sessionId !== session.id) continue;
        if (!resolution.approvalGrantModes[grant.scope]) continue;
        commandUses.set(grant.approvalKey ?? grant.command, Infinity);
      }
      const authorizeToolCall = (tool: string): boolean => {
        const key = `tool:${tool}`;
        const n = commandUses.get(key) ?? 0;
        if (n <= 0) return false;
        commandUses.set(key, n - 1);
        return true;
      };
      const authorizeCommand = (command: string, approvalKey?: string): boolean => {
        let key = approvalKey ?? command;
        if (approvalKey !== undefined && commandUses.has(approvalKey)) key = approvalKey;
        else if (commandUses.has(command)) key = command;
        const n = commandUses.get(key) ?? 0;
        if (n <= 0) return false;
        commandUses.set(key, n - 1);
        return true;
      };
      const brokeredTools = deps.brokeredTools ?? [];
      const cutoverModes = new Map<string, DeviceFlowCutoverMode>();
      for (const tool of brokeredTools) {
        const policy = deps.deviceFlowCutover
          ? await deps.deviceFlowCutover.resolvePolicy(memoryScopeId, tool.service)
          : null;
        cutoverModes.set(tool.service, policy?.mode ?? "legacy");
      }
      const cutoverModeOf = (service: string): DeviceFlowCutoverMode => cutoverModes.get(service) ?? "legacy";
      const quarantinedServices = brokeredTools
        .filter((tool) => cutoverModeOf(tool.service) === "ephemeral_only")
        .map((tool) => tool.service);
      const brokerCutoverServices = brokeredTools
        .filter((tool) => cutoverModeOf(tool.service) !== "legacy")
        .map((tool) => tool.service);
      const isolateOwnerKeychain =
        deps.sharedOwnerAuthIsolation === true &&
        conversation.kind !== "dm" &&
        input.origin.kind === "automation" &&
        input.origin.useOwnerKeychain === true;
      let ownerAuthAvailable = isolateOwnerKeychain;
      if (
        deps.sharedOwnerAuthIsolation === true &&
        conversation.kind !== "dm" &&
        brokeredTools.some((tool) => cutoverModeOf(tool.service) !== "legacy" && deps.layerBrokerFor?.(tool))
      ) {
        ownerAuthAvailable = true;
      }
      const connectorEnv: Record<string, string> = {};
      const ownerAuthEnv: Record<string, string> = {};
      const ownerEnvCredentialIds: string[] = [];
      const keychainInjected: MaterializedEnvCred[] = [];
      const credsStart = Date.now();
      if (!strictReadOnly && deps.keychain) {
        const own =
          scopeId === personalScope(actor.id) ||
          (input.origin.kind === "automation" && input.origin.useOwnerKeychain && !isolateOwnerKeychain)
            ? await deps.keychain.materializeOwn(actor.id)
            : [];
        if (isolateOwnerKeychain) {
          for (const materialized of await deps.keychain.materializeOwn(actor.id)) {
            for (const { key, value } of materialized.env) if (!(key in ownerAuthEnv)) ownerAuthEnv[key] = value;
            ownerEnvCredentialIds.push(materialized.credentialId);
          }
        }
        for (const m of [...own, ...(await deps.keychain.materializeStanding(scopeId))]) {
          const injected = m.env.filter(({ key }) => !(key in connectorEnv));
          for (const { key, value } of injected) connectorEnv[key] = value;
          if (m.grantId && injected.length) {
            keychainInjected.push({ ...m, env: injected });
            deps.auditLog.record({
              at: Date.now(),
              principalId: actor.id,
              action: "keychain.materialize",
              resource: `${m.credentialId} (grant ${m.grantId})`,
              scopeLabel: scopeId,
            });
          }
        }
      }
      if (!strictReadOnly && deps.connectorTokens && conversation.kind === "dm") {
        for (const host of CONNECTOR_HOSTS) {
          const token =
            (await deps.connectorTokens.connectorAccessToken(host, actor.id, "personal")) ??
            (await deps.connectorTokens.connectorAccessToken(host, actor.id)) ??
            (await deps.connectorTokens.connectorAccessToken(host, actor.id, "company"));
          if (token) connectorEnv[envKey(host)] = token;
        }
      }
      perf.credsMs += Date.now() - credsStart;
      let sharedCredsBlock = "";
      let egressTokenForTurn: string | undefined;
      const allInternal =
        deps.identity.audienceIsAllInternal(conversation.audience) &&
        (conversation.kind === "dm" ||
          (!!conversation.publishMembers?.length && conversation.publishMembers.every((p) => p.type === "internal")));
      const liveTurn = humanTurn && allInternal;
      const authoredDetection =
        input.origin.kind === "ambient" && input.origin.live === true && conversation.kind !== "dm";
      const liveAuthorTurn = (humanTurn || authoredDetection) && allInternal;
      if (!strictReadOnly && allInternal && deps.serviceCreds) {
        const orgScope = toScopeId("org", orgId());
        for (const cred of await deps.serviceCreds.listServiceCredentials(orgScope)) {
          if (
            cred.delivery !== "env" ||
            !cred.envKey ||
            !cred.enabled ||
            !cred.hasSecret ||
            cred.envKey in connectorEnv
          )
            continue;
          const rec = await deps.serviceCreds.getServiceCredentialSecret(orgScope, cred.slug);
          if (rec?.secret && rec.delivery === "env" && rec.enabled && rec.envKey === cred.envKey)
            connectorEnv[cred.envKey] = rec.secret;
        }
        const browseSteps = deps.config?.getBrowseMaxSteps(toScopeId("org", orgId()));
        if (browseSteps && !("BROWSE_LAB_MAX_STEPS" in connectorEnv))
          connectorEnv.BROWSE_LAB_MAX_STEPS = String(browseSteps);
        const browseChoice =
          knownBrowseModel(deps.config?.getBrowseModel(toScopeId("org", orgId()))) ??
          knownBrowseModel(deps.resolveBaseModelId?.());
        if (browseChoice && !("BROWSE_LAB_MODEL" in connectorEnv)) {
          connectorEnv.BROWSE_LAB_MODEL = browseChoice.id;
          connectorEnv.BROWSE_LAB_MODEL_PROVIDER = browseChoice.provider;
        }
      }
      let actorIsOrgAdmin = false;
      let orgMemoryWrite: ScopeId | undefined;
      let controlClaims: CapabilityClaims | undefined;
      if (!strictReadOnly && deps.signingSecret && deps.apiBaseUrl) {
        const destination = defaultDestination;
        connectorEnv.AGENT_API_URL = deps.apiBaseUrl;
        if (deps.admin && liveTurn) {
          const status = await deps.admin
            .adminStatusOf(actor)
            .catch(swallowAs("orchestrator: admin status for turn", { isAdmin: false }));
          actorIsOrgAdmin = status.isAdmin;
          if (
            actorIsOrgAdmin &&
            useMemory &&
            memoryPolicy.capture !== "off" &&
            resolution.orgScopeId !== memoryScopeId
          ) {
            orgMemoryWrite = resolution.orgScopeId;
          }
        }
        const memoryClaim = memoryAccess
          ? { ...memoryAccess, ...(orgMemoryWrite ? { orgWrite: orgMemoryWrite } : {}) }
          : undefined;
        controlClaims = {
          actorId: actor.id,
          scopeId,
          ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
          aud: CONTROL_PLANE_AUD,
          exp: Date.now() + CAPABILITY_TTL_MS,
          ...(turnTimezone ? { timezone: turnTimezone } : {}),
          ...(destination ? { destination } : {}),
          ...(delivery.candidates.length > 0 ? { destinations: delivery.candidates } : {}),
          ...(delivery.defaultKey ? { defaultDestinationKey: delivery.defaultKey } : {}),
          ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
          ...(conversation.kind !== "dm"
            ? { keychainMembers: conversation.audience.filter((p) => p.type === "internal") }
            : {}),
          ...(conversation.kind === "dm" ||
          conversation.kind === "group" ||
          conversation.isPrivate === true ||
          conversation.isMpim === true
            ? { privateScope: true }
            : {}),
          ...(memoryClaim ? { memory: memoryClaim } : {}),
          ...(liveTurn ? { liveActor: true } : {}),
          ...(liveAuthorTurn ? { liveAuthor: true } : {}),
          ...(automatedTurn ? { triggered: true } : {}),
          ...(!liveTurn && input.unattendedGrants ? { grants: input.unattendedGrants } : {}),
          threadRef: conversation.threadRef,
        };
        connectorEnv.AGENT_API_TOKEN = await mintCapabilityToken(
          controlClaims,
          deps.capabilitySecret ?? deps.signingSecret,
        );
        connectorEnv.AGENT_OAUTH_CONSENT_TOKEN = await mintCapabilityToken(
          {
            actorId: actor.id,
            scopeId,
            ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
            aud: OAUTH_CONSENT_AUD,
            exp: Date.now() + CAPABILITY_TTL_MS,
          },
          deps.capabilitySecret ?? deps.signingSecret,
        );
        if (deps.serviceCreds) {
          const records = await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId);
          const enabled = new Set(
            records.filter((r) => r.enabled && r.hasSecret && r.delivery !== "env").map((r) => r.slug),
          );
          if (enabled.size > 0) {
            const grants = await deps.acl.grantsOfKind(
              "service-cred",
              conversation.audience,
              scopeId,
              resolution.orgScopeId,
              principalEntitledToScope,
            );
            const slugs = [...new Set(grants.map((g) => parseRef(g.ref).id))].filter((s) => enabled.has(s));
            if (slugs.length > 0) {
              connectorEnv.AGENT_CREDENTIAL_TOKEN = await mintCapabilityToken(
                {
                  actorId: actor.id,
                  scopeId,
                  ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
                  aud: CREDENTIAL_BROKER_AUD,
                  credentials: slugs,
                  exp: Date.now() + CAPABILITY_TTL_MS,
                },
                deps.capabilitySecret ?? deps.signingSecret,
              );
              const usable = records.filter((r) => slugs.includes(r.slug));
              const lines = usable.map((r) => {
                const methods = r.allowedMethods?.length ? r.allowedMethods.join("/") : "GET";
                const paths = r.allowedPathPrefixes?.length ? `paths ${r.allowedPathPrefixes.join(", ")}` : "any path";
                return `- \`${r.slug}\` → ${r.host} (${methods}; ${paths})`;
              });
              sharedCredsBlock =
                "\n\n## Shared org credentials available to you\n" +
                "The org vended these shared credentials to this conversation. You CANNOT see the secret — call the " +
                "target BY PROXY through the broker, which injects it server-side. Use exactly this (with the " +
                "$AGENT_CREDENTIAL_TOKEN env var, NOT $AGENT_API_TOKEN):\n" +
                "```\n" +
                'curl -fsS -X POST "$AGENT_API_URL/v1/credentials/broker" \\\n' +
                '  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \\\n' +
                '  -H "content-type: application/json" \\\n' +
                '  -d \'{"credential":"<slug>","method":"GET","url":"https://<host>/<path>?<query>"}\'\n' +
                "```\n" +
                'The reply is `{"status":<upstream status>,"contentType":…,"body":"<upstream text>"}` — parse `body`. ' +
                "For Git smart HTTP clone/fetch/push, use core as the Git remote so the token stays server-side: " +
                "`$AGENT_API_URL/v1/credentials/git/<slug>/<repo-path>.git`, with " +
                '`git -c http.extraHeader="x-agent-capability: $AGENT_CREDENTIAL_TOKEN" ...`. ' +
                "A non-2xx `status` is the UPSTREAM service's own answer (e.g. a bad query or its auth), not a broker " +
                "error. Use ONLY these (slug → host; allowed methods; allowed paths):\n" +
                lines.join("\n");
            }
          }
        }
      }
      const egressSecret = deps.capabilitySecret ?? deps.signingSecret;
      if (!strictReadOnly && egressSecret) {
        egressTokenForTurn = await mintCapabilityToken(
          {
            actorId: actor.id,
            scopeId,
            aud: EGRESS_PROXY_AUD,
            egress: egressClaimAllowingControlPlane(
              resolution.egress,
              deps.apiBaseUrl ?? "",
              securityPolicy.inboundScreening === "external",
            ),
            exp: Date.now() + CAPABILITY_TTL_MS,
          },
          egressSecret,
        );
      }
      if (!strictReadOnly && actor.type === "internal") {
        for (const tool of brokeredTools) {
          const mode = cutoverModeOf(tool.service);
          if (mode !== "legacy") continue;
          const broker = deps.layerBrokerFor?.(tool);
          if (!broker) {
            continue;
          }
          const aws = await broker
            .credsForActor(actor.id)
            .catch(swallowAs(`orchestrator: ${tool.service} broker assume-role`, undefined));
          const awsEnv = aws
            ? {
                AWS_ACCESS_KEY_ID: aws.accessKeyId,
                AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
                AWS_SESSION_TOKEN: aws.sessionToken,
                AWS_REGION: aws.region,
                AWS_DEFAULT_REGION: aws.region,
              }
            : null;
          if (awsEnv) {
            Object.assign(connectorEnv, awsEnv);
            deps.credentialUsage?.record({
              slug: tool.service,
              host: "sts.amazonaws.com",
              status: "legacy_vended",
              scopeLabel: scopeId,
              principalId: actor.id,
            });
          } else {
            deps.credentialUsage?.record({
              slug: tool.service,
              host: "sts.amazonaws.com",
              status: "legacy_unavailable",
              scopeLabel: scopeId,
              principalId: actor.id,
            });
          }
        }
      }
      let toolCalls = 0;
      let execMs = 0;
      let execCount = 0;
      let harnessOnGapWork: ((work: GapWork) => void) | undefined;
      const emitGapWork = (phase: GapPhase, start: number, end: number): void => {
        try {
          harnessOnGapWork?.({ phase, start, end });
        } catch (e) {
          swallow("gap-work emit", e);
        }
      };
      const ephemeralOnlyDenyRules = brokeredTools
        .filter((candidate) => cutoverModeOf(candidate.service) === "ephemeral_only")
        .map((tool) => ({
          pattern: `(^|[\\s;&|()])${tool.binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s;&|()])`,
          decision: "deny" as const,
          reason: `credential-bearing service ${tool.service} must be run with credential_exec`,
        }));
      const commandPolicy = ephemeralOnlyDenyRules.length
        ? { ...resolution.commandPolicy, rules: [...ephemeralOnlyDenyRules, ...resolution.commandPolicy.rules] }
        : resolution.commandPolicy;
      const layerCommandRules = [...(deps.deploymentLayer?.commandRules ?? [])];
      const reachAvailable = !!deps.reachExec && !!deps.directory && conversation.kind === "dm";
      const {
        box,
        scratchBox,
        ownerAuthBox,
        ownerAuthCommand,
        scopedCommand,
        provision,
        provisionScratch,
        provisionOwnerAuth,
        ensureSkillTree,
        provisionForReach,
        reclaimBox,
        provisionPending,
      } = createTurnSandboxes({
        deps,
        input,
        actor,
        session,
        resolution,
        scopeId,
        memoryScopeId,
        transferId,
        turnSessionDir,
        turnFilesDir,
        turnOutboxDir,
        connectorEnv,
        egressTokenForTurn,
        isolateOwnerKeychain,
        ownerAuthAvailable,
        ownerAuthEnv,
        ownerEnvCredentialIds,
        brokeredTools,
        quarantinedServices,
        brokerCutoverServices,
        cutoverModeOf,
        visibleSkills,
        visibleSkillsForTurn,
        skillMaterializer,
        residentAuthConnectors,
        emitGapWork,
        perf,
      });
      const leaseStart = Date.now();
      const attempt = await deps.sessions.acquireLease(session.id, "turn");
      leaseMs += Date.now() - leaseStart;
      const lease = attempt.lease;
      if (!lease) {
        recordSessionBusy({
          site: "turn",
          attempt,
          sessionId: session.id,
          scopeId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.surface ? { surface: input.surface } : {}),
        });
        return { status: "refused", reason: "session busy (another turn is in progress)" };
      }
      let tailOwnsCleanup = false;
      let leaseReleased = false;
      let failureUserPayload: Record<string, unknown> | undefined;
      try {
        await withManagedRosterVersion(async () => {
          await reconcileSessionParticipants(session.id);
          await Promise.all(pendingScreenRequests.splice(0).map(recordScreenRequest));
          return true;
        });
        if (input.approval) {
          const p = await pending.get(input.approval.requestId);
          if (!input.approval.approved) {
            await pending.delete(input.approval.requestId);
            deps.auditLog.record({
              at: Date.now(),
              principalId: actor.id,
              action: "command_approval.deny",
              resource: p?.command ?? input.approval.requestId,
              scopeLabel: scopeId,
              status: "refused",
            });
            return {
              status: "refused",
              sessionId: session.id,
              reason: p?.command ? `approval denied for ${p.command}` : "approval denied",
            };
          } else if (p && p.sessionId === session.id) {
            const scope = input.approval.scope ?? "once";
            if (scope !== "once" && !resolution.approvalGrantModes[scope]) {
              deps.auditLog.record({
                at: Date.now(),
                principalId: actor.id,
                action: `command_approval.${scope}`,
                resource: p.command,
                scopeLabel: scopeId,
                status: "refused",
              });
              return {
                status: "pending_approval",
                sessionId: session.id,
                reason: `the "${scope}" approval option is disabled by an admin here — approve once or deny`,
                pendingApprovals: [
                  {
                    requestId: input.approval.requestId,
                    command: p.command,
                    reason: p.reason ?? "requires approval",
                    blocksInput: p.blocksInput !== false,
                    grantModes: resolution.approvalGrantModes,
                    ...(p.matched ? { matched: p.matched } : {}),
                    ...(p.purpose ? { purpose: p.purpose } : {}),
                    ...(p.summary ? { summary: p.summary } : {}),
                    ...(p.approvalKey ? { approvalKey: p.approvalKey } : {}),
                    ...(p.kind === "approval" ? { kind: p.kind } : {}),
                  },
                ],
              };
            }
            await pending.delete(input.approval.requestId);
            const useKey = p.approvalKey ?? p.command;
            commandUses.set(useKey, (commandUses.get(useKey) ?? 0) + (scope === "once" ? 1 : Infinity));
            if (scope === "session" || scope === "always") {
              const grant: CommandApprovalGrant = {
                actorId: actor.id,
                command: p.command,
                scope,
                createdAt: Date.now(),
                ...(p.approvalKey ? { approvalKey: p.approvalKey } : {}),
                ...(scope === "session" ? { sessionId: session.id } : {}),
              };
              await approvalGrants.put(approvalGrantId(grant), grant);
            }
            deps.auditLog.record({
              at: Date.now(),
              principalId: actor.id,
              action: `command_approval.${scope}`,
              resource: p.command,
              scopeLabel: scopeId,
              status: "ok",
            });
          }
        }

        systemPrompt += sharedCredsBlock;
        if (actorIsOrgAdmin) {
          systemPrompt +=
            "\n\n## Acting for an org admin\n" +
            "This user is an org admin, and your token inherits that for this turn: anything they could do in the admin dashboard — inspect or govern any scope's config/SOUL, memory, transcripts, files, audit — they can do through you. The admin skill documents the whole API surface; read it before acting" +
            (orgMemoryWrite
              ? ', and for plain "remember this org-wide" requests the lighter path is `"scope":"org"` on the memory self-API (memory skill)'
              : "") +
            ". You're acting as them: confirm before any mutation, and say exactly what you changed. Hard limits the API enforces: private-content reads work only from a DM; admin grant changes are portal-only.";
        }
        if (deps.signingSecret && deps.apiBaseUrl && (deps.crons || deps.monitors)) {
          const nowMs = Date.now();
          const obligations = await Promise.all([deps.crons?.list() ?? [], deps.monitors?.enabled() ?? []])
            .then(([crons, mons]) =>
              renderStandingObligations(
                crons.filter(
                  (c) =>
                    c.enabled &&
                    !c.archived &&
                    c.ownerScopeId === scopeId &&
                    (c.schedule.cron != null ||
                      c.schedule.everyMs != null ||
                      (c.schedule.firstFireAt ?? c.createdAt) > nowMs),
                ),
                mons.filter((m) => m.ownerScopeId === scopeId && m.expiresAt > nowMs),
              ),
            )
            .catch(swallowAs("orchestrator: standing-obligations read", null));
          if (obligations) systemPrompt += `\n\n${obligations}`;
        }
        if (input.origin.kind === "automation" && input.origin.destination && !input.surfaceTools) {
          systemPrompt +=
            "\n\nThis turn was fired by a scheduled trigger with a platform-managed destination. " +
            "Core will deliver your final reply after you finish. Do not call Slack, email, chat, or other send APIs to deliver it yourself; put the exact message to send in your final reply.";
        }
        if (automatedTurn && input.surface && isPollSurface(input.surface)) {
          systemPrompt += `\n\nThis turn was fired by a scheduled trigger, not a person typing. If there's nothing new worth reporting, call \`finish_silently\` to end the turn without sending anything — silence is the success case for a poll, so don't post a summary or a "nothing to report" note just to fill the silence.`;
        }
        if (reachAvailable) {
          const roster = renderReachRoster(
            await reachableChannelsFor(deps.directory!, actor.id),
            actor.displayName ?? "this person",
          );
          if (roster) systemPrompt += `\n\n${roster}`;
        }
        if (deps.directory) {
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
              else if (p.displayName)
                resolved.push({ principalId: p.id, displayName: p.displayName, type: "internal" });
            }
            return renderConversationRoster(resolved);
          })().catch(swallowAs("orchestrator: conversation roster", null));
          if (rosterBlock) systemPrompt += `\n\n${rosterBlock}`;
        }
        if (!strictReadOnly && deps.keychain && deps.signingSecret && deps.apiBaseUrl) {
          const audienceMembers = conversation.audience.filter((p) => p.type === "internal");
          const members = [
            ...(audienceMembers.some((p) => samePerson(p.id, actor.id)) ? [] : [actor]),
            ...audienceMembers,
          ].map((p) => ({ id: p.id, ...(p.displayName ? { displayName: p.displayName } : {}) }));
          const detectedByOwner = new Map<string, string[]>();
          if (deps.livenessCache) {
            for (const m of members) {
              const rec = await deps.livenessCache.get(personalScope(m.id)).catch(() => null);
              if (!rec) continue;
              const labels = residentAuthConnectors()
                .filter((c) => rec.connectors[c.id] === "active")
                .map((c) => c.label);
              if (labels.length) detectedByOwner.set(m.id, labels);
            }
          }
          const [entriesByOwner, connectorsByOwner, scopeGrants, scopeAsks, ownerAsks] = await Promise.all([
            deps.keychain.listByOwners(members.map((m) => m.id)),
            deps.keychain.listConnectorsByOwners(members.map((m) => m.id)),
            deps.keychain.grantsForScope(scopeId),
            deps.keychain.listAsks({ requesterScopeId: scopeId }),
            conversation.kind === "dm" ? deps.keychain.listAsks({ ownerId: actor.id }) : Promise.resolve([]),
          ]);
          const keychainBlock = renderKeychainManifest({
            scopeId,
            conversationKind: conversation.kind,
            actorId: actor.id,
            members,
            entriesByOwner,
            connectorsByOwner,
            scopeGrants,
            injected: keychainInjected,
            detectedByOwner,
            scopeAsks,
            ownerAsks,
          });
          if (keychainBlock) systemPrompt += `\n\n${keychainBlock}`;
        }
        if (!strictReadOnly && deps.livenessCache) {
          const liveness = await deps.livenessCache
            .get(memoryScopeId)
            .catch(swallowAs("orchestrator: liveness cache read", null));
          const loginsBlock = renderResidentLoginsBlock(liveness, residentAuthConnectors());
          if (loginsBlock) {
            systemPrompt += `\n\n${loginsBlock}`;
            if (deps.scratchExec) {
              systemPrompt +=
                '\nThese logins live on your scoped computer — `execute` reaches them only with scope:"scoped"; a scratch run has none of them.';
            }
          }
        }
        if (!strictReadOnly && deps.resolveConnectorClient && conversation.kind === "dm") {
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
          const connectionsUrl = deps.publicWebUrl ? `${deps.publicWebUrl.replace(/\/$/, "")}/keychain` : undefined;
          systemPrompt += `\n\n${renderConnectedAppsBlock(status, configuredProviders, connectionsUrl)}`;
        }
        systemPrompt += memoryBlock;
        if (onboardingBlock) systemPrompt += `\n\n${onboardingBlock}`;

        const isRetry = (input.attempt ?? 1) > 1;
        if (
          ambientTurn &&
          deps.harness.models.shouldRespond &&
          !(isRetry && findTrailingPartialTurn(await deps.sessions.getEntries(session.id), input.text))
        ) {
          const detectHistory = filterHistory(
            (await deps.sessions.getEntries(session.id)).filter((e) => e.type !== "soul"),
          );
          const detectStart = Date.now();
          const decision = await deps.harness.models.shouldRespond({
            session,
            message: input.text,
            recentContext: input.detectContext ?? "",
            ...(input.detectOpener ? { threadOpener: input.detectOpener } : {}),
            systemPrompt: resolution.systemPrompt,
            ...(input.gatewayContext?.reactionGuidance
              ? { reactionGuidance: input.gatewayContext.reactionGuidance }
              : {}),
            history: detectHistory,
            recordModelCall: (rec) => {
              deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
              void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
            },
          });
          detectMs = Date.now() - detectStart;
          if (!decision.respond) {
            const reactions = decision.reactions?.length ? decision.reactions : undefined;
            deps.auditLog.record({
              at: Date.now(),
              principalId: actor.id,
              action: reactions ? "turn.react" : "turn.silent",
              resource: conversation.threadRef,
              scopeLabel: scopeId,
              ...(decision.reason ? { detail: decision.reason } : {}),
            });
            console.error(
              `[orchestrator] turn.${reactions ? "react" : "silent"} (detection ${reactions ? `acknowledged emoji=${reactions.join(",")}` : "declined"}) thread=${conversation.threadRef}` +
                (decision.reason ? ` reason=${JSON.stringify(decision.reason)}` : ""),
            );
            return reactions
              ? { status: "react", sessionId: session.id, reactions }
              : { status: "silent", sessionId: session.id };
          }
        }

        if (input.runId) deps.turnStream?.begin(input.runId);

        const backgroundBroker =
          deps.processes && supportsProcessSessions(deps.sandbox)
            ? createBackgroundBroker({
                sandbox: deps.sandbox,
                registry: deps.processes,
                scopeId: memoryScopeId,
                sessionRef: conversation.threadRef,
                ...(deps.backgroundJobTtlMs !== undefined ? { ttlMs: deps.backgroundJobTtlMs } : {}),
                ...(deps.backgroundJobTtlMaxMs !== undefined ? { ttlMaxMs: deps.backgroundJobTtlMaxMs } : {}),
              })
            : undefined;

        const readOutputTail = backgroundBroker
          ? async (processId: string, maxBytes: number) => {
              const handle = await provision();
              return readBackgroundOutputTail(maxBytes, async (cursor, readMaxBytes) => {
                const read = await backgroundBroker.poll(handle, processId, {
                  sinceCursor: cursor,
                  maxBytes: readMaxBytes,
                  waitMs: 0,
                });
                return {
                  chunks: read.chunks,
                  cursor: read.cursor,
                  ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
                };
              });
            }
          : undefined;

        const monitorBroker =
          deps.monitors && deps.processes && supportsProcessSessions(deps.sandbox)
            ? createMonitorBroker({
                store: deps.monitors,
                registry: deps.processes,
                readOutputTail: readOutputTail ?? (async () => ({ outputTail: "" })),
                scopeId: memoryScopeId,
                owner: actor.id,
                ownerScopeId: scopeId,
                threadRef: conversation.threadRef,
                ...(defaultDestination ? { destination: defaultDestination } : {}),
              })
            : undefined;

        const snapshotExcludeDirs = [
          ...resolution.layers.filter((l) => l.mode === "ro" && l.mountPath).map((l) => l.mountPath),
          TURN_FILES_DIR,
          SKILLS_DIR,
        ];

        const spine: SpineState = {
          surfaceOutboundCount: 0,
          crossConversationPosts: 0,
          staySilentReason: undefined,
          turnUserEntrySeq: undefined,
        };
        let spineFirstBlock = "";
        let spineFirstBlockOpen = true;
        let spineAckText: string | undefined;
        const fileAudience = resolution.orgScopeId
          ? defaultPublishAudience({
              kind: conversation.kind,
              ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
              ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
              ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
              orgScopeId: resolution.orgScopeId,
              ownerId: actor.id,
            }).grantees
          : [];
        // Files posted into a group/DM conversation (e.g. a project web session) get no
        // per-member grants from defaultPublishAudience ("auto-share deferred"), which left
        // other members unable to load them. Grant the conversation scope itself read access
        // so everyone party to the conversation can fetch what was posted into it.
        const fileOwnerScopeId = toScopeId("personal", actor.id);
        const fileGrantees = [...fileAudience];
        if ((conversation.kind === "group" || conversation.kind === "dm") && scopeId !== fileOwnerScopeId) {
          fileGrantees.push(scopeId);
        }
        const fileRegistration: ArtifactRegistration = {
          store: deps.files,
          ownerScopeId: fileOwnerScopeId,
          createdBy: actor.id,
          createdInScope: scopeId,
          seed: input.runId ?? `${session.id}:${Date.now()}`,
          ...(fileGrantees.length
            ? {
                onRegistered: async ({ ownerScopeId, path }) => {
                  for (const granteeScopeId of fileGrantees) {
                    await deps.acl.grant({
                      ownerScopeId,
                      ref: path,
                      granteeScopeId,
                      permission: "read",
                      grantedBy: actor.id,
                    });
                  }
                },
              }
            : {}),
          onError: (e) =>
            deps.errors?.record({
              category: "file_store",
              code: "register_failed",
              message: errMessage(e),
              scopeLabel: scopeId,
              sessionId: session.id,
            }),
        };
        const postProvenance = (deliveryKey: string): DeliveryProvenance => ({
          trigger: automatedTurn ? (input.surface ?? "wake") : "conversation",
          surface: input.surface ?? "unknown",
          fireKey: deliveryKey,
          sourceScopeId: scopeId,
          sourceThreadRef: session.threadRef,
          sourceSessionId: session.id,
        });
        const surfaceToolDeps = createSurfaceToolDeps({
          deps,
          input,
          actor,
          conversation,
          session,
          scopeId,
          strictReadOnly,
          defaultDestination,
          blobTransfer,
          fileRegistration,
          provision,
          postProvenance,
          spine,
        });
        if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination && !surfaceToolDeps)
          console.error(
            `[orchestrator] trigger delivery has no surface tools (missing deliveries store?) — reply would be lost session=${session.id}`,
          );

        const tools = createToolContext({
          sandbox: deps.sandbox,
          provision,
          provisionScratch,
          ...(provisionOwnerAuth ? { provisionOwnerAuth } : {}),
          ...(ownerAuthCommand ? { ownerAuthCommand } : {}),
          ...(scopedCommand ? { scopedCommand } : {}),
          ensureSkillTree,
          ...(reachAvailable
            ? {
                reach: {
                  resolveChannel: (q: string) =>
                    resolveReachableChannel(q, { directory: deps.directory!, actorId: actor.id }),
                  provisionFor: provisionForReach,
                },
              }
            : {}),
          layers: resolution.layers,
          commandPolicy: () => commandPolicy,
          layerCommandRules: () => layerCommandRules,
          authorizeCommand,
          grantedHandles: resolution.grantedHandles,
          sharedMaterializeDir: turnSharedDir,
          workspace: deps.workspace,
          deploy: deps.deploy,
          acl: deps.acl,
          files: deps.files,
          auditLog: deps.auditLog,
          createdBy: actor.id,
          ...(() => {
            const available =
              strictReadOnly || actor.type !== "internal"
                ? []
                : brokeredTools.filter(
                    (tool) => cutoverModeOf(tool.service) !== "legacy" && deps.layerBrokerFor?.(tool),
                  );
            if (!available.length) return {};
            return {
              credentialExecServices: available.map(({ service, binary }) => ({ service, binary })),
              credentialExec: async (
                service: string,
                args: string[],
                opts?: { timeoutSeconds?: number; signal?: AbortSignal },
              ) => {
                const tool = available.find((candidate) => candidate.service === service);
                if (!tool || cutoverModeOf(service) === "legacy") {
                  throw new Error(`credential_exec service is unavailable: ${service}`);
                }
                const broker = deps.layerBrokerFor?.(tool);
                if (!broker) throw new Error(`credential_exec broker is unavailable: ${service}`);
                const composed = [shq(tool.binary), ...args.map(shq)].join(" ");
                const gate = evaluateCommandWithLayer(
                  composed,
                  resolution.commandPolicy,
                  deps.deploymentLayer?.commandRules ?? [],
                );
                if (gate.decision === "deny") throw new CommandDenied(composed, gate.reason ?? "denied by policy");
                if (gate.decision === "require_approval" && !authorizeCommand(composed, gate.approvalKey)) {
                  throw new NeedsApproval(
                    composed,
                    gate.reason ?? "requires approval",
                    "approval",
                    gate.matched,
                    gate.approvalKey,
                  );
                }
                let aws;
                try {
                  aws = await broker.credsForActor(actor.id);
                } catch {
                  deps.credentialUsage?.record({
                    slug: service,
                    host: "sts.amazonaws.com",
                    status: cutoverModeOf(service) === "ephemeral_only" ? "ephemeral_failed_closed" : "legacy_fallback",
                    scopeLabel: scopeId,
                    principalId: actor.id,
                  });
                  throw new Error(`credential_exec could not vend credentials for ${service}`);
                }
                const awsEnv = {
                  AWS_ACCESS_KEY_ID: aws.accessKeyId,
                  AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
                  AWS_SESSION_TOKEN: aws.sessionToken,
                  AWS_REGION: aws.region,
                  AWS_DEFAULT_REGION: aws.region,
                };
                const mask = createSecretValueMasker(awsEnv);
                let handle;
                let result: Awaited<ReturnType<typeof deps.sandbox.run>> | undefined;
                let runError: unknown;
                let cleanupError: unknown;
                try {
                  handle = await deps.sandbox.provision(
                    resolution.layers.filter((layer) => layer.mode === "ro" && layer.mountPath === "global"),
                    {
                      env: awsEnv,
                      egress: resolution.egress,
                      ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
                      scratch: { key: `credential-exec:${session.id}:${randomUUID()}` },
                      routeScopeId: memoryScopeId,
                    },
                  );
                  deps.credentialUsage?.record({
                    slug: service,
                    host: "sts.amazonaws.com",
                    status: "ephemeral_vended",
                    scopeLabel: scopeId,
                    principalId: actor.id,
                  });
                  deps.auditLog.record({
                    at: Date.now(),
                    principalId: actor.id,
                    action: "credential.materialize",
                    resource: `${service} (ephemeral broker)`,
                    scopeLabel: scopeId,
                  });
                  const requestedMs = opts?.timeoutSeconds == null ? deps.execTimeoutMs : opts.timeoutSeconds * 1000;
                  const timeoutMs =
                    requestedMs != null && deps.execTimeoutCeilingMs != null
                      ? Math.min(requestedMs, deps.execTimeoutCeilingMs)
                      : requestedMs;
                  result = await deps.sandbox.run(
                    handle,
                    composed,
                    timeoutMs !== undefined || opts?.signal
                      ? {
                          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                          ...(opts?.signal ? { signal: opts.signal } : {}),
                        }
                      : undefined,
                  );
                } catch (error) {
                  runError = error;
                } finally {
                  if (handle) {
                    let lastError: unknown;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                      try {
                        await deps.sandbox.teardown(handle, { destroy: true });
                        lastError = undefined;
                        break;
                      } catch (error) {
                        lastError = error;
                        if (attempt < 3) await sleep(50 * attempt);
                      }
                    }
                    cleanupError = lastError;
                  }
                }
                if (cleanupError) throw new Error(`credential_exec cleanup failed for ${service}`);
                if (runError || !result) throw new Error(`credential_exec failed while running ${service}`);
                return { ...result, stdout: mask(result.stdout), stderr: mask(result.stderr) };
              },
            };
          })(),
          ...(deps.publicWebUrl ? { publicWebUrl: deps.publicWebUrl } : {}),
          publishContext: {
            conversationKind: conversation.kind,
            ...(conversation.channelRef ? { channelRef: conversation.channelRef } : {}),
            ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
            ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
            ...(conversation.publishMembers ? { publishMembers: conversation.publishMembers } : {}),
          },
          ...(deps.config ? { config: deps.config } : {}),
          ...(deps.control && controlClaims ? { control: deps.control, controlClaims } : {}),
          ...(surfaceToolDeps ? { surface: surfaceToolDeps } : {}),
          memory: deps.memory,
          memoryScopeId,
          ...(memoryAccess ? { memoryAccess } : {}),
          ...(deps.mcp ? { mcp: deps.mcp } : {}),
          sessionHistory: {
            search: async (q: string, limit?: number) =>
              searchSessionEntries(
                filterHistory(
                  forModelContext(await deps.sessions.getEntries(session.id), { includeSecurityTainted: false }),
                ),
                q,
                limit,
              ),
          },
          ...(input.surface === "slack" ? { actingSlackUserId: actor.id } : {}),
          ...(deps.deploymentLayer
            ? {
                layerAuth: {
                  credentialPaths: deps.deploymentLayer.credentialPaths,
                  splitEnvTemplates: deps.deploymentLayer.splitEnvTemplates,
                },
              }
            : {}),
          ...(deps.execTimeoutMs !== undefined ? { execTimeoutMs: deps.execTimeoutMs } : {}),
          ...(deps.execTimeoutCeilingMs !== undefined ? { execTimeoutCeilingMs: deps.execTimeoutCeilingMs } : {}),
          ...(deps.ledger ? { ledger: deps.ledger } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          attempt: input.attempt ?? 1,
          ...(backgroundBroker ? { backgroundBroker } : {}),
          ...(monitorBroker ? { monitorBroker } : {}),
          ...(scopeProfile.writablePersistence === "resident_disk"
            ? { persistWritesToStore: { excludeDirs: snapshotExcludeDirs } }
            : {}),
          onGapWork: (work) => {
            if (work.phase === "exec") {
              execMs += Math.max(0, work.end - work.start);
              execCount += 1;
            }
            try {
              harnessOnGapWork?.(work);
            } catch (e) {
              swallow("gap-work forward", e);
            }
          },
        });

        const inbound =
          input.attachments?.length && !strictReadOnly
            ? await materializeInbound(
                deps.sandbox,
                await provision(),
                input.attachments,
                blobTransfer,
                fileRegistration,
                turnInboxDir,
                securityPolicy.inboundScreening === "external" &&
                  (deps.securityScreener || deps.harness.models.screenSecurity)
                  ? ({ content }) =>
                      classifySecurityData(content, actor.id, scopeId, undefined, {
                        hook: "tool_response",
                        surface: "inbound_file",
                        origin: input.origin.kind,
                      })
                  : undefined,
              )
            : { metas: [], images: [], tooMany: [], unavailable: [], blocked: [], unscreened: [] };
        const manifest = inboundManifest(inbound.metas, turnInboxDir);
        const inboundIssues = inboundIssueList({
          tooMany: inbound.tooMany,
          unavailable: inbound.unavailable,
          blocked: inbound.blocked,
          surfaceNotes: [
            ...(input.inboundNotes ?? []),
            ...(strictReadOnly
              ? (input.attachments ?? []).map(
                  (attachment) => `${safeAttachmentName(attachment.name)} — unavailable in Strict posture`,
                )
              : []),
          ],
        });
        const preAppendedSeqs: number[] = [];
        let preAppendMirrorsOk = true;
        if (inboundIssues.length) {
          try {
            const appended = await withManagedRosterVersion(() =>
              deps.sessions.append(lease, {
                type: "system",
                payload: fileEventPayload("in", inboundIssues),
                scopeLabel: scopeId,
              }),
            );
            preAppendedSeqs.push(appended.seq);
          } catch (err) {
            swallow("orchestrator: inbound file-event log", err);
          }
        }

        const importedOverheard: OverheardEntryPayload[] = [];
        if (!input.envelopeWrapped && input.overheard?.length) {
          try {
            const already = recordedMessageTimestamps(await deps.sessions.getEntries(session.id));
            for (const p of selectOverheardToImport(input.overheard, already)) {
              const imported = await withManagedRosterVersion(() =>
                deps.sessions.append(lease, {
                  type: "user",
                  payload: p,
                  scopeLabel: scopeId,
                }),
              );
              importedOverheard.push(p);
              preAppendedSeqs.push(imported.seq);
              await withManagedRosterVersion(() =>
                deps.sessions.appendTape(lease, {
                  kind: "message",
                  payload: {
                    role: "user",
                    content: [{ type: "text", text: renderOverheard(p) }],
                    timestamp: imported.createdAt,
                  },
                  scopeLabel: scopeId,
                  entrySeq: imported.seq,
                  meta: {
                    overheard: true,
                    ts: p.ts,
                    ...(p.changeTime ? { changeTime: p.changeTime } : {}),
                    ...(p.name ? { author: p.name } : {}),
                  },
                }),
              ).catch((e) => {
                preAppendMirrorsOk = false;
                swallow("tape: overheard import", e);
              });
            }
          } catch (err) {
            swallow("orchestrator: overheard catch-up import", err);
          }
        }

        const rawEntries = await deps.sessions.getEntries(session.id);
        const historyHasSecurityTaint = rawEntries.some(
          (entry) => (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true,
        );
        const priorTurns = historyHasSecurityTaint ? undefined : input.priorTurns;
        if (historyHasSecurityTaint) {
          await deps.harness.turns.resetSession?.(session.id);
        }
        const visibleHistory = filterHistory(forModelContext(rawEntries, { includeSecurityTainted: false }));
        const maxEntrySeq = rawEntries.length ? rawEntries[rawEntries.length - 1]!.seq : -1;
        const rehydrateTape = (messages: readonly unknown[]) => {
          let readableHandles: Awaited<ReturnType<typeof deps.acl.handlesForAudience>> | undefined;
          const mayReadArtifact = async (artifact: FileArtifact): Promise<boolean> => {
            if (
              conversation.audience.every((principal) =>
                principalEntitledToScope(principal, artifact.ownerScopeId, scopeId, resolution.orgScopeId),
              )
            )
              return true;
            readableHandles ??= await deps.acl.handlesForAudience(
              conversation.audience,
              scopeId,
              resolution.orgScopeId,
              principalEntitledToScope,
            );
            return readableHandles.some(
              (handle) => handle.ownerScopeId === artifact.ownerScopeId && handle.ownerPath === artifact.path,
            );
          };
          return rehydrateFoldImages(
            messages,
            async (artifactRef, remainingBytes) => {
              try {
                return await loadTapeImage(deps.files, artifactRef, remainingBytes, mayReadArtifact);
              } catch (e) {
                swallow("tape: image rehydrate", e);
                return null;
              }
            },
            MAX_HISTORY_IMAGE_BYTES,
          );
        };
        const tapeRows = await (async () => {
          if (historyHasSecurityTaint || rawEntries.length > 500) return undefined;
          try {
            const preAppended = new Set(preAppendedSeqs);
            const priorMaxSeq = rawEntries.reduce((m, e) => (preAppended.has(e.seq) ? m : Math.max(m, e.seq)), -1);
            let covered =
              preAppendMirrorsOk && (priorMaxSeq < 0 || (await deps.sessions.tapeCoverage(session.id)) >= priorMaxSeq);
            let rows = filterTapeForAudience(
              await deps.sessions.getTape(session.id),
              conversation.audience,
              scopeId,
              resolution.orgScopeId,
            );
            const sameHarness = rows.every(
              (row) => row.kind !== "message" || row.harness === undefined || row.harness === "pi",
            );
            if (
              (!covered || lastImportLacksScopes(rows)) &&
              deps.sessionTapeMode === "serve" &&
              sameHarness &&
              participantHistorySeqs === undefined
            ) {
              const importEvent = coverageImportEvent(rawEntries);
              if (importEvent.messages.length) {
                const imported = await deps.sessions.appendTape(lease, {
                  kind: "context_event",
                  payload: importEvent,
                  scopeLabel: scopeId,
                  coversEntrySeq: maxEntrySeq,
                });
                console.log(
                  `[tape-heal] session=${session.id} covers=${maxEntrySeq} messages=${importEvent.messages.length}`,
                );
                rows = [...rows, imported];
                covered = true;
              }
            }
            const eventsEntitled = tapeEventsEntitled(rows, conversation.audience, scopeId, resolution.orgScopeId);
            const eligible =
              deps.sessionTapeMode === "serve" &&
              covered &&
              sameHarness &&
              eventsEntitled &&
              participantHistorySeqs === undefined;
            let fold = eligible ? await rehydrateTape(foldTape(rows)) : undefined;
            if (eligible && rows.length && fold && tapeNeedsInterruptHeal(rows, fold)) {
              const interrupt = await deps.sessions.appendTape(lease, {
                kind: "context_event",
                payload: { event: "interrupt" },
                scopeLabel: scopeId,
              });
              rows = [...rows, interrupt];
              fold = healFoldInterrupt(fold, interrupt.createdAt);
            }
            const serve = eligible && !!fold?.length && lintFold(fold).ok;
            return { rows, serve, covered, fold };
          } catch (e) {
            swallow("tape: read/heal", e);
            return undefined;
          }
        })();
        const delivered = recentDeliveryNote(visibleHistory);
        const principalDelivered = await recentPrincipalDeliveryNote(deps.deliveries, session.threadRef);
        const sender = !automatedTurn && input.text.trim() ? senderNote(actor.displayName) : "";
        const unscreenedNote = inputUnscreened || inbound.unscreened.length ? unscreenedNotice("inbound content") : "";
        const turnEnv = environmentNote(
          [manifest, delivered, principalDelivered, sender, unscreenedNote, input.conversationHeader?.trim()]
            .filter((s) => s && s.trim())
            .join("\n\n"),
        );
        const baseText = input.proactiveOpener && !input.text.trim() ? PROACTIVE_OPENER_PROMPT : input.text;
        const pausedTurnUserEntry = input.approval
          ? [...visibleHistory].reverse().find((e) => e.type === "user" && !isOverheardEntry(e))
          : undefined;
        const resumedFromSeq = pausedTurnUserEntry?.seq;
        const approvalReplay =
          !!pausedTurnUserEntry &&
          String((pausedTurnUserEntry.payload as { text?: string } | null)?.text ?? "").trim() === input.text.trim();
        const partial = isRetry ? findTrailingPartialTurn(visibleHistory, input.text) : null;
        const resume = partial && partial.workEntries > 0 ? partial : null;
        if (partial) {
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor.id,
            action: "turn.resume",
            resource: conversation.threadRef,
            scopeLabel: scopeId,
            detail: resume
              ? `attempt ${input.attempt}; resuming partial turn at seq ${partial.userSeq} (${partial.workEntries} recorded entries)`
              : `attempt ${input.attempt}; re-running turn at seq ${partial.userSeq} (no recorded work to resume)`,
          });
          console.error(
            `[orchestrator] turn.resume attempt=${input.attempt} thread=${conversation.threadRef} userSeq=${partial.userSeq} workEntries=${partial.workEntries}`,
          );
        }
        const turnInput = partial
          ? resumeNote({ backgroundJobs: !!backgroundBroker, workRecorded: !!resume })
          : baseText;
        const turnEnvironment = turnEnv;
        const isPollFire = automatedTurn && !!input.surface && isPollSurface(input.surface);
        const sessionUsedTools = visibleHistory.some((e) => e.type === "tool_call");
        if (!strictReadOnly && deps.eagerProvision && sessionUsedTools && !isPollFire) {
          void provision(true).catch(swallowAs("orchestrator: eager provision", undefined));
        }
        const compactStart = Date.now();
        const { history, compactionMirrorFailed } = await compactContextIfNeeded({
          session,
          lease,
          visibleHistory,
          scopeId,
          orgScopeId: resolution.orgScopeId,
          actorId: actor.id,
          ...(input.model ? { model: input.model } : {}),
        });
        compactMs = Date.now() - compactStart;
        const turnStart = Date.now();
        let firstChunkAt: number | undefined;
        let lastChunkAt: number | undefined;
        const emittedEntries: SessionEntry[] = [];
        const syntheticPrompt =
          (input.proactiveOpener && !input.text.trim()) || automatedTurn || partial || approvalReplay;
        failureUserPayload =
          !syntheticPrompt && input.text.trim()
            ? {
                text: input.text,
                ...((messageTs ?? entryTs) ? { ts: messageTs ?? entryTs } : {}),
                ...(actor.displayName?.trim() ? { name: actor.displayName.trim() } : {}),
                ...(input.displayText?.trim() ? { display: input.displayText } : {}),
              }
            : undefined;
        const earlyTitleGen: Promise<string | undefined> | undefined =
          humanTurn && !session.title && !syntheticPrompt && input.text.trim()
            ? generateAndStoreTitle(session.id, scopeId, `User:\n${stripTurnBoilerplate(input.text)}`)
            : undefined;
        const requestedTurnWallClockMs =
          typeof input.turnWallClockMs === "number" && input.turnWallClockMs > 0 ? input.turnWallClockMs : undefined;
        const configuredTurnWallClockSec = await deps.config?.getTurnWallClockSecDurable(resolution.orgScopeId);
        const configuredTurnWallClockMs =
          configuredTurnWallClockSec === null || configuredTurnWallClockSec === undefined
            ? undefined
            : configuredTurnWallClockSec * 1000;
        let effectiveTurnWallClockMs = configuredTurnWallClockMs;
        if (requestedTurnWallClockMs !== undefined) {
          effectiveTurnWallClockMs =
            configuredTurnWallClockMs !== undefined && configuredTurnWallClockMs > 0
              ? Math.min(requestedTurnWallClockMs, configuredTurnWallClockMs)
              : requestedTurnWallClockMs;
        }
        const wantsOrgFastMode =
          typeof input.fastMode !== "boolean" && humanTurn && (await deps.config?.getInteractiveFastModeDurable());
        const effectiveFastMode = resolveTurnFastMode(input.fastMode, humanTurn, wantsOrgFastMode === true);
        const runHarnessTurn = (
          harnessInput: string,
          extras: {
            environment?: string;
            priorTurns?: typeof input.priorTurns;
            overheard?: typeof importedOverheard;
            attachments?: typeof inbound.metas;
            images?: typeof inbound.images;
          },
          continuation?: {
            history: SessionEntry[];
            tape?: { rows: Awaited<ReturnType<SessionStore["getTape"]>>; mode: "shadow" | "serve"; fold?: unknown[] };
          },
        ) => {
          let selectedTape = continuation?.tape;
          if (!continuation && tapeRows) {
            selectedTape = {
              rows: tapeRows.rows,
              mode: tapeRows.serve && history === visibleHistory ? "serve" : "shadow",
              ...(tapeRows.fold ? { fold: tapeRows.fold } : {}),
            };
          }
          return deps.harness.turns.runTurn({
            session,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.cancel ? { cancel: input.cancel } : {}),
            input: harnessInput,
            ...(!partial && messageTs ? { triggerTs: messageTs } : {}),
            ...(!partial && entryTs ? { entryTs } : {}),
            ...(extras.environment ? { environment: extras.environment } : {}),
            ...(extras.priorTurns?.length ? { priorTurns: extras.priorTurns } : {}),
            ...(extras.overheard?.length ? { overheard: extras.overheard } : {}),
            ...(extras.attachments?.length ? { attachments: extras.attachments } : {}),
            ...(extras.images?.length ? { images: extras.images } : {}),
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
            ...(typeof effectiveFastMode === "boolean" ? { fastMode: effectiveFastMode } : {}),
            ...(strictReadOnly ? { readOnly: true } : {}),
            ...(input.surfaceTools && surfaceToolDeps
              ? {
                  surfaceTools: true,
                  surfaceName:
                    input.origin.kind === "automation" && input.origin.destination
                      ? "slack"
                      : (input.surface ?? "slack"),
                }
              : {}),
            ...(isPollFire ? { pollFire: true } : {}),
            ...(effectiveTurnWallClockMs !== undefined ? { turnWallClockMs: effectiveTurnWallClockMs } : {}),
            ...(securityPolicy.inboundScreening === "external"
              ? {
                  screenToolResult: async (
                    tool: string,
                    result: string,
                    unscreenable: boolean,
                  ): Promise<boolean | "unscreened"> => {
                    const toolLabel = tool.replace(/[^A-Za-z0-9_-]/g, "_");
                    const bounded = unscreenable
                      ? null
                      : securityScreenPayload({
                          surface: `tool_result:${toolLabel}`,
                          text: "",
                          triggered: true,
                          securityScreenData: result,
                        });
                    if (!unscreenable && bounded === null) return true;
                    const verdict =
                      bounded && !bounded.truncated
                        ? await classifySecurityData(bounded.content, actor.id, scopeId, recordScreenRequest, {
                            hook: "tool_response",
                            surface: toolLabel,
                            origin: input.origin.kind,
                          })
                        : undefined;
                    if (verdict?.decision === "auto" && !verdict.unscreened) return true;
                    if (verdict?.decision === "strict") {
                      deps.auditLog.record({
                        at: Date.now(),
                        principalId: actor.id,
                        action: "security_posture.tool_result_quarantine",
                        resource: input.surface ?? "unknown",
                        scopeLabel: scopeId,
                        status: "refused",
                        detail: JSON.stringify({ reason: "screen_verdict", tool: toolLabel }),
                      });
                      return false;
                    }
                    deps.auditLog.record({
                      at: Date.now(),
                      principalId: actor.id,
                      action: "security_posture.tool_result_failed_open",
                      resource: input.surface ?? "unknown",
                      scopeLabel: scopeId,
                      status: "allowed",
                      detail: JSON.stringify({
                        reason: unscreenable || bounded?.truncated ? "unscreenable_payload" : UNSCREENED_REASON,
                      }),
                    });
                    return "unscreened";
                  },
                }
              : {}),
            ...(securityPolicy.toolApprovals === "all" ? { toolApprovalGate: authorizeToolCall } : {}),
            systemPrompt,
            systemCacheBoundary: stableSystemBytes,
            history: continuation?.history ?? history,
            tools,
            ...(tools.credentialExecServices ? { credentialExecServices: tools.credentialExecServices } : {}),
            ...(securityPolicy.inboundScreening === "external" &&
            (deps.securityScreener || deps.harness.models.screenSecurity)
              ? {
                  screenExternalContent: ({ content, tool }: { content: string; tool: string; source: string }) =>
                    classifySecurityData(content, actor.id, scopeId, undefined, {
                      hook: "tool_response",
                      surface: tool,
                      origin: input.origin.kind,
                    }),
                }
              : {}),
            ...(selectedTape
              ? {
                  tapeRows: selectedTape.rows,
                  tapeMode: selectedTape.mode,
                  ...(selectedTape.fold ? { tapeFold: selectedTape.fold } : {}),
                }
              : {}),
            tape: (rec) => {
              if (rec.kind !== "message" || rec.meta?.bareText === undefined) {
                return withManagedRosterVersion(() => deps.sessions.appendTape(lease, rec));
              }
              const meta = {
                ...rec.meta,
                ...(actor.displayName?.trim() ? { author: actor.displayName.trim() } : {}),
                ...(syntheticPrompt ? { hidden: true } : {}),
              };
              return withManagedRosterVersion(() => deps.sessions.appendTape(lease, { ...rec, meta }));
            },
            emit: async (entry) => {
              const persistStart = Date.now();
              try {
                const stored = (() => {
                  const tainted = entry;
                  if (tainted.type !== "user") return tainted;
                  const payload =
                    typeof tainted.payload === "object" && tainted.payload !== null
                      ? { ...(tainted.payload as Record<string, unknown>) }
                      : {};
                  if (actor.displayName?.trim() && typeof payload.name !== "string")
                    payload.name = actor.displayName.trim();
                  if (input.displayText?.trim() && payload.text === input.text && typeof payload.display !== "string")
                    payload.display = input.displayText;
                  if (syntheticPrompt) payload.hidden = true;
                  return { ...tainted, payload };
                })();
                const appended = await withManagedRosterVersion(() => deps.sessions.append(lease, stored));
                emittedEntries.push(appended);
                if (appended.type === "user" && spine.turnUserEntrySeq === undefined)
                  spine.turnUserEntrySeq = appended.seq;
                if (appended.type === "user") failureUserPayload = undefined;
                if (appended.type === "tool_call") {
                  toolCalls += 1;
                  if (toolCalls === 1 && input.runId) {
                    if (!input.surfaceTools) {
                      deps.turnStream?.noteToolCall(input.runId);
                    } else if (input.addressed && spineFirstBlockOpen && !resume && !approvalReplay) {
                      spineFirstBlockOpen = false;
                      const payload = appended.payload as { tool?: unknown; action?: unknown };
                      const deliberatePost = payload?.tool === (input.surface ?? "slack") && payload?.action === "post";
                      const ack = spineFirstBlock.trim();
                      if (!deliberatePost && ack && defaultDestination && deps.deliveries) {
                        spineAckText = ack;
                        const runId = input.runId;
                        const ackKey = `ack:${session.id}:${randomUUID()}`;
                        void reachEnqueue({
                          deliveries: deps.deliveries,
                          destination: defaultDestination,
                          text: ack,
                          idempotencyKey: ackKey,
                          provenance: postProvenance(ackKey),
                        })
                          .then(() => deps.turnStream?.markSurfacePosted(runId))
                          .catch(swallowAs("orchestrator: first-block ack", undefined));
                      }
                    }
                  }
                }
                if (input.runId && deps.runActivity && ACTIVITY_ENTRY_TYPES.has(appended.type)) {
                  await deps.runActivity
                    .append(input.runId, {
                      seq: appended.seq,
                      parentSeq: appended.parentSeq,
                      type: appended.type,
                      payload: appended.payload,
                      createdAt: appended.createdAt,
                    })
                    .catch(swallowAs("orchestrator: run-activity append", undefined));
                } else if (input.runId && deps.runActivity && appended.type === "thinking") {
                  const block = appended.payload as { thinking?: string; redacted?: boolean };
                  if (!block.redacted && block.thinking?.trim()) {
                    await deps.runActivity
                      .append(input.runId, {
                        seq: appended.seq,
                        parentSeq: appended.parentSeq,
                        type: appended.type,
                        payload: { thinking: block.thinking },
                        createdAt: appended.createdAt,
                      })
                      .catch(swallowAs("orchestrator: run-activity append", undefined));
                  }
                }
                return appended;
              } finally {
                emitGapWork("persist", persistStart, Date.now());
              }
            },
            scopeLabel: scopeId,
            orgScopeId: resolution.orgScopeId,
            onDelta: (chunk: string) => {
              const now = Date.now();
              if (firstChunkAt === undefined) firstChunkAt = now;
              lastChunkAt = now;
              if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publish(input.runId, chunk);
              if (input.surfaceTools && spineFirstBlockOpen && spineFirstBlock.length < FIRST_BLOCK_CAPTURE_MAX_CHARS)
                spineFirstBlock += chunk;
            },
            onTextBlockStart: () => {
              if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publishBlockStart(input.runId);
              if (input.surfaceTools && spineFirstBlock) spineFirstBlockOpen = false;
            },
            onGapWork: (cb) => {
              harnessOnGapWork = cb;
            },
            recordModelCall: (rec) => {
              deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
              void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
            },
            recordLlmRequest: async (rec) => {
              try {
                await deps.sessions.recordLlmRequest(session.id, { ...rec, scopeLabel: scopeId });
              } catch (err) {
                console.error("[orchestrator] failed to persist LLM request snapshot:", errMessage(err));
              }
            },
          });
        };
        const primaryServedTape = !!tapeRows?.serve && history === visibleHistory;
        let result = await runHarnessTurn(turnInput, {
          ...(turnEnvironment ? { environment: turnEnvironment } : {}),
          ...(priorTurns?.length ? { priorTurns } : {}),
          ...(importedOverheard.length ? { overheard: importedOverheard } : {}),
          ...(inbound.metas.length ? { attachments: inbound.metas } : {}),
          ...(inbound.images.length ? { images: inbound.images } : {}),
        });
        const primarySubturnEndSeq = emittedEntries.at(-1)?.seq;
        if (
          input.addressed &&
          !strictReadOnly &&
          input.surfaceTools &&
          surfaceToolDeps &&
          spine.surfaceOutboundCount === 0 &&
          spine.staySilentReason === undefined &&
          !result.silent
        ) {
          const firstTapeWriteFailed = !!result.tapeWriteFailed;
          const primaryStopped = !!result.stopped;
          // The model already wrote a reply as plain assistant text — deliver that text
          // directly instead of nudging it to re-post (a nudge here re-sends near-identical
          // text, which surfaces that render assistant entries show twice).
          const primaryReply = stripAckPrefix(result.reply ?? "", spineAckText).trim();
          if (primaryReply && defaultDestination && deps.deliveries) {
            try {
              const directKey = `post:${session.id}:${randomUUID()}`;
              await reachEnqueue({
                deliveries: deps.deliveries,
                destination: defaultDestination,
                text: primaryReply,
                idempotencyKey: directKey,
                provenance: postProvenance(directKey),
              });
              spine.surfaceOutboundCount += 1;
              if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
            } catch (e) {
              console.error(`[orchestrator] direct reply delivery failed session=${session.id}:`, errMessage(e));
            }
          }
          if (spine.surfaceOutboundCount === 0) {
            const nudgeHistory = filterHistory(
              forModelContext(await deps.sessions.getEntries(session.id), { includeSecurityTainted: false }),
            );
            const nudgeTape = tapeRows
              ? await deps.sessions
                  .getTape(session.id)
                  .then(async (allRows) => {
                    const rows = filterTapeForAudience(allRows, conversation.audience, scopeId, resolution.orgScopeId);
                    const sameHarness = rows.every(
                      (row) => row.kind !== "message" || row.harness === undefined || row.harness === "pi",
                    );
                    const eventsEntitled = tapeEventsEntitled(
                      rows,
                      conversation.audience,
                      scopeId,
                      resolution.orgScopeId,
                    );
                    const primarySubturnComplete =
                      primarySubturnEndSeq !== undefined &&
                      rows.some(
                        (row) =>
                          row.kind === "annotation" &&
                          row.entrySeq === primarySubturnEndSeq &&
                          (row.payload as { subturnEnd?: unknown } | null)?.subturnEnd === true,
                      );
                    if (
                      primaryServedTape &&
                      !firstTapeWriteFailed &&
                      sameHarness &&
                      eventsEntitled &&
                      primarySubturnComplete
                    ) {
                      const fold = await rehydrateTape(foldTape(rows));
                      if (fold.length && lintFold(fold).ok) return { rows, mode: "serve" as const, fold };
                    }
                    return { rows, mode: "shadow" as const };
                  })
                  .catch((e) => {
                    swallow("tape: nudge read", e);
                    return undefined;
                  })
              : undefined;
            result = await runHarnessTurn(
              "[system] You were addressed directly. Reply with the `slack` tool's `post` action, or decline explicitly with stay_silent — ending the turn without either is not allowed here.",
              {
                ...(turnEnvironment ? { environment: turnEnvironment } : {}),
                ...(nudgeTape?.mode !== "serve" && inbound.images.length ? { images: inbound.images } : {}),
              },
              { history: nudgeHistory, ...(nudgeTape ? { tape: nudgeTape } : {}) },
            );
            if (firstTapeWriteFailed || result.tapeWriteFailed) result = { ...result, tapeWriteFailed: true };
            if (primaryStopped && !result.stopped) result = { ...result, stopped: true };
            if (spine.surfaceOutboundCount === 0 && spine.staySilentReason === undefined && !result.silent) {
              const fallback = stripAckPrefix(result.reply ?? "", spineAckText).trim();
              if (fallback && defaultDestination && deps.deliveries) {
                try {
                  const fallbackKey = `post:${session.id}:${randomUUID()}`;
                  await reachEnqueue({
                    deliveries: deps.deliveries,
                    destination: defaultDestination,
                    text: fallback,
                    idempotencyKey: fallbackKey,
                    provenance: postProvenance(fallbackKey),
                  });
                  spine.surfaceOutboundCount += 1;
                  if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
                } catch (e) {
                  console.error(
                    `[orchestrator] shed-reply fallback delivery failed session=${session.id}:`,
                    errMessage(e),
                  );
                }
              } else {
                console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
              }
            }
          }
        }
        const totalMs = Date.now() - turnStart;

        const noOutbound = { attachments: [], oversized: [], empty: [], dropped: 0 };
        const harvestOutbox = conversation.kind === "dm";
        const outboundScoped =
          harvestOutbox && box.used && box.handle
            ? await collectOutbound(deps.sandbox, box.handle, blobTransfer, fileRegistration, turnOutboxDir)
            : noOutbound;
        const outboundScratch =
          harvestOutbox && scratchBox.handle
            ? await collectOutbound(
                deps.sandbox,
                scratchBox.handle,
                blobTransfer,
                { ...fileRegistration, seed: `${fileRegistration.seed}:scratch` },
                turnOutboxDir,
              )
            : noOutbound;
        if (!harvestOutbox && box.used && box.handle) {
          const orphans = await deps.sandbox.listDir(box.handle, turnOutboxDir).catch(() => [] as string[]);
          if (orphans.length)
            console.error(
              `[orchestrator] ${orphans.length} outbox file(s) left unsent on a ${conversation.kind} turn (attach via post(files), not the outbox) session=${session.id}: ${orphans.map((p) => p.split("/").pop()).join(", ")}`,
            );
        }
        const outbound = {
          attachments: [...outboundScoped.attachments, ...outboundScratch.attachments],
          oversized: [...outboundScoped.oversized, ...outboundScratch.oversized],
          empty: [...outboundScoped.empty, ...outboundScratch.empty],
          dropped: outboundScoped.dropped + outboundScratch.dropped,
        };
        const harvestedAck = (() => {
          if (input.surface !== "slack" || input.surfaceTools || !input.runId) return undefined;
          const fb = deps.turnStream?.firstBlock(input.runId);
          const text = fb?.text.trim();
          return fb?.closed && text ? text : undefined;
        })();
        const reply = stripAckPrefix(result.reply ?? "", harvestedAck);
        const outboundIssues: string[] = [];
        if (outbound.oversized.length) {
          outboundIssues.push(
            `${outbound.oversized.join(", ")} ${outbound.oversized.length === 1 ? "was" : "were"} too large to send`,
          );
        }
        if (outbound.empty.length) {
          outboundIssues.push(
            `${outbound.empty.join(", ")} ${outbound.empty.length === 1 ? "was empty, so it wasn't" : "were empty, so they weren't"} sent`,
          );
        }
        if (outbound.dropped > 0) outboundIssues.push(`${outbound.dropped} more file(s) were not sent (too many)`);
        if (outboundIssues.length) {
          try {
            emittedEntries.push(
              await withManagedRosterVersion(() =>
                deps.sessions.append(lease, {
                  type: "system",
                  payload: fileEventPayload("out", outboundIssues),
                  scopeLabel: scopeId,
                }),
              ),
            );
          } catch (err) {
            swallow("orchestrator: outbound file-event log", err);
          }
        }

        if (outbound.attachments.length) {
          const appended = await withManagedRosterVersion(() =>
            deps.sessions.append(lease, {
              type: "delivery",
              payload: {
                text: deliveryManifest(outbound.attachments),
                files: outbound.attachments.map((a) => ({
                  name: a.name,
                  mimetype: a.mimetype,
                  sizeBytes: a.sizeBytes,
                  ...(a.artifactId ? { artifactId: a.artifactId } : {}),
                })),
              },
              scopeLabel: scopeId,
            }),
          );
          emittedEntries.push(appended);
          await withManagedRosterVersion(() =>
            deps.sessions.appendTape(lease, {
              kind: "message",
              payload: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `[files delivered to the conversation: ${deliveryManifest(outbound.attachments)}]`,
                  },
                ],
                timestamp: appended.createdAt,
              },
              scopeLabel: scopeId,
              entrySeq: appended.seq,
              meta: { hidden: true },
            }),
          ).catch((e) => {
            result = { ...result, tapeWriteFailed: true };
            swallow("tape: delivery note", e);
          });
        }

        {
          const lastSeq = [...emittedEntries.map((e) => e.seq), ...preAppendedSeqs].reduce(
            (m, s2) => Math.max(m, s2),
            -1,
          );
          const preTurnCovered = tapeRows ? tapeRows.covered : false;
          if (lastSeq >= 0 && preTurnCovered && !result.stopped && !result.tapeWriteFailed && !compactionMirrorFailed) {
            await withManagedRosterVersion(() =>
              deps.sessions.appendTape(lease, {
                kind: "annotation",
                payload: { turnEnd: true },
                scopeLabel: scopeId,
                entrySeq: lastSeq,
              }),
            ).catch(swallowAs("tape: turn-end watermark", undefined));
          }
        }

        const outcome = deriveTurnOutcome({
          ...(reply !== undefined ? { reply } : {}),
          attachments: outbound.attachments.length,
          issues: outboundIssues.length,
          pendingApprovals: result.pendingApprovals ?? [],
          terminatedOnApproval: result.pausedOnApproval === true,
        });
        const turnCompleted = outcome.completed;
        const pausing = outcome.paused;
        if (input.runId && !pausing && reply && reply.trim()) deps.turnStream?.markReplyDone(input.runId);
        const turnUserSeq = emittedEntries.find((e) => e.type === "user")?.seq;
        let metricProvisionMs: number | undefined;
        if (box.provisionMs !== undefined) metricProvisionMs = box.provisionMs;
        else if (scratchBox.provisionMs !== undefined) metricProvisionMs = scratchBox.provisionMs;
        else if (ownerAuthBox.provisionMs !== undefined) metricProvisionMs = ownerAuthBox.provisionMs;
        deps.metrics?.record({
          totalMs,
          sessionId: session.id,
          ...(turnUserSeq !== undefined ? { turnSeq: turnUserSeq } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(firstChunkAt !== undefined ? { ttftMs: firstChunkAt - turnStart } : {}),
          ...(firstChunkAt !== undefined ? { streamMs: (lastChunkAt ?? firstChunkAt) - firstChunkAt } : {}),
          ...(typeof input.intakePreambleMs === "number" ? { intakePreambleMs: input.intakePreambleMs } : {}),
          ...(typeof input.clientSentAt === "number"
            ? { dispatchMs: Math.max(0, coreReceivedAt - input.clientSentAt) }
            : {}),
          ingressMs: Math.max(0, turnStart - coreReceivedAt),
          ...(detectMs !== undefined ? { detectMs } : {}),
          ...(compactMs !== undefined ? { compactMs } : {}),
          ...(typeof input.queueMs === "number" ? { queueMs: Math.max(0, input.queueMs) } : {}),
          ...(resumedFromSeq !== undefined ? { resumedFromSeq } : {}),
          status: pausing ? "paused" : "ok",
          scopeLabel: scopeId,
          provisioned:
            !!box.handle ||
            !!box.pending ||
            provisionPending() ||
            !!scratchBox.handle ||
            !!ownerAuthBox.handle ||
            !!ownerAuthBox.pending,
          ...((box.handle ?? box.pending ?? scratchBox.handle ?? ownerAuthBox.handle ?? ownerAuthBox.pending)
            ? {
                coldStart: !!(box.handle ??
                  box.pending ??
                  scratchBox.handle ??
                  ownerAuthBox.handle ??
                  ownerAuthBox.pending)!.coldStart,
              }
            : {}),
          modelCalls: result.modelCalls ?? 0,
          toolCalls,
          ...(metricProvisionMs !== undefined ? { provisionMs: metricProvisionMs } : {}),
          ...(box.materializeMs !== undefined ? { materializeMs: box.materializeMs } : {}),
          ...(perf.credsMs > 0 ? { credsMs: perf.credsMs } : {}),
          ...(result.compileMs !== undefined ? { compileMs: result.compileMs } : {}),
          recallMs,
          leaseMs,
          ...(execCount > 0 ? { execMs } : {}),
          ...(result.cacheUsage
            ? {
                cacheRead: result.cacheUsage.cacheRead,
                cacheWrite: result.cacheUsage.cacheWrite,
                uncachedInput: result.cacheUsage.uncachedInput,
              }
            : {}),
        });
        const onTurnEnd = memoryStrategy.onTurnEnd?.bind(memoryStrategy);
        if (!pausing && useMemory && memoryPolicy.capture !== "off" && onTurnEnd) {
          const prior = pendingCaptures.get(memoryScopeId);
          const capture = (async () => {
            if (prior) await prior.catch(swallowAs("prior memory capture", undefined));
            const captureStart = Date.now();
            try {
              const conversationLabel = await conversationLabelFor(deps.directory, scopeId, conversation.channelName);
              await onTurnEnd({
                scopeId: memoryScopeId,
                conversationScopeId: scopeId,
                input: turnInput,
                reply,
                actorId: actor.id,
                ...(automatedTurn ? { autonomous: true } : {}),
                ...(conversationLabel ? { conversationLabel } : {}),
              });
            } catch (e) {
              deps.errors?.record({
                category: "memory",
                code: "capture_failed",
                message: errMessage(e),
                scopeLabel: scopeId,
                sessionId: session.id,
              });
            } finally {
              deps.metrics?.record({
                totalMs: 0,
                status: "capture",
                scopeLabel: scopeId,
                captureMs: Date.now() - captureStart,
              });
            }
          })();
          pendingCaptures.set(memoryScopeId, capture);
          void capture.finally(() => {
            if (pendingCaptures.get(memoryScopeId) === capture) pendingCaptures.delete(memoryScopeId);
          });
        }

        const tail = async (): Promise<void> => {
          try {
            const writable = resolution.layers.find((l) => l.mode === "rw");
            const writtenHandle = box.used ? box.handle : null;
            if (writable && writtenHandle) {
              if (deps.keychain) {
                try {
                  await captureDeviceFlowLogins({
                    sandbox: deps.sandbox,
                    handle: writtenHandle,
                    keychain: deps.keychain,
                    ownerId: deviceFlowCredOwner(memoryScopeId, actor.id),
                    ...(brokerCutoverServices.length ? { excludeServices: brokerCutoverServices } : {}),
                    ...(deps.deploymentLayer?.credentialPaths.length
                      ? { credentialPaths: deps.deploymentLayer.credentialPaths }
                      : {}),
                    onAnomaly: (service, detail) =>
                      deps.errors?.record({
                        category: "keychain",
                        code: "device_flow_capture_skipped",
                        message: `device-flow capture skipped ${service}: ${detail}`,
                        scopeLabel: scopeId,
                        sessionId: session.id,
                      }),
                  });
                } catch (e) {
                  deps.errors?.record({
                    category: "keychain",
                    code: "device_flow_capture_failed",
                    message: errMessage(e),
                    scopeLabel: scopeId,
                    sessionId: session.id,
                  });
                }
              }
            }
            if (!pausing && turnCompleted && !session.title && !(earlyTitleGen && (await earlyTitleGen))) {
              await generateAndStoreTitle(session.id, scopeId, `User:\n${input.text}\n\nAssistant:\n${result.reply}`);
            }
          } finally {
            await reclaimBox();
          }
        };

        let finalResult: TurnResult;
        const sourceUserSeq = partial?.userSeq ?? emittedEntries.find((e) => e.type === "user")?.seq;
        const sourceAssistantEntrySeq = [...emittedEntries].reverse().find((e) => e.type === "assistant")?.seq;
        if (isPollFire && result.silent && result.pausedOnApproval !== true) {
          finalResult = { status: "silent", sessionId: session.id };
        } else if (result.pendingApprovals?.length) {
          const approvals: PendingApproval[] = [];
          const grantModesField =
            resolution.approvalGrantModes.session && resolution.approvalGrantModes.always
              ? {}
              : { grantModes: resolution.approvalGrantModes };
          const request = replayableRequest(input);
          const prepared: Array<{ requestId: string; record: PendingApprovalRecord; approval: PendingApproval }> = [];
          for (const pa of result.pendingApprovals) {
            const blocks = approvalBlocksInput(pa.kind, outcome);
            const command = pa.command;
            const requestId = commandApprovalId(session.id, command);
            const summary = await approvalSummary(scopeId, command, pa.reason, pa.purpose);
            prepared.push({
              requestId,
              record: {
                sessionId: session.id,
                command,
                createdAt: Date.now(),
                reason: pa.reason,
                request,
                blocksInput: blocks,
                ...grantModesField,
                ...(pa.matched ? { matched: pa.matched } : {}),
                ...(pa.purpose ? { purpose: pa.purpose } : {}),
                ...(summary ? { summary } : {}),
                ...(pa.approvalKey ? { approvalKey: pa.approvalKey } : {}),
                ...(pa.kind ? { kind: pa.kind } : {}),
              },
              approval: {
                requestId,
                command,
                reason: pa.reason,
                blocksInput: blocks,
                ...grantModesField,
                ...(pa.matched ? { matched: pa.matched } : {}),
                ...(pa.purpose ? { purpose: pa.purpose } : {}),
                ...(summary ? { summary } : {}),
                ...(pa.approvalKey ? { approvalKey: pa.approvalKey } : {}),
                ...(pa.kind ? { kind: pa.kind } : {}),
              },
            });
          }
          await withManagedRosterVersion(async () => {
            for (const item of prepared) {
              await pending.put(item.requestId, item.record);
              approvals.push(item.approval);
            }
            return true;
          });
          finalResult = turnCompleted
            ? {
                status: "ok",
                sessionId: session.id,
                reply,
                pendingApprovals: approvals,
                ...(outbound.attachments.length ? { attachments: outbound.attachments } : {}),
                ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
                ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
              }
            : { status: "pending_approval", sessionId: session.id, pendingApprovals: approvals };
        } else if (isPollFire && !outbound.attachments.length && isSilentPollReply(reply)) {
          finalResult = { status: "silent", sessionId: session.id };
        } else if (input.surfaceTools && surfaceToolDeps && !strictReadOnly) {
          finalResult = { status: "silent", sessionId: session.id, ...(result.stopped ? { stopped: true } : {}) };
        } else {
          finalResult = {
            status: "ok",
            sessionId: session.id,
            reply,
            ...(result.stopped ? { stopped: true } : {}),
            ...(outbound.attachments.length ? { attachments: outbound.attachments } : {}),
            ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
            ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
          };
        }

        if (input.background && box.used && box.handle && finalResult.status === "ok") {
          tailOwnsCleanup = true;
          await deps.sessions.releaseLease(lease);
          leaseReleased = true;
          void tail().catch(swallowAs("orchestrator: background tail", undefined));
        } else {
          await tail();
          tailOwnsCleanup = true;
        }
        await deps.errors?.flush();
        return finalResult;
      } catch (err) {
        if (err instanceof ProjectRosterChanged) {
          return {
            status: "refused",
            sessionId: session.id,
            reason: "project membership changed; retry from the current project",
          };
        }
        if (err instanceof NeedsApproval) {
          const requestId = commandApprovalId(session.id, err.command);
          const grantModesField =
            resolution.approvalGrantModes.session && resolution.approvalGrantModes.always
              ? {}
              : { grantModes: resolution.approvalGrantModes };
          const summary = await approvalSummary(scopeId, err.command, err.approvalReason);
          try {
            await withManagedRosterVersion(async () => {
              await pending.put(requestId, {
                sessionId: session.id,
                command: err.command,
                createdAt: Date.now(),
                reason: err.approvalReason,
                ...grantModesField,
                ...(err.matched ? { matched: err.matched } : {}),
                ...(summary ? { summary } : {}),
                ...(err.approvalKey ? { approvalKey: err.approvalKey } : {}),
                request: replayableRequest(input),
                blocksInput: true,
                kind: err.kind,
              });
              return true;
            });
          } catch (writeErr) {
            if (writeErr instanceof ProjectRosterChanged) {
              return {
                status: "refused",
                sessionId: session.id,
                reason: "project membership changed; retry from the current project",
              };
            }
            throw writeErr;
          }
          const approval: PendingApproval = {
            requestId,
            command: err.command,
            reason: err.approvalReason,
            ...grantModesField,
            ...(err.matched ? { matched: err.matched } : {}),
            ...(summary ? { summary } : {}),
            ...(err.approvalKey ? { approvalKey: err.approvalKey } : {}),
            blocksInput: true,
          };
          return { status: "pending_approval", sessionId: session.id, pendingApprovals: [approval] };
        }
        if (err instanceof CommandDenied) {
          deps.errors?.record({
            category: "command_policy",
            code: "denied",
            message: err.message,
            scopeLabel: scopeId,
            sessionId: session.id,
          });
          return { status: "refused", sessionId: session.id, reason: err.message };
        }
        deps.errors?.record({
          category: "turn",
          code: "error",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        });
        if ((err instanceof NonRetryableTurnError || input.finalAttempt) && !input.cancel?.aborted) {
          if (failureUserPayload) {
            await deps.sessions
              .append(lease, { type: "user", payload: failureUserPayload, scopeLabel: scopeId as ScopeId })
              .catch(swallowAs("orchestrator: turn failure user back-fill", undefined));
          }
          const payload: TurnFailurePayload = { kind: "turn_failure", message: turnFailureMessage(err) };
          await deps.sessions
            .append(lease, { type: "system", payload, scopeLabel: scopeId as ScopeId })
            .catch(swallowAs("orchestrator: terminal turn failure record", undefined));
        }
        throw err;
      } finally {
        if (input.runId) deps.turnStream?.end(input.runId);
        if (!tailOwnsCleanup) await reclaimBox();
        if (!leaseReleased) await deps.sessions.releaseLease(lease);
        scheduleBackgroundCompaction({
          sessionId: session.id,
          scopeId,
          orgScopeId: resolution.orgScopeId,
          actorId: actor.id,
        });
      }
    },
  };
}
