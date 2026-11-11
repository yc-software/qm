import { randomUUID } from "node:crypto";
import type { ScopeId } from "../../types.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import type { SecurityScreenClassification, SecurityScreenHook } from "../../security/security-screener.ts";
import { UNSCREENED_REASON, type SecurityScreenVerdict } from "../../security/security-posture.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { TurnLlmRequestRecord } from "../../agent/agent.ts";
import { swallowAs } from "../../util/errors.ts";
import { createKeyedQueue, sleep } from "../../util/async.ts";
import { headSlice } from "../../util/text.ts";
import { SECURITY_FLAGGED, type AuditEvent } from "../../audit/audit-log.ts";
import {
  recordedMessageTimestamps,
  renderOverheard,
  selectOverheardToImport,
  type OverheardEntryPayload,
} from "../../agent/replay.ts";
import { collectBlob } from "../../persistence/blob-transfer.ts";
import { securityScreenPayload } from "../../security/security-posture.ts";
import type { CommandApprovalGrant } from "../../types.ts";
import { isVisionAttachment, safeAttachmentName } from "../attachments.ts";
import { wordsToScreen } from "./intake.ts";
import { documentText, type ExtractedDocumentText, isTextDocument, type loadDocumentInputs } from "../documents.ts";
import { senderNote } from "./prompt-blocks.ts";
import { isScreenableTextAttachment, MAX_AUTO_ATTACHMENT_SCREEN_BYTES } from "./turn-helpers.ts";
import { tracePhase } from "../../../plugins/chassis/src/error-reporting.ts";
import type { resolveTurnContext } from "../../resolution/turn-context.ts";
import { securityScreenChunks } from "../../security/security-posture.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import { hashId } from "../../util/crypto.ts";
import { filterConnectorSkills, loadActiveBundles } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import type { Session } from "../../types.ts";
import { SECURITY_TOOL_RESULT_QUARANTINE } from "../../audit/audit-log.ts";
import {
  quarantineReleaseKey,
  toolLabelOf,
  type ToolResultScreen,
  type ToolResultScreenInput,
} from "../../security/security-posture.ts";
import { quarantineFullText, quarantinePreview, type createApprovalLedger } from "./approvals.ts";
import type { Tenant } from "../../tenants/context.ts";

type ApprovalLedger = Awaited<ReturnType<typeof createApprovalLedger>>;

const DEFAULT_SECURITY_SCREEN_TIMEOUT_MS = 15_000;
const MAX_SCREEN_REQUEST_CHARS = 2_000;
const MAX_AUDITED_SOURCES = 20;

export const unscreenedVerdict = (): SecurityScreenVerdict => ({
  decision: "auto",
  unscreened: true,
  reason: UNSCREENED_REASON,
});

type ScreenStatus = "allow" | "block" | "would_block" | "error";
type Screened = Pick<SecurityScreenClassification, "verdict"> & Partial<SecurityScreenClassification>;

export interface SecurityScreenContext {
  mode: "observe" | "enforce";
  hook?: SecurityScreenHook;
  surface?: string;
  origin?: TurnOrigin["kind"];
  requestId?: string;
  request?: string;
  sessionId?: string;
  runId?: string;
  thread?: string;
}

export type SecurityClassifier = (
  tenant: Tenant,
  payload: string,
  actorId: string,
  scopeLabel: ScopeId,
  recordLlmRequest: ((rec: TurnLlmRequestRecord) => void | Promise<void>) | undefined,
  context: SecurityScreenContext,
) => Promise<SecurityScreenVerdict | undefined>;

function screenSources(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sources = parsed.flatMap((item: { source?: unknown } | null) =>
    typeof item?.source === "string" ? [item.source.slice(0, 120)] : [],
  );
  return [...new Set(sources)].slice(0, MAX_AUDITED_SOURCES);
}

export function createSecurityClassifier(deps: OrchestratorDeps): SecurityClassifier {
  const observeQueue = createKeyedQueue<string | undefined>();
  return async function classifySecurityData(tenant, payload, actorId, scopeLabel, recordLlmRequest, context) {
    const screener = deps.securityScreener;
    const model = deps.agent.screenSecurity;
    const observe = context.mode === "observe";
    if (!screener && !model) return observe ? { decision: "auto" } : undefined;
    const timeoutMs = deps.securityScreenTimeoutMs ?? DEFAULT_SECURITY_SCREEN_TIMEOUT_MS;
    const hook = context.hook ?? "user_input";
    let request: { origin: string; text: string; truncated: boolean } | undefined;
    if (hook === "tool_response" && context.request?.trim()) {
      request = {
        origin: context.origin ?? "unknown",
        text: headSlice(context.request, MAX_SCREEN_REQUEST_CHARS).toWellFormed(),
        truncated: context.request.length > MAX_SCREEN_REQUEST_CHARS,
      };
    }

    const audit = (status: ScreenStatus, requestId: string, attempts: number, result?: Screened): void => {
      deps.auditLog.record(tenant, {
        at: Date.now(),
        principalId: actorId,
        action: "security_screen.classify",
        resource: screener?.provider ?? "model",
        scopeLabel,
        status,
        detail: JSON.stringify({
          hook,
          mode: context.mode,
          sources: screenSources(payload),
          ...(context.surface ? { surface: context.surface } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.thread ? { thread: context.thread } : {}),
          requestId,
          attempts,
          ...(result?.score !== undefined ? { score: result.score, threshold: result.threshold } : {}),
          ...(result?.outcome ? { outcome: result.outcome } : {}),
        }),
      });
    };

    const screenOnce = async (requestId: string, signal: AbortSignal): Promise<Screened | undefined> => {
      if (screener) {
        return screener.classify({
          payload,
          hook,
          metadata: {
            ...(context.surface ? { surface: context.surface } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(request ? { request } : {}),
          },
          requestId,
          signal,
        });
      }
      const verdict = await model!({
        payload: request ? JSON.stringify({ request, payload }) : payload,
        signal,
        recordModelCall: (rec) => {
          if (!observe) void deps.budget?.record(tenant, actorId, estimateCostUsd(rec.inputTokens));
        },
        ...(recordLlmRequest && !observe ? { recordLlmRequest } : {}),
      });
      return verdict ? { verdict } : undefined;
    };

    const attempt = async (ms = timeoutMs): Promise<{ requestId: string; result: Screened | undefined }> => {
      const requestId = context.requestId ?? randomUUID();
      if (ms <= 0) return { requestId, result: undefined };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), ms);
      if (observe) timer.unref();
      const timedOut = new Promise<undefined>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
      try {
        const result = await Promise.race([screenOnce(requestId, abort.signal), timedOut]).catch(
          swallowAs("orchestrator: security screen", undefined),
        );
        return { requestId, result };
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    };
    const settle = ({ requestId, result }: Awaited<ReturnType<typeof attempt>>, attempts: number) => {
      let status: ScreenStatus = "error";
      if (result && !result.verdict.unscreened) {
        if (result.verdict.decision === "strict") status = observe ? "would_block" : "block";
        else status = "allow";
      }
      audit(status, requestId, attempts, result);
      return result?.verdict;
    };

    if (observe) {
      const deadline = Date.now() + timeoutMs;
      void observeQueue(context.thread, () => attempt(Date.now() < deadline ? timeoutMs : 0))
        .then((result) => settle(result, 1))
        .catch(swallowAs("orchestrator: observed security screen", undefined));
      return { decision: "auto" };
    }

    const startedAt = Date.now();
    const first = await attempt();
    if (first.result || Date.now() - startedAt >= timeoutMs / 2) return settle(first, 1) ?? unscreenedVerdict();
    await sleep(250);
    return settle(await attempt(), 2) ?? unscreenedVerdict();
  };
}

export const cleanVerdict = (verdict: SecurityScreenVerdict | undefined): boolean =>
  verdict?.decision === "auto" && !verdict.unscreened;

export async function screenChunks(
  chunks: readonly string[],
  classify: (chunk: string) => Promise<SecurityScreenVerdict | undefined>,
  { batch = 1, stopUnclean = false, signal }: { batch?: number; stopUnclean?: boolean; signal?: AbortSignal } = {},
): Promise<SecurityScreenVerdict> {
  const verdicts: Array<SecurityScreenVerdict | undefined> = [];
  for (let i = 0; i < chunks.length; i += batch) {
    signal?.throwIfAborted();
    const settled = await Promise.all(chunks.slice(i, i + batch).map(classify));
    verdicts.push(...settled);
    if (settled.some((verdict) => verdict?.decision === "strict" || (stopUnclean && !cleanVerdict(verdict)))) break;
  }
  const strict = verdicts.find((verdict) => verdict?.decision === "strict");
  if (strict) return strict;
  if (verdicts.length < chunks.length || !verdicts.every(cleanVerdict)) return unscreenedVerdict();
  return verdicts[0] ?? { decision: "auto" };
}

export type ClassifyAs = (
  context: Omit<SecurityScreenContext, "mode" | "thread" | "runId" | "origin">,
  record?: (rec: TurnLlmRequestRecord) => Promise<void>,
) => (chunk: string) => Promise<SecurityScreenVerdict | undefined>;

export interface InboundScreenTurn {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  scopeId: ScopeId;
  resolution: Awaited<ReturnType<OrchestratorDeps["resolution"]["resolve"]>>;
  screenInbound: boolean;
  enforceScreen: boolean;
  ambientTurn: boolean;
  sessionTurn: boolean;
  swarmBinding: Awaited<ReturnType<NonNullable<OrchestratorDeps["swarms"]>["binding"]>> | undefined;
  classifyAs: ClassifyAs;
  recordScreenRequest: (rec: TurnLlmRequestRecord) => Promise<void>;
  audit: (event: Omit<AuditEvent, "at" | "principalId" | "scopeLabel">) => void;
  approvalGrantsFor: (actorId: string) => Promise<CommandApprovalGrant[]>;
}

async function buildInboundScreen(turn: InboundScreenTurn) {
  const { deps, input, actor, conversation, scopeId, screenInbound, ambientTurn, sessionTurn, swarmBinding } = turn;
  const blobTransfer = deps.blobTransfer;
  let overheard: OverheardEntryPayload[] = [];
  if (screenInbound) {
    const existingSession = await deps.sessions.getByThread(conversation.threadRef);
    const recorded = recordedMessageTimestamps(existingSession ? await deps.sessions.getItems(existingSession.id) : []);
    overheard = conversation.kind === "dm" ? [] : selectOverheardToImport(input.overheard ?? [], recorded);
  }
  let hasUnscreenableAttachment = false;
  const attachmentPromptData: Array<{ source: string; content: string }> = [];
  if (screenInbound) {
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
      const opened = await blobTransfer
        .open(attachment.blobId)
        .catch(swallowAs("attachment screening: open blob", null));
      if (!opened || opened.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) {
        hasUnscreenableAttachment = true;
        continue;
      }
      const data = await collectBlob(opened.stream).catch(swallowAs("attachment screening: read blob", null));
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
  const externalPromptData = screenInbound
    ? [
        ...(ambientTurn && actor.displayName?.trim()
          ? [{ source: "sender", content: senderNote(actor.displayName) }]
          : []),
        ...(input.conversationHeader?.trim()
          ? [{ source: "conversation-header", content: input.conversationHeader }]
          : []),
        ...overheard.map((entry) => ({ source: "overheard", content: renderOverheard(entry) })),
        ...attachmentPromptData,
        ...(input.inboundNotes ?? []).map((note) => ({ source: "inbound-file-note", content: note })),
      ]
    : [];
  const sessionSender = input.sessionSenderId ? await deps.sessions.get(input.sessionSenderId) : null;
  const verifiedSessionMessage = Boolean(
    sessionSender &&
    sessionSender.scopeId === scopeId &&
    (await deps.sessions.getForParticipant(sessionSender.id, actor.id)),
  );
  const screenedWords = wordsToScreen(
    input.text,
    { id: actor.id, origin: input.origin, fromSession: sessionTurn },
    actor.id,
  );
  const screenPayload = screenInbound
    ? securityScreenPayload({
        ...input,
        ...(screenedWords !== undefined ? { origin: { kind: "automation" as const, screenData: screenedWords } } : {}),
        overheard: [],
        externalPromptData,
        verifiedSwarm: Boolean(input.swarm && swarmBinding),
        verifiedSessionMessage,
      })
    : null;
  return { hasUnscreenableAttachment, externalPromptData, screenPayload };
}

export async function screenInboundInput(turn: InboundScreenTurn) {
  const {
    deps,
    input,
    actor,
    conversation,
    resolution,
    screenInbound,
    enforceScreen,
    classifyAs,
    recordScreenRequest,
    audit,
    approvalGrantsFor,
  } = turn;
  let flaggedScreenedInput: { reason: string; sources: string[] } | undefined;
  let inputUnscreened = false;
  if (screenInbound && !enforceScreen) {
    void buildInboundScreen(turn)
      .then(({ screenPayload }) =>
        screenPayload && !screenPayload.truncated
          ? classifyAs({ hook: "user_input", surface: input.surface })(screenPayload.content)
          : undefined,
      )
      .catch(swallowAs("orchestrator: observed inbound screen", undefined));
  } else if (screenInbound) {
    const { hasUnscreenableAttachment, externalPromptData, screenPayload } = await buildInboundScreen(turn);
    if (screenPayload || hasUnscreenableAttachment) {
      const canScreenText =
        !!screenPayload && !screenPayload.truncated && (!!deps.securityScreener || !!deps.agent.screenSecurity);
      const verdict = canScreenText
        ? await screenChunks(
            [screenPayload!.content],
            classifyAs({ hook: "user_input", surface: input.surface }, recordScreenRequest),
          )
        : undefined;
      let unscreenableCause: "unscreenable-attachment" | "oversize-input" | "no-screener" | undefined;
      if (hasUnscreenableAttachment || !screenPayload) unscreenableCause = "unscreenable-attachment";
      else if (screenPayload.truncated) unscreenableCause = "oversize-input";
      else if (!deps.securityScreener && !deps.agent.screenSecurity) unscreenableCause = "no-screener";
      if (verdict?.decision === "strict") {
        const sources = externalPromptData.map((item) => item.source);
        flaggedScreenedInput = {
          reason: verdict.reason ?? "strict security screen verdict",
          sources,
        };
        audit({
          action: SECURITY_FLAGGED,
          resource: input.surface ?? "unknown",
          status: "pending_approval",
          detail: JSON.stringify({ cause: "strict-verdict", reason: flaggedScreenedInput.reason, source: sources }),
        });
      } else if (unscreenableCause || verdict?.unscreened) {
        inputUnscreened = true;
        audit({
          action: "security_posture.input_failed_open",
          resource: input.surface ?? "unknown",
          status: "allowed",
          detail: JSON.stringify({ cause: unscreenableCause ?? UNSCREENED_REASON }),
        });
      }
    }
  }
  if (flaggedScreenedInput) {
    const existing = await deps.sessions.getByThread(conversation.threadRef);
    const flagGrantKey = `security-screen:${input.surface ?? "unknown"}`;
    for (const grant of await approvalGrantsFor(actor.id)) {
      if (!resolution.approvalGrantModes[grant.scope]) continue;
      if (grant.scope === "session" && grant.sessionId !== existing?.id) continue;
      if ((grant.approvalKey ?? grant.command) !== flagGrantKey && grant.command !== "security-screen") continue;
      audit({
        action: "security_posture.flag_allowed_by_grant",
        resource: input.surface ?? "unknown",
        status: "allowed",
        detail: JSON.stringify({ scope: grant.scope, reason: flaggedScreenedInput.reason }),
      });
      flaggedScreenedInput = undefined;
      break;
    }
  }
  return { flaggedScreenedInput, inputUnscreened };
}

export const countSkills = (listed: { skills: readonly unknown[] }) => ({ "qm.skills": listed.skills.length });

export interface SkillScreenTurn {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  scopeId: ScopeId;
  context: Awaited<ReturnType<typeof resolveTurnContext>>;
  configuredProviders: Parameters<typeof filterConnectorSkills>[1];
  appConnections: boolean;
  securityPolicy: InboundScreenTurn["resolution"]["securityPolicy"];
  enforceScreen: boolean;
  classifyAs: ClassifyAs;
  recordScreenRequest: (rec: TurnLlmRequestRecord) => Promise<void>;
  audit: InboundScreenTurn["audit"];
}

export function createSkillScreen(turn: SkillScreenTurn) {
  const {
    deps,
    input,
    actor,
    scopeId,
    context,
    configuredProviders,
    appConnections,
    securityPolicy,
    enforceScreen,
    classifyAs,
    recordScreenRequest,
    audit,
  } = turn;
  const carriedSkillScreens = new Map<string, Promise<boolean>>();
  const visibleSkillsForTurn = async (sources?: readonly string[]): Promise<SkillResolution[]> => {
    const current = await tracePhase("turn.skills", () => context.listSkills(sources), { counts: countSkills });
    const resolved = filterConnectorSkills(current.skills, configuredProviders, appConnections);
    const allowed: SkillResolution[] = [];
    for (const entry of resolved) {
      const skill = entry.skill;
      if (!skill || !current.sharingSources.includes(skill.scopeId) || securityPolicy.screening === "off") {
        allowed.push(entry);
        continue;
      }
      const snapshot = structuredClone(entry);
      const screenSkill = async () => {
        const bundles = structuredClone(
          deps.skillBundles
            ? await loadActiveBundles(deps.skillBundles, [snapshot]).catch(
                swallowAs("skill screening: load bundles", null),
              )
            : [],
        );
        const payload = JSON.stringify({ manifest: snapshot.skill!.manifest, bundles });
        const key = hashId([skill.scopeId, skill.id, payload], 64);
        let screen = carriedSkillScreens.get(key);
        if (!screen) {
          screen = (async () => {
            if (bundles === null || Buffer.byteLength(payload, "utf8") > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) return false;
            const verdict = await screenChunks(
              securityScreenChunks("tool_result:shared_skill", payload),
              classifyAs({ hook: "tool_response", request: input.text, surface: "shared_skill" }, recordScreenRequest),
              { stopUnclean: true },
            );
            return cleanVerdict(verdict);
          })();
          carriedSkillScreens.set(key, screen);
        }
        return { passed: await screen, bundles };
      };
      if (!enforceScreen) {
        allowed.push(entry);
        void screenSkill().catch(swallowAs("orchestrator: observed skill screen", undefined));
        continue;
      }
      const { passed, bundles } = await screenSkill();
      if (passed && bundles) allowed.push({ ...snapshot, screenedBundles: bundles });
      else
        audit({
          action: "sharing.skill_screen_blocked",
          resource: `skill:${skill.id}`,
          status: "refused",
          detail: JSON.stringify({ actor: actor.id, source: skill.scopeId, target: scopeId }),
        });
    }
    for (const entry of allowed) {
      if (!entry.skill || !current.sharingSources.includes(entry.skill.scopeId)) continue;
      audit({
        action: "sharing.cross_context_read",
        resource: `skill:${entry.skill.id}`,
        detail: JSON.stringify({ actor: actor.id, source: entry.skill.scopeId, target: scopeId }),
      });
    }
    return allowed;
  };
  return visibleSkillsForTurn;
}

export interface ToolResultScreenTurn {
  input: OrchestratorInput;
  session: Session;
  classifyAs: ClassifyAs;
  recordScreenRequest: (rec: TurnLlmRequestRecord) => Promise<void>;
  enforceScreen: boolean;
  authorizeCommand: ApprovalLedger["authorizeCommand"];
  audit: InboundScreenTurn["audit"];
  quarantineReleaseApprovals: ApprovalLedger["quarantineReleaseApprovals"];
}

export function createToolResultScreen(turn: ToolResultScreenTurn) {
  const {
    input,
    session,
    classifyAs,
    recordScreenRequest,
    enforceScreen,
    authorizeCommand,
    audit,
    quarantineReleaseApprovals,
  } = turn;
  return async ({
    tool,
    result,
    unscreenable,
    provenance,
    sourceScopeId,
    source,
  }: ToolResultScreenInput): Promise<ToolResultScreen> => {
    if (provenance !== "external") return { outcome: "allow" };
    const toolLabel = toolLabelOf(tool);
    const sourceLabel = source ? `:${source.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
    const screenChunk = classifyAs(
      { sessionId: session.id, hook: "tool_response", request: input.text, surface: toolLabel },
      recordScreenRequest,
    );
    if (!enforceScreen) {
      if (!unscreenable)
        await Promise.all(securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result).map(screenChunk));
      return { outcome: "allow" };
    }
    if (authorizeCommand(quarantineReleaseKey(tool), quarantineReleaseKey(tool))) {
      audit({
        action: "security_posture.tool_result_released",
        resource: input.surface ?? "unknown",
        status: "allowed",
        detail: JSON.stringify({ reason: "human_release", tool: toolLabel }),
      });
      return { outcome: "unscreened" };
    }
    const verdict = unscreenable
      ? undefined
      : await screenChunks(securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result), screenChunk, {
          batch: 4,
        });
    if (cleanVerdict(verdict)) return { outcome: "allow" };
    if (verdict?.decision === "strict") {
      const releaseKey = `security-screen-release:${toolLabel}`;
      if (authorizeCommand(releaseKey)) {
        audit({
          action: "security_posture.tool_result_release",
          resource: input.surface ?? "unknown",
          status: "allowed",
          detail: JSON.stringify({ reason: "human_release", tool: toolLabel }),
        });
        return { outcome: "allow" };
      }
      audit({
        action: SECURITY_TOOL_RESULT_QUARANTINE,
        resource: input.surface ?? "unknown",
        status: "refused",
        detail: JSON.stringify({
          reason: "screen_verdict",
          tool: toolLabel,
          ...(source ? { source } : {}),
          ...(verdict.reason ? { verdict: verdict.reason } : {}),
        }),
      });
      if (
        input.botActor !== true &&
        !quarantineReleaseApprovals.some(
          (qa) =>
            qa.approvalKey === releaseKey &&
            qa.screenedOutput?.text === result &&
            qa.screenedOutput?.sourceScopeId === sourceScopeId,
        )
      ) {
        quarantineReleaseApprovals.push({
          command: `release quarantined ${toolLabel} output`,
          reason: verdict.reason
            ? `security screen flagged this ${toolLabel} output: ${verdict.reason}`
            : `security screen flagged this ${toolLabel} output`,
          purpose: `Release the quarantined ${toolLabel} output into the conversation (once), or keep it blocked.`,
          summary: `Blocked content preview: ${quarantinePreview(result)}`,
          summaryDetail: quarantineFullText(result),
          ...(!toolLabel.startsWith("session_message_")
            ? {
                screenedOutput: {
                  tool: toolLabel,
                  text: result,
                  ...(sourceScopeId ? { sourceScopeId } : {}),
                },
              }
            : {}),
          approvalKey: releaseKey,
          grantModes: { session: false, always: false },
        });
      }
      return {
        outcome: "quarantine",
        approvalRequested: true,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      };
    }
    audit({
      action: "security_posture.tool_result_failed_open",
      resource: input.surface ?? "unknown",
      status: "allowed",
      detail: JSON.stringify({
        reason: unscreenable ? "unscreenable_payload" : UNSCREENED_REASON,
      }),
    });
    return { outcome: "unscreened" };
  };
}

export function createDocumentScreen(turn: {
  deps: OrchestratorDeps;
  session: Session;
  securityPolicy: InboundScreenTurn["resolution"]["securityPolicy"];
  enforceScreen: boolean;
  classifyAs: ClassifyAs;
  turnAbort: AbortController;
}) {
  const { deps, session, securityPolicy, enforceScreen, classifyAs, turnAbort } = turn;
  return async (
    documentInputs: Awaited<ReturnType<typeof loadDocumentInputs>>,
    requestText: string,
  ): Promise<boolean> => {
    let documentsUnscreened = false;
    if (securityPolicy.screening !== "off") {
      for (const document of documentInputs.documents.slice()) {
        documentsUnscreened ||= !isTextDocument(document);
        if (!(deps.securityScreener || deps.agent.screenSecurity)) {
          documentsUnscreened = true;
          continue;
        }
        let extracted: ExtractedDocumentText;
        try {
          extracted = await documentText(document, turnAbort.signal);
        } catch {
          turnAbort.signal.throwIfAborted();
          documentsUnscreened = true;
          continue;
        }
        const verdict = await screenChunks(
          securityScreenChunks("tool_result:inbound_document", extracted.text),
          classifyAs({
            sessionId: session.id,
            hook: "tool_response",
            request: requestText,
            surface: "inbound_file",
          }),
          { signal: turnAbort.signal },
        );
        if (verdict.decision === "strict") {
          documentInputs.documents.splice(documentInputs.documents.indexOf(document), 1);
          documentInputs.notices.push(`${document.name}: document withheld by the external-data security screen.`);
        } else if (verdict.unscreened || extracted.truncated) documentsUnscreened = true;
      }
    }
    return enforceScreen && documentsUnscreened;
  };
}
