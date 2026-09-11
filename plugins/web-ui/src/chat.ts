import { playgroundPath, playgroundsIn, type PlaygroundArtifact } from "./playground";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { markdown } from "./message-markdown";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Activity,
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Copy,
  FileImage,
  FileText,
  Files,
  GitFork,
  Maximize2,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plug,
  Radar,
  RefreshCw,
  Target,
  Rocket,
  ScrollText,
  Terminal,
  Wrench,
  X,
  type IconNode,
} from "lucide";
import {
  continuableMessages,
  withBase,
  type SessionPin,
  activeRunForThread,
  api,
  approvalBlocksComposer,
  createRunSlot,
  hasLiveRun,
  requestStop,
  resumeAnchor,
  runIsTerminal,
  signalLiveRun,
  attachPendingApprovals,
  entriesToMessages,
  fetchEntry,
  fetchTranscript,
  currentEarlierCount,
  forkOriginDetails,
  forkCutSeq,
  forkSession,
  inheritedRefreshEntries,
  inheritedTranscript,
  loadInheritedTranscript,
  makeCoreStreamFn,
  makeOpenerStreamFn,
  makeRunResumeStreamFn,
  resolveApproval,
  type RunPoll,
  TAIL_TURNS,
  type ApprovalDecision,
  type AssistantWork,
  type CoreSession,
  type DeliveredFile,
  type HistorySystemNote,
  type PendingApproval,
  type SessionBackgroundOutput,
  type SessionBackgroundView,
  type SessionEntry,
  type ToolActivity,
  type TurnOptions,
  userMessagesBefore,
  type WorkBlock,
  fileContentUrl,
} from "./core-bridge";
import {
  buildTimeline,
  postSpeechText,
  toolCategory,
  toolRowKind,
  toolExecutionOutput,
  type TimelineItem,
  type ToolPayload,
  type ToolRowModel,
} from "./timeline";
import { CONNECTOR_NAMES, connectorLinksIn, stripConnectorLinks, type ConnectorLink } from "./connector-link";
import { deepLinkPath, UI_BASE } from "./deep-link";
import type { ChatSurface, ConvCtx } from "./conv-types";
import { errMessage, swallow } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { splitLinks } from "./linkify";
import { escapeLoneDollars } from "./markdown-dollars";
import { slackWireToPlain, splitSlackWire, stripSlackDirectives } from "./slack-text";
import { splitStreamingMarkdown } from "./streaming-markdown";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import {
  transcriptModel,
  defaultEffortForModel,
  harnessSupportsEffort,
  harnessSupportsFastMode,
} from "./model-options";
import { browserRenderableImage, chipBadge, formatBytes, icon, relTime, waveLoader } from "./ui";
import { appState, renderSidebarTop, switchView, syncUrlFromState } from "./shell";
import { contextsState, scopeTitle } from "./contexts";
import { openProjectPage, scopeToolCount, sessionTopbarTpl, setScopedSession } from "./session-scope";
import {
  addPendingSession,
  dropPendingSession,
  groupDmTitle,
  refreshSessions,
  renderList,
  sessionsState,
  sessionSlackUrl,
  surfaceOf,
  openSession,
} from "./sessions";
import {
  backgroundLabel,
  clearWorking,
  conversationBackground,
  isAbandonedNewChat,
  markWorking,
  watchActivityLabel,
} from "./session-list";
import { liveTurnThreadRef } from "./working-dot";
import { goalElapsedLabel, goalObjectiveLabel, latestGoal } from "./goal-strip";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";
import { createForkOriginController, forkOriginView } from "./fork-origin";
import { base64ToBytes } from "./paste-text";
import { tip } from "./tooltip";
import { workSeconds, workedLabel } from "./work-duration";
import { decorateTextCodeBlocks, normalizePlainTextFences } from "./text-code";

import { createTranscriptViewport } from "./transcript-viewport";

installMarkdownSanitizer();

const detachedAgents = new WeakSet<Agent>();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
interface SettledRowKey {
  index: number;
  activity: WorkBlock["activity"] | undefined;
  status: WorkBlock["status"] | undefined;
  stale: boolean | undefined;
  deliveredFiles: unknown;
  stopReason: unknown;
  errorMessage: unknown;
  approvalDecision: unknown;
  sendFailure: unknown;
  forkable: boolean;
  speakerLabel: string | undefined;
  edited: boolean;
  deleted: boolean;
  tpl: TemplateResult | typeof nothing;
}
const settledRowCache = new WeakMap<object, SettledRowKey>();
const CHAT_CTAS = [
  "What can I help with?",
  "Ahoy, what are we after?",
  "What are we charting today?",
  "Where shall we set sail?",
  "What's the heading, captain?",
];
const CTA_INDEX_KEY = "web-ui:chat-cta";

function nextChatCta(): string {
  let index = 0;
  try {
    const stored = Number(localStorage.getItem(CTA_INDEX_KEY));
    index = (Number.isInteger(stored) ? stored + 1 : 0) % CHAT_CTAS.length;
    localStorage.setItem(CTA_INDEX_KEY, String(index));
  } catch {
    void 0;
  }
  return CHAT_CTAS[index]!;
}
const connectedConnectors = new Set<string>();
const redrawHooks = new Set<() => void>();
let proactiveOpenerStarted = false;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function markConnectorConnected(provider: string): void {
  if (!provider) return;
  connectedConnectors.add(provider);
  for (const hook of redrawHooks) hook();
}

export function createChatSurface(
  ctx: ConvCtx,
  dependencies: { fetchTranscript?: typeof fetchTranscript; openSession?: typeof openSession } = {},
): ChatSurface {
  const runSlot = createRunSlot();
  const transcriptViewport = createTranscriptViewport();
  const transcriptFetcher = dependencies.fetchTranscript ?? fetchTranscript;
  const sessionOpener = dependencies.openSession ?? openSession;

  const chatState = {
    agent: null as Agent | null,
    host: null as HTMLElement | null,
    threadRef: null as string | null,
    sessionId: null as string | null,
    scopeId: null as string | null,
    contextName: null as string | null,
    rememberedThreadRef: null as string | null,
    rememberedSessionId: null as string | null,
    rememberedScopeId: null as string | null,
    rememberedContextName: null as string | null,
    liveWork: null as WorkBlock | null,
    pendingSend: null as string | null,
    normalStreamFn: null as Agent["streamFn"] | null,
    onWork: null as ((work: WorkBlock) => void) | null,
    resolvingApprovals: new Set<string>(),
    transcriptAnchorSeq: null as number | null,
    earlierCount: 0,
    loadingEarlier: false,
    forkSession: null as CoreSession | null,
    inheritedMessages: [] as ReturnType<typeof entriesToMessages>,
    inheritedExpanded: false,
    inheritedLoaded: false,
    pins: [] as SessionPin[],
    pinsExpanded: false,
    labelSpeakers: false,
  };

  function updateSpeakerLabels(messages: AgentMessage[]): void {
    const names = new Set<string>();
    for (const m of messages) {
      const speaker = (m as { role?: string; speaker?: string }).speaker;
      if ((m as { role?: string }).role === "user" && typeof speaker === "string" && speaker.trim())
        names.add(speaker.trim());
    }
    const viewer = appState.me?.displayName?.trim().toLowerCase();
    chatState.labelSpeakers = names.size > 1 || (Boolean(viewer) && [...names].some((n) => n.toLowerCase() !== viewer));
  }

  function speakerLabelFor(message: AgentMessage): string | undefined {
    if (!chatState.labelSpeakers) return undefined;
    const speaker = (message as { speaker?: string }).speaker;
    return typeof speaker === "string" && speaker.trim() ? speaker.trim() : undefined;
  }
  let transcriptRefreshGeneration = 0;
  const forkOriginController = createForkOriginController({
    state: chatState,
    load: async () => {
      const session = chatState.forkSession;
      if (!session) return [];
      const entries = await loadInheritedTranscript(session, [], transcriptFetcher);
      return entriesToMessages(entries, transcriptModel());
    },
    navigate: async () => {
      const sourceId = chatState.forkSession?.forkedFrom?.sessionId;
      if (!sourceId) return;
      const listed = sessionsState.list.find((session) => session.id === sourceId);
      const page = await transcriptFetcher(sourceId, { tailTurns: TAIL_TURNS });
      const source = listed ?? page.session;
      if (!source) throw new Error("missing source session");
      await sessionOpener(source, Promise.resolve(page));
    },
    current: () => Boolean(chatState.forkSession && chatState.sessionId === chatState.forkSession.id),
    redraw: () => {
      if (chatState.agent) drawActiveChat();
      else readonlyRedraw?.();
    },
    setError: (error) => {
      ctx.composer.state.error = error;
    },
  });

  let ctaThreadRef: string | null | undefined;
  let ctaText = CHAT_CTAS[0]!;
  let workTicker: ReturnType<typeof setInterval> | null = null;
  let revealedTailLen = 0;
  let liveWorkExpanded = false;

  function notePendingSessionOnSend(): void {
    if (!chatState.threadRef || chatState.sessionId !== null) return;
    const existing = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
    if (existing) {
      if (chatState.agent) adoptActiveSessionFromList(chatState.agent);
      return;
    }
    addPendingSession(chatState.threadRef, chatState.scopeId, chatState.contextName);
  }

  let readOnlyView: { id: string; threadRef: string; session: CoreSession; anchorSeq: number | null } | null = null;

  function teardownActiveChat(): void {
    transcriptViewport.dispose();
    transcriptRefreshGeneration++;
    readOnlyView = null;
    preserveOutgoingWorkingDot(null);
    detachActiveAgent();
    chatState.agent = null;
    clearLiveWork();
    resetBackgroundPanel();
    chatState.host = null;
    chatState.threadRef = null;
    chatState.sessionId = null;
    chatState.scopeId = null;
    chatState.contextName = null;
    chatState.normalStreamFn = null;
    chatState.onWork = null;
    chatState.resolvingApprovals.clear();
    chatState.transcriptAnchorSeq = null;
    chatState.earlierCount = 0;
    chatState.loadingEarlier = false;
  }

  function resetChatState(): void {
    dropAbandonedNewChat(null);
    teardownActiveChat();
    proactiveOpenerStarted = false;
    chatState.rememberedThreadRef = null;
    chatState.rememberedSessionId = null;
    chatState.rememberedScopeId = null;
    chatState.rememberedContextName = null;
    connectedConnectors.clear();
  }

  function newChat(context?: { scopeId: string; name: string | null }): string {
    appState.currentView = "chats";
    renderSidebarTop();
    const user = appState.me?.user ?? "anon";
    const threadRef = `web:${user}:${crypto.randomUUID()}`;
    const carried = storedDraft(newChatDraftKey(user));
    if (carried) saveDraft(threadRef, carried);
    ctx.composer.resetComposer();
    forkOriginController.reset();
    mountContinuable(threadRef, null, context?.scopeId ?? null, [], context?.name ?? null);
    renderList();
    ctx.composer.focusComposerEnd();
    return threadRef;
  }

  function dropAbandonedNewChat(nextThreadRef: string | null): void {
    const ref = chatState.threadRef;
    if (
      isAbandonedNewChat({
        threadRef: ref,
        nextThreadRef,
        sessionId: chatState.sessionId,
        pendingSend: chatState.pendingSend,
        hasHumanMessage: (chatState.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener),
        draft: ctx.composer.state.draft || storedDraft(ref ?? ""),
        attachments: ctx.composer.state.attachments.length,
      })
    )
      dropPendingSession(ref!);
  }

  function preserveOutgoingWorkingDot(nextThreadRef: string | null): void {
    const live = liveTurnThreadRef({
      mountedThreadRef: chatState.threadRef,
      isStreaming: Boolean(chatState.agent?.state.isStreaming),
      pendingSend: chatState.pendingSend,
    });
    if (!live || live === nextThreadRef) return;
    sessionsState.list = markWorking(sessionsState.list, live);
  }

  function detachActiveAgent(): void {
    if (!chatState.agent) return;
    detachedAgents.add(chatState.agent);
    chatState.agent.abort();
  }

  function mountContinuable(
    threadRef: string,
    sessionId: string | null,
    scopeId: string | null,
    messages: ReturnType<typeof entriesToMessages>,
    contextName: string | null = null,
    session?: CoreSession,
    inheritedMessages: ReturnType<typeof entriesToMessages> = [],
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    readOnlyView = null;
    preserveOutgoingWorkingDot(threadRef);
    dropAbandonedNewChat(threadRef);
    detachActiveAgent();
    ctx.composer.resetComposer();
    forkOriginController.reset();
    chatState.threadRef = threadRef;
    chatState.sessionId = sessionId;
    chatState.scopeId = scopeId;
    chatState.contextName = contextName;
    chatState.forkSession = session ?? null;
    chatState.inheritedMessages = inheritedMessages;
    chatState.inheritedExpanded = false;
    chatState.inheritedLoaded = !session?.forkedFrom;
    chatState.rememberedThreadRef = threadRef;
    chatState.rememberedSessionId = sessionId;
    chatState.rememberedScopeId = scopeId;
    chatState.rememberedContextName = contextName;
    ctx.composer.state.draft = storedDraft(threadRef);
    syncLocation();
    chatState.transcriptAnchorSeq = null;
    chatState.earlierCount = 0;
    chatState.loadingEarlier = false;
    chatState.pins = [];
    chatState.host = document.createElement("div");
    chatState.host.className = "custom-chat";

    const model = ctx.composer.currentModelOption()?.model;
    const defaultThinkingLevel = defaultEffortForModel(model);
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        ...(model ? { model } : {}),
        ...(defaultThinkingLevel === "low" ? { thinkingLevel: "low" as const } : {}),
        messages,
        tools: [],
      },
      convertToLlm: (messages) => import("@earendil-works/pi-web-ui").then((m) => m.defaultConvertToLlm(messages)),
    });
    chatState.agent = agent;
    clearLiveWork();
    resetBackgroundPanel();
    chatState.resolvingApprovals.clear();
    const onWork = observeLiveWork(agent);
    const onSendIssues = (issues: string[], retryable: Attachment[]): void => {
      if (agent !== chatState.agent || !issues.length) return;
      ctx.composer.restageAttachments(retryable, issues.join(" "));
      drawActiveChat(agent);
    };
    const normalStreamFn = makeCoreStreamFn(threadRef, agent, currentTurnOptions, onWork, runSlot, onSendIssues);
    agent.streamFn = normalStreamFn;
    chatState.normalStreamFn = normalStreamFn;
    chatState.onWork = onWork;
    void ctx.composer.refreshRuntimeSelection(scopeId, agent);

    let listedWorking = false;
    let titlePollStarted = false;
    agent.subscribe((e) => {
      if (!titlePollStarted && agent.state.isStreaming) {
        // The server generates a title at the START of the first turn; poll for
        // it right away instead of waiting for the turn to end, so long
        // tool-heavy first turns don't leave the chat unnamed in the sidebar.
        titlePollStarted = true;
        const row = sessionsState.list.find((r) => r.threadRef === threadRef);
        if (!row?.title?.trim()) void settleNewSessionTitle(agent, threadRef);
      }
      scheduleStreamDraw(agent);
      if (agent === chatState.agent && (agent.state.isStreaming || e.type === "agent_end"))
        chatState.pendingSend = null;
      if (e.type === "agent_end" && !detachedAgents.has(agent))
        sessionsState.list = clearWorking(sessionsState.list, threadRef);
      const working = agent.state.isStreaming || chatState.pendingSend !== null;
      if (working !== listedWorking || e.type === "agent_end") {
        listedWorking = working;
        renderList();
      }
      if (e.type !== "agent_end") return;
      void agent.waitForIdle().then(async () => {
        if (agent === chatState.agent) clearLiveWork();
        const wasUnsaved = agent === chatState.agent && chatState.sessionId === null;
        try {
          await refreshSessions({ silent: true });
        } catch {
          void 0;
        }
        if (!detachedAgents.has(agent)) {
          sessionsState.list = clearWorking(sessionsState.list, threadRef);
          renderList();
        }
        if (agent !== chatState.agent) return;
        adoptActiveSessionFromList(agent);
        await refreshTranscriptFromEntries(agent);
        void followNextQueuedRun(agent, threadRef, normalStreamFn, onWork);
        if (wasUnsaved && chatState.sessionId) void settleNewSessionTitle(agent, threadRef);
      });
    });

    container.replaceChildren(chatState.host);
    const opening = startProactiveOpenerIfNew(agent, threadRef, normalStreamFn, onWork, sessionId, scopeId, messages);
    drawActiveChat(agent, { forceScroll: true });
    ctx.composer.focusComposerEnd();
    ctx.ensureDeliveryStream();
    if (!opening) void resumeTrackedRun(agent, threadRef, normalStreamFn, onWork);
    consumeBackgroundPanelRequest();
  }

  function startProactiveOpenerIfNew(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    sessionId: string | null,
    scopeId: string | null,
    messages: ReturnType<typeof entriesToMessages>,
  ): boolean {
    if (ctx.pane) return false;
    if (proactiveOpenerStarted || sessionId !== null || scopeId !== null || messages.length > 0) return false;
    if (!sessionsState.loaded) return false;
    if (sessionsState.list.some((s) => s.id)) return false;
    proactiveOpenerStarted = true;
    agent.state.messages = [{ role: "user", content: "", opener: true } as unknown as AgentMessage];
    agent.streamFn = makeOpenerStreamFn(threadRef, agent, currentTurnOptions, onWork, runSlot);
    void (async () => {
      try {
        await agent.continue();
      } catch (err) {
        if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not start the conversation.");
      } finally {
        if (agent === chatState.agent) {
          agent.streamFn = normalStreamFn;
          const last = agent.state.messages[agent.state.messages.length - 1] as AssistantMessage | undefined;
          if (
            last?.role === "assistant" &&
            (last.stopReason === "error" || last.stopReason === "aborted") &&
            !messageText(last).trim()
          ) {
            agent.state.messages = [];
          }
          drawActiveChat(agent);
        }
      }
    })();
    return true;
  }

  function currentTurnOptions(): TurnOptions {
    const selected = ctx.composer.currentModelOption();
    if (!selected) throw new Error("No model is available");
    const harness = selected.harnessId;
    return {
      ...(harnessSupportsEffort(harness) ? { effortLevel: ctx.composer.state.effortLevel } : {}),
      ...(harnessSupportsFastMode(harness) ? { fastMode: ctx.composer.state.fastMode } : {}),
      harness,
      scopeId: chatState.scopeId,
      channelName: chatState.contextName,
    };
  }

  function inheritedHeader(): TemplateResult | typeof nothing {
    const origin = chatState.forkSession
      ? forkOriginDetails(chatState.forkSession, chatState.inheritedLoaded ? chatState.inheritedMessages.length : 0)
      : null;
    return forkOriginView(
      origin
        ? {
            title: origin.title,
            messageCount: origin.messageCount,
            expanded: chatState.inheritedExpanded,
            icon: icon(GitFork, 14),
            navigate: () => void forkOriginController.navigate(),
            toggle: () => void forkOriginController.toggle().catch(() => {}),
          }
        : null,
    );
  }

  function onDelivery(threadRef: string): void {
    const ro = readOnlyView;
    if (ro && threadRef === ro.threadRef) {
      void fetchTranscript(ro.id, ro.anchorSeq !== null ? { sinceSeq: ro.anchorSeq } : { tailTurns: TAIL_TURNS })
        .then((page) => {
          if (readOnlyView?.id !== ro.id) return;
          const split = inheritedTranscript(ro.session, page.entries ?? []);
          const rawEarlier = page.earlierEntries ?? 0;
          const earlier = currentEarlierCount(ro.session, rawEarlier);
          mountReadOnly(
            readOnlyView.session,
            entriesToMessages(split.current, transcriptModel()),
            earlier,
            rawEarlier > 0 ? (page.entries?.[0]?.seq ?? null) : null,
            entriesToMessages(split.inherited, transcriptModel()),
          );
        })
        .catch(() => {});
      return;
    }
    const agent = chatState.agent;
    if (!agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    void refreshTranscriptFromEntries(agent);
  }

  async function stopLiveRun(): Promise<void> {
    if (!hasLiveRun(runSlot)) {
      requestStop(runSlot);
      return;
    }
    const agent = chatState.agent;
    const revealUnstoppedRun = (): void => {
      runSlot.unreachedAbort = true;
      if (agent && agent === chatState.agent && !agent.state.isStreaming) void refreshTranscriptFromEntries(agent);
    };
    try {
      const outcome = await signalLiveRun(runSlot, "abort", undefined, { threadRef: chatState.threadRef });
      if (!outcome.ok) revealUnstoppedRun();
    } catch (err) {
      revealUnstoppedRun();
      throw err;
    }
  }

  function resumeIfIdle(): void {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming || !chatState.threadRef || !chatState.normalStreamFn || !chatState.onWork)
      return;
    void resumeTrackedRun(agent, chatState.threadRef, chatState.normalStreamFn, chatState.onWork);
  }

  function syncLocation(): void {
    if (ctx.ownsUrl) syncUrlFromState();
    else postCurrentPaneState();
  }

  function redrawForConnector(): void {
    if (chatState.agent) drawActiveChat();
  }

  function dispose(): void {
    redrawHooks.delete(redrawForConnector);
    teardownActiveChat();
  }

  async function approveCommand(agent: Agent, decision: ApprovalDecision): Promise<void> {
    if (agent !== chatState.agent || !chatState.threadRef || agent.state.isStreaming) return;
    if (chatState.resolvingApprovals.size > 0) return;
    chatState.resolvingApprovals.add(decision.requestId);
    let resolving = true;
    const releaseSubmission = (): void => {
      if (!resolving) return;
      resolving = false;
      if (agent === chatState.agent) chatState.resolvingApprovals.delete(decision.requestId);
    };
    ctx.composer.state.error = "";
    drawActiveChat(agent);
    try {
      const threadRef = chatState.threadRef;
      const runId = await resolveApproval(decision);
      if (chatState.normalStreamFn && chatState.onWork)
        await resumeRun(agent, threadRef, chatState.normalStreamFn, chatState.onWork, runId, undefined, () => {
          releaseSubmission();
          drawActiveChat(agent);
        });
    } catch (err) {
      if (agent === chatState.agent) {
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
        drawActiveChat(agent);
      }
    } finally {
      releaseSubmission();
      if (agent === chatState.agent) {
        clearLiveWork();
        try {
          await refreshSessions({ silent: true });
        } catch {
          void 0;
        }
        await refreshTranscriptFromEntries(agent);
      }
      const active = chatState.agent;
      if (active) {
        await active.waitForIdle();
        await syncPendingApprovals(active);
        drawActiveChat(active);
      }
    }
  }

  function resolveCommandApproval(decision: ApprovalDecision): void {
    const agent = chatState.agent;
    if (agent) void approveCommand(agent, decision);
  }

  function activePendingApprovals(): PendingApproval[] {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming) return [];
    const byId = new Map<string, PendingApproval>();
    for (const m of agent.state.messages) {
      if ((m as { role?: string }).role !== "assistant") continue;
      for (const approval of (m as AssistantWork).work?.pendingApprovals ?? []) {
        if (!chatState.resolvingApprovals.has(approval.requestId)) byId.set(approval.requestId, approval);
      }
    }
    return [...byId.values()];
  }

  function hasUnresolvedApproval(): boolean {
    return activePendingApprovals().some(approvalBlocksComposer);
  }

  async function syncPendingApprovals(agent: Agent, messages = agent.state.messages): Promise<void> {
    const id = chatState.sessionId;
    if (!id || agent !== chatState.agent) return;
    const r = await api<{ approvals: PendingApproval[] }>(`/api/sessions/${encodeURIComponent(id)}/approvals`).catch(
      () => null,
    );
    if (!r || id !== chatState.sessionId || agent !== chatState.agent) return;
    for (const message of messages) delete (message as AssistantWork).work?.pendingApprovals;
    attachPendingApprovals(messages, r.approvals ?? [], transcriptModel());
  }

  async function refreshTranscriptFromEntries(agent: Agent): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || agent !== chatState.agent || agent.state.isStreaming) return drawActiveChat(agent);
    const generation = ++transcriptRefreshGeneration;
    const last = agent.state.messages[agent.state.messages.length - 1] as { stopReason?: string } | undefined;
    if (last?.stopReason === "error") return drawActiveChat(agent);
    if (last?.stopReason === "aborted" && !runSlot.unreachedAbort) return drawActiveChat(agent);
    try {
      const anchor = chatState.transcriptAnchorSeq;
      const page = await transcriptFetcher(sessionId, anchor !== null ? { sinceSeq: anchor } : undefined);
      if (
        generation !== transcriptRefreshGeneration ||
        sessionId !== chatState.sessionId ||
        agent !== chatState.agent ||
        agent.state.isStreaming
      )
        return;
      chatState.pins = page.pins ?? [];
      const split = inheritedTranscript(chatState.forkSession ?? {}, page.entries ?? []);
      const messages = entriesToMessages(split.current, transcriptModel());
      const refreshedInherited = inheritedRefreshEntries(
        chatState.forkSession ?? {},
        page.entries ?? [],
        chatState.inheritedLoaded,
      );
      await syncPendingApprovals(agent, messages);
      if (
        generation !== transcriptRefreshGeneration ||
        sessionId !== chatState.sessionId ||
        agent !== chatState.agent ||
        agent.state.isStreaming
      )
        return;
      if (refreshedInherited) chatState.inheritedMessages = entriesToMessages(refreshedInherited, transcriptModel());
      agent.state.messages = messages;
      runSlot.unreachedAbort = false;
      const rawEarlier = page.earlierEntries ?? 0;
      chatState.earlierCount = currentEarlierCount(chatState.forkSession ?? {}, rawEarlier);
      chatState.transcriptAnchorSeq = rawEarlier > 0 ? (page.entries?.[0]?.seq ?? null) : null;
    } catch {
      void 0;
    }
    drawActiveChat(agent);
  }

  function observeLiveWork(agent: Agent): (work: WorkBlock) => void {
    return (work: WorkBlock) => {
      if (agent !== chatState.agent) return;
      chatState.liveWork = work;
      syncWorkTicker();
      drawActiveChat(agent);
    };
  }

  async function followNextQueuedRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
  ): Promise<void> {
    let active: Awaited<ReturnType<typeof activeRunForThread>>;
    try {
      active = await activeRunForThread(threadRef);
    } catch {
      return;
    }
    if (agent !== chatState.agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    const next = ctx.composer.queuedRunsFor(threadRef).find((r) => r.runId === active.runId);
    ctx.composer.setQueuedRuns(threadRef, active.queued);
    if (!active.runId || !active.run || runIsTerminal(active.run)) return drawActiveChat(agent);
    const recorded = (agent.state.messages.at(-1) as { role?: string } | undefined)?.role === "user";
    if (!recorded && !next) agent.state.messages = [...agent.state.messages, resumeAnchor()];
    agent.streamFn = makeRunResumeStreamFn(active.runId, active.run, onWork, runSlot);
    try {
      await (next && !recorded ? agent.prompt(next.text) : agent.continue());
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not follow the queued message.");
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromEntries(agent);
      }
    }
  }

  async function resumeTrackedRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
  ): Promise<boolean> {
    let activeRun: Awaited<ReturnType<typeof activeRunForThread>>;
    try {
      activeRun = await activeRunForThread(threadRef);
    } catch {
      return false;
    }
    if (agent === chatState.agent && threadRef === chatState.threadRef)
      ctx.composer.setQueuedRuns(threadRef, activeRun.queued);
    if (!activeRun.runId || !activeRun.run || runIsTerminal(activeRun.run)) return false;
    return resumeRun(agent, threadRef, normalStreamFn, onWork, activeRun.runId, activeRun.run);
  }

  async function resumeRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    runId: string,
    initialRun?: RunPoll,
    onStarted?: () => void,
  ): Promise<boolean> {
    if (agent !== chatState.agent || appState.currentView !== "chats" || agent.state.isStreaming) return false;
    // Pull the transcript before attaching so the turn's triggering user message
    // (written by core, not by this tab) is on screen while the run streams.
    await refreshTranscriptFromEntries(agent);
    if (agent !== chatState.agent || agent.state.isStreaming) return false;
    const { messages: msgs, popped } = continuableMessages(agent.state.messages);
    agent.state.messages = msgs;
    // Seed the resumed stream with the assistant text we just removed so the
    // model's already-visible words (e.g. its opening ack) don't blink out
    // while we re-attach to the live run.
    const seedText = popped
      .map((m) => messageText(m).trim())
      .filter(Boolean)
      .join("\n\n");
    agent.streamFn = makeRunResumeStreamFn(runId, initialRun, onWork, runSlot, seedText);
    try {
      const completion = agent.continue();
      if (agent.state.isStreaming) onStarted?.();
      await completion;
    } catch (err) {
      if (agent === chatState.agent)
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not reconnect to the running task.";
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromEntries(agent);
      }
    }
    return true;
  }

  function adoptActiveSessionFromList(agent: Agent): void {
    if (agent !== chatState.agent || chatState.sessionId !== null || chatState.threadRef === null) return;
    const match = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
    if (!match) return;
    chatState.sessionId = match.id;
    chatState.scopeId = match.scopeId;
    if (match.channelName) chatState.contextName = match.channelName;
    chatState.rememberedSessionId = match.id;
    chatState.rememberedScopeId = match.scopeId;
    chatState.rememberedContextName = chatState.contextName;
    syncLocation();
    renderList();
    drawActiveChat(agent);
  }

  function postCurrentPaneState(): void {
    if (!ctx.pane) return;
    const live = liveTurnThreadRef({
      mountedThreadRef: chatState.threadRef,
      isStreaming: Boolean(chatState.agent?.state.isStreaming),
      pendingSend: chatState.pendingSend,
    });
    ctx.onState?.({
      threadRef: chatState.threadRef ?? chatState.rememberedThreadRef,
      sessionId: chatState.sessionId ?? chatState.rememberedSessionId,
      working: live !== null,
    });
  }

  async function settleNewSessionTitle(agent: Agent, threadRef: string): Promise<void> {
    const titled = (): boolean => {
      const s = sessionsState.list.find((row) => row.threadRef === threadRef);
      return Boolean(s?.title && s.title.trim());
    };
    if (titled()) return;
    for (const delay of [1200, 1800, 2400, 3600, 4800, 6400, 8000, 8000]) {
      await sleep(delay);
      if (agent !== chatState.agent || chatState.threadRef !== threadRef) return;
      try {
        await refreshSessions({ silent: true });
      } catch {
        void 0;
      }
      if (titled()) return;
    }
  }

  function mountLoadingPane(): void {
    const container = ctx.container();
    if (!container || !ctx.visible()) return;
    const host = document.createElement("div");
    host.className = "custom-chat";
    render(
      html`<div class="custom-chat-shell">
        <div class="chat-loading">${waveLoader()}</div>
      </div>`,
      host,
    );
    container.replaceChildren(host);
  }

  function mountReadOnly(
    s: CoreSession,
    messages: ReturnType<typeof entriesToMessages>,
    earlierCount = 0,
    anchorSeq: number | null = null,
    inheritedMessages: ReturnType<typeof entriesToMessages> = [],
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    preserveOutgoingWorkingDot(s.threadRef);
    dropAbandonedNewChat(s.threadRef);
    detachActiveAgent();
    chatState.agent = null;
    clearLiveWork();
    chatState.host = null;
    ctx.composer.resetComposer();
    const sameSession = chatState.sessionId === s.id && chatState.threadRef === null;
    if (!sameSession) forkOriginController.reset();
    chatState.threadRef = null;
    chatState.sessionId = s.id;
    chatState.scopeId = s.scopeId;
    chatState.forkSession = s;
    if (!(sameSession && chatState.inheritedLoaded)) {
      chatState.inheritedMessages = inheritedMessages;
      chatState.inheritedLoaded = !s.forkedFrom;
    }
    if (!sameSession) {
      chatState.inheritedExpanded = false;
      chatState.pins = [];
    }
    syncLocation();

    resetBackgroundPanel();
    const host = document.createElement("div");
    host.className = "custom-chat readonly-chat";
    const draw = () => {
      const shownMessages = chatState.inheritedExpanded ? [...chatState.inheritedMessages, ...messages] : messages;
      updateSpeakerLabels(shownMessages);
      render(
        html`
          <div class="custom-chat-shell">
            ${chatHeader(groupDmTitle(s), surfaceOf(s), true)}
            <div class="readonly-banner">
              ${
                surfaceOf(s) === "slack"
                  ? html`This conversation lives in Slack. Replies happen
                    there.${
                      sessionSlackUrl(s)
                        ? html` <a
                            class="readonly-banner-link"
                            href=${sessionSlackUrl(s)!}
                            target="_blank"
                            rel="noreferrer"
                            >Open in Slack</a
                          >`
                        : nothing
                    }`
                  : "This conversation is read-only here."
              }
            </div>
            ${backgroundActivityStrip()}
            <section class="chat-scroll readonly-scroll">
              ${pinnedStrip()}
              <div class="message-stack">
                ${inheritedHeader()}
                ${
                  earlierCount > 0
                    ? html`<div class="earlier-messages">
                        <button
                          class="earlier-messages-btn"
                          @click=${async (e: Event) => {
                            const btn = e.currentTarget as HTMLButtonElement;
                            btn.disabled = true;
                            btn.textContent = "Loading earlier messages\u2026";
                            try {
                              const page = await fetchTranscript(
                                s.id,
                                anchorSeq !== null ? { beforeSeq: anchorSeq, tailTurns: TAIL_TURNS } : undefined,
                              );
                              if (chatState.sessionId !== s.id) return;
                              const scroller = container?.querySelector<HTMLElement>(".chat-scroll");
                              const priorHeight = scroller?.scrollHeight ?? 0;
                              const priorTop = scroller?.scrollTop ?? 0;
                              const rawRemaining = page.earlierEntries ?? 0;
                              const remaining = currentEarlierCount(s, rawRemaining);
                              const split = inheritedTranscript(s, page.entries ?? []);
                              mountReadOnly(
                                s,
                                [...entriesToMessages(split.current, transcriptModel()), ...messages],
                                remaining,
                                rawRemaining > 0 ? (page.entries?.[0]?.seq ?? null) : null,
                                [
                                  ...entriesToMessages(split.inherited, transcriptModel()),
                                  ...chatState.inheritedMessages,
                                ],
                              );
                              requestAnimationFrame(() => {
                                const scrollerNow = container?.querySelector<HTMLElement>(".chat-scroll");
                                if (!scrollerNow) return;
                                const prev = scrollerNow.style.scrollBehavior;
                                scrollerNow.style.scrollBehavior = "auto";
                                scrollerNow.scrollTop = priorTop + (scrollerNow.scrollHeight - priorHeight);
                                scrollerNow.style.scrollBehavior = prev;
                              });
                            } catch {
                              btn.disabled = false;
                              btn.textContent = "Show earlier messages";
                            }
                          }}
                        >
                          Show earlier messages
                        </button>
                      </div>`
                    : nothing
                }
                ${
                  shownMessages.length
                    ? shownMessages.map((m, i) => chatMessage(m, i))
                    : html`<div class="empty compact">No readable messages in this conversation.</div>`
                }
                ${ctx.composer.state.error ? html`<div class="composer-error inline">${ctx.composer.state.error}</div>` : nothing}
              </div>
            </section>
          </div>
        `,
        host,
      );
      requestAnimationFrame(() => {
        decorateTextCodeBlocks(host);
        if (host.isConnected) transcriptViewport.sync(host.querySelector<HTMLElement>(".chat-scroll"));
      });
    };
    readonlyRedraw = draw;
    draw();
    container.replaceChildren(host);
    if (!sameSession) scrollToBottom();
    readOnlyView = { id: s.id, threadRef: s.threadRef, session: s, anchorSeq };
    ctx.ensureDeliveryStream();
    consumeBackgroundPanelRequest();
  }

  function welcomeGreeting(): TemplateResult {
    return html`
      <article class="message-row assistant-row welcome-greeting">
        <div class="assistant-body">
          <div class="streaming-text">
            ${markdown(
              "Hi, I'm your AI teammate 👋\n\n" +
                "I run tasks on a computer of my own and work across your connected tools (Slack, Google Workspace, GitHub, Linear, and the open web), and I remember what we work on together.\n\n" +
                "Want to get set up? Tell me your name and what you're working on, and I'll take it from there, or just ask me anything to dive straight in.",
            )}
          </div>
        </div>
      </article>
    `;
  }

  function setPins(pins: SessionPin[]): void {
    chatState.pins = pins;
    if (chatState.agent) drawActiveChat(chatState.agent);
    else readonlyRedraw?.();
  }

  function togglePins(): void {
    chatState.pinsExpanded = !chatState.pinsExpanded;
    if (chatState.agent) drawActiveChat(chatState.agent);
    else readonlyRedraw?.();
  }

  function linkifiedText(text: string): TemplateResult {
    return html`${splitLinks(text).map((seg) =>
      seg.kind === "link"
        ? html`<a href=${seg.href} target="_blank" rel="noreferrer noopener" @click=${(e: Event) => e.stopPropagation()}
            >${seg.href}</a
          >`
        : seg.text,
    )}`;
  }

  function pinnedStrip(): TemplateResult | typeof nothing {
    const pins = chatState.pins;
    if (!pins.length) return nothing;
    const expanded = chatState.pinsExpanded;
    const first = pins[0]!;
    return html`<div class="pinned-strip ${expanded ? "expanded" : "collapsed"}">
      <div class="pinned-strip-head" @click=${togglePins}>
        ${icon(Pin, 13)}<span class="pinned-strip-count">${pins.length}</span>
        ${
          expanded
            ? html`<span class="pinned-strip-label">Pinned</span>`
            : html`<span class="pinned-strip-peek"
                >${linkifiedText(first.text ?? first.preview ?? `entry #${first.entrySeq}`)}</span
              >`
        }
        <button class="pinned-strip-toggle" aria-expanded=${expanded} title=${expanded ? "Collapse pins" : "Show pins"}>
          ${icon(expanded ? ChevronUp : ChevronDown, 13)}
        </button>
      </div>
      ${
        expanded
          ? pins.map(
              (p) =>
                html`<div class="pinned-item" title=${p.text ?? p.preview ?? ""}>
                  <span class="pinned-item-text">${linkifiedText(p.text ?? p.preview ?? `entry #${p.entrySeq}`)}</span>
                  ${p.text && p.preview ? html`<span class="pinned-item-preview">${linkifiedText(p.preview)}</span>` : nothing}
                </div>`,
            )
          : nothing
      }
    </div>`;
  }

  function chatCta(): string {
    if (chatState.threadRef !== ctaThreadRef) {
      ctaThreadRef = chatState.threadRef;
      ctaText = nextChatCta();
    }
    return ctaText;
  }

  function setTranscriptWindow(anchorSeq: number | null, earlierCount: number, hasEarlier = earlierCount > 0): void {
    chatState.transcriptAnchorSeq = hasEarlier ? anchorSeq : null;
    chatState.earlierCount = earlierCount;
    if (chatState.agent) drawActiveChat(chatState.agent);
  }

  function earlierNotice(agent: Agent): TemplateResult {
    return html`<div class="earlier-messages">
      <button
        class="earlier-messages-btn"
        ?disabled=${chatState.loadingEarlier || agent.state.isStreaming}
        @click=${() => void loadEarlierMessages()}
      >
        ${chatState.loadingEarlier ? "Loading earlier messages…" : "Show earlier messages"}
      </button>
    </div>`;
  }

  async function loadEarlierMessages(): Promise<void> {
    const agent = chatState.agent;
    const sessionId = chatState.sessionId;
    const anchor = chatState.transcriptAnchorSeq;
    if (!agent || !sessionId || anchor === null || chatState.loadingEarlier || agent.state.isStreaming) return;
    chatState.loadingEarlier = true;
    drawActiveChat(agent);
    try {
      const page = await fetchTranscript(sessionId, { beforeSeq: anchor, tailTurns: TAIL_TURNS });
      if (agent !== chatState.agent || agent.state.isStreaming) return;
      const split = inheritedTranscript(chatState.forkSession ?? {}, page.entries ?? []);
      const earlierMessages = entriesToMessages(split.current, transcriptModel());
      if (!chatState.inheritedLoaded)
        chatState.inheritedMessages = [
          ...entriesToMessages(split.inherited, transcriptModel()),
          ...chatState.inheritedMessages,
        ];
      const scroller = chatState.host?.querySelector<HTMLElement>(".chat-scroll");
      const priorHeight = scroller?.scrollHeight ?? 0;
      const priorTop = scroller?.scrollTop ?? 0;
      agent.state.messages = [...earlierMessages, ...agent.state.messages];
      const rawRemaining = page.earlierEntries ?? 0;
      chatState.transcriptAnchorSeq = rawRemaining > 0 ? (page.entries?.[0]?.seq ?? null) : null;
      chatState.earlierCount = currentEarlierCount(chatState.forkSession ?? {}, rawRemaining);
      chatState.loadingEarlier = false;
      drawActiveChat(agent);
      requestAnimationFrame(() => {
        const scrollerNow = chatState.host?.querySelector<HTMLElement>(".chat-scroll");
        if (!scrollerNow) return;
        const prev = scrollerNow.style.scrollBehavior;
        scrollerNow.style.scrollBehavior = "auto";
        scrollerNow.scrollTop = priorTop + (scrollerNow.scrollHeight - priorHeight);
        scrollerNow.style.scrollBehavior = prev;
      });
    } catch {
      void 0;
    } finally {
      if (chatState.loadingEarlier) {
        chatState.loadingEarlier = false;
        if (agent === chatState.agent) drawActiveChat(agent);
      }
    }
  }

  let streamDrawScheduled = false;
  let streamDrawAgent: Agent | null = null;
  function scheduleStreamDraw(agent: Agent): void {
    streamDrawAgent = agent;
    if (streamDrawScheduled) return;
    streamDrawScheduled = true;
    requestAnimationFrame(() => {
      streamDrawScheduled = false;
      const target = streamDrawAgent;
      streamDrawAgent = null;
      if (target) drawActiveChat(target);
    });
  }

  function paneGlance(agent: Agent, messages: AgentMessage[], tier: "card" | "strip"): TemplateResult {
    const now = paneNowLine(agent);
    const last = [...messages].reverse().find((m) => m.role === "assistant" && messageText(m).trim());
    const snippet = last ? messageText(last).trim() : "";
    if (tier === "strip") {
      return html`
        <button type="button" class="pane-strip" ${tip("Expand this pane")} @click=${() => ctx.onExpand?.()}>
          <span class="pane-strip-text" dir="auto">${now ?? snippet}</span>
          ${icon(Maximize2, 13)}
        </button>
      `;
    }
    return html`
      <section class="pane-card" aria-live="polite">
        ${now ? html`<div class="pane-card-now"><span class="pane-card-now-label">Now</span><span class="pane-card-now-text" dir="auto">${now}</span></div>` : nothing}
        ${snippet ? html`<div class="pane-card-last" dir="auto">${snippet}</div>` : nothing}
      </section>
    `;
  }

  function paneNowLine(agent: Agent): string | null {
    if (activePendingApprovals().length) return "Needs your approval";
    if (agent.state.isStreaming || chatState.resolvingApprovals.size > 0) {
      const work = chatState.liveWork ?? { status: "thinking", activity: [] };
      const summary = liveWorkSummary(work);
      if (!summary) return "Thinking…";
      return summary.detail ? `${summary.label}: ${summary.detail}` : summary.label;
    }
    return null;
  }

  ctx.onDensityChange(() => drawActiveChat());

  function drawActiveChat(agent = chatState.agent, opts: { forceScroll?: boolean } = {}): void {
    if (!agent || agent !== chatState.agent || !chatState.host || appState.currentView !== "chats") return;
    const currentMessages = visibleMessages(agent);
    const messages = chatState.inheritedExpanded
      ? [...chatState.inheritedMessages, ...currentMessages]
      : currentMessages;
    updateSpeakerLabels(messages);
    const isNewUser = sessionsState.list.filter((s) => s.id).length === 0;
    let messageContent: Array<TemplateResult | typeof nothing> | TemplateResult | typeof nothing = nothing;
    const inheritedOffset = chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0;
    if (messages.length) {
      messageContent = messages.map((m, i) =>
        settledChatMessage(m, i - inheritedOffset, agent.state.isStreaming && m === agent.state.streamingMessage),
      );
    } else if (isNewUser) {
      messageContent = welcomeGreeting();
    }
    const tier = ctx.density();
    const glanceTier = tier === "card" || tier === "strip" ? tier : null;
    const emptyChat = !messages.length && !chatState.forkSession;
    render(
      html`
        <div
          class="custom-chat-shell ${ctx.pane ? "in-pane" : ""} ${ctx.composer.state.dragging ? "dragging" : ""} ${
            emptyChat && !glanceTier ? "empty-chat" : ""
          }"
          @dragenter=${(e: DragEvent) => ctx.composer.onDragEnter(e)}
          @dragover=${(e: DragEvent) => ctx.composer.onDragOver(e)}
          @dragleave=${(e: DragEvent) => ctx.composer.onDragLeave(e)}
          @drop=${(e: DragEvent) => void ctx.composer.onDrop(e, agent)}
        >
          ${
            ctx.composer.state.dragging
              ? html`<div class="drop-overlay">
                  <div class="drop-overlay-card">${icon(Files, 30)}<span>Drop files or folders to attach</span></div>
                </div>`
              : nothing
          }
          ${glanceTier || ctx.pane ? nothing : sessionTopbar()}
          ${glanceTier ? paneGlance(agent, messages, glanceTier) : nothing}
          <section class="chat-scroll">
            ${pinnedStrip()}
            <div class="message-stack ${emptyChat ? "empty-stack" : ""}">
              ${inheritedHeader()} ${chatState.earlierCount > 0 ? earlierNotice(agent) : nothing} ${messageContent}
              ${emptyChat ? html`<h1 class="chat-cta">${chatCta()}</h1>` : nothing}
              ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}
            </div>
          </section>
          <div class="chat-bottom-dock">
            ${goalStrip(agent)} ${ctx.composer.queuedStrip(agent)}
            ${ctx.composer.composerForm(agent, html`${glanceTier ? nothing : liveWorkStatus(agent)} ${backgroundActivityStrip()}`)}
          </div>
        </div>
      `,
      chatState.host,
    );
    decorateStreamingTail();
    requestAnimationFrame(() => decorateTextCodeBlocks(chatState.host));
    ctx.composer.resizeComposer();
    scrollTranscript(opts.forceScroll);
    postCurrentPaneState();
  }

  function decorateStreamingTail(): void {
    const blocks = chatState.host?.querySelectorAll<HTMLElement>(".streaming-text.live-stream markdown-block");
    const block = blocks?.length ? blocks[blocks.length - 1] : undefined;
    if (!block) {
      revealedTailLen = 0;
      return;
    }
    if (reduceMotion.matches) return;
    const fullLen = (block.textContent ?? "").replace(/\s+$/u, "").length;
    const grown = fullLen - revealedTailLen;
    revealedTailLen = fullLen;
    if (grown <= 0 || grown > 240) return;
    const last = lastTextNode(block);
    if (!last || !last.textContent) return;
    const visibleEnd = last.textContent.replace(/\s+$/u, "").length;
    const n = Math.min(grown, visibleEnd);
    if (n <= 0) return;
    const tail = last.splitText(visibleEnd - n);
    if (tail.textContent && tail.textContent.length > n) tail.splitText(n);
    const parent = tail.parentNode;
    if (!parent) return;
    const span = document.createElement("span");
    span.className = "tok-in";
    parent.insertBefore(span, tail);
    span.appendChild(tail);
  }

  function lastTextNode(el: Node): Text | null {
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const child = el.childNodes[i]!;
      if (child.nodeType === Node.TEXT_NODE && /\S/u.test(child.textContent ?? "")) return child as Text;
      const deep = lastTextNode(child);
      if (deep) return deep;
    }
    return null;
  }

  function sessionTopbar(): TemplateResult {
    const scope = chatState.scopeId;
    const session = sessionsState.list.find((s) =>
      chatState.sessionId
        ? s.id === chatState.sessionId
        : Boolean(chatState.threadRef) && s.threadRef === chatState.threadRef,
    );
    const title = session?.title?.trim() ?? "";
    const crumb = scope && !scope.startsWith("personal:") ? scopeTitle(scope, chatState.contextName) : null;
    const forkedFrom =
      chatState.forkSession && chatState.sessionId === chatState.forkSession.id
        ? chatState.forkSession.forkedFrom
        : undefined;
    return sessionTopbarTpl({
      sessionId: chatState.sessionId ?? session?.id,
      crumb,
      title,
      fork: forkedFrom
        ? {
            title: forkedFrom.title?.trim() || "another conversation",
            onClick: () => void forkOriginController.navigate(),
          }
        : null,
      onCrumb: crumb && scope ? () => openProjectPage(scope) : null,
      toolCount: scope ? (t) => scopeToolCount(t, scope, () => drawActiveChat()) : null,
      onTool: (tool) => {
        setScopedSession({
          scopeId: scope ?? "",
          sessionId: chatState.sessionId,
          threadRef: chatState.threadRef,
          title: title || "New chat",
          crumb,
        });
        if (scope && (tool === "crons" || tool === "files" || tool === "apps")) contextsState.selected = scope;
        switchView(tool === "apps" ? "deploys" : tool);
      },
    });
  }

  function chatHeader(title: string | TemplateResult, detail: string, readOnly: boolean): TemplateResult {
    return html`
      <header class="chat-topbar">
        <div class="chat-heading">
          <div class="chat-title" dir="auto">${title}</div>
          <div class="chat-subtitle">${readOnly ? "Read-only" : detail}</div>
        </div>
      </header>
    `;
  }

  async function retryFailedSend(message: AgentMessage, index: number): Promise<void> {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming || agent.state.messages[index] !== message) return;
    const failed = message as AgentMessage & { sendFailure?: string };
    const error = agent.state.messages[index + 1] as AssistantWork | undefined;
    if (!failed.sendFailure || !error?.retryableSend) return;
    delete failed.sendFailure;
    agent.state.messages = agent.state.messages.filter((_, current) => current !== index + 1);
    ctx.composer.state.error = "";
    drawActiveChat(agent);
    try {
      await agent.continue();
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not retry the message.");
    }
  }

  function visibleMessages(agent: Agent): AgentMessage[] {
    const out = [...agent.state.messages];
    if (agent.state.streamingMessage) out.push(agent.state.streamingMessage);
    return out;
  }

  function settledChatMessage(
    message: AgentMessage,
    index: number,
    isStreaming: boolean,
  ): TemplateResult | typeof nothing {
    const msg = message as AssistantWork & {
      stopReason?: string;
      errorMessage?: string;
      approvalDecision?: string;
      sendFailure?: string;
    };
    const work = msg.work;
    const cacheable =
      !isStreaming &&
      (!work || ((work.status === "complete" || work.status === "failed") && !work.pendingApprovals?.length));
    if (!cacheable) return chatMessage(message, index, isStreaming);
    const forkable = Boolean(chatState.threadRef && chatState.sessionId && chatState.agent);
    const speakerLabel = speakerLabelFor(message);
    const edited = Boolean((message as { edited?: boolean }).edited);
    const deleted = Boolean((message as { deleted?: boolean }).deleted);
    const hit = settledRowCache.get(message as object);
    if (
      hit &&
      hit.index === index &&
      hit.activity === work?.activity &&
      hit.status === work?.status &&
      hit.stale === work?.stale &&
      hit.deliveredFiles === msg.deliveredFiles &&
      hit.stopReason === msg.stopReason &&
      hit.errorMessage === msg.errorMessage &&
      hit.approvalDecision === msg.approvalDecision &&
      hit.sendFailure === msg.sendFailure &&
      hit.forkable === forkable &&
      hit.speakerLabel === speakerLabel &&
      hit.edited === edited &&
      hit.deleted === deleted
    ) {
      return hit.tpl;
    }
    const tpl = chatMessage(message, index, isStreaming);
    settledRowCache.set(message as object, {
      index,
      activity: work?.activity,
      status: work?.status,
      stale: work?.stale,
      deliveredFiles: msg.deliveredFiles,
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage,
      approvalDecision: msg.approvalDecision,
      sendFailure: msg.sendFailure,
      forkable,
      speakerLabel,
      edited,
      deleted,
      tpl,
    });
    return tpl;
  }

  function chatMessage(message: AgentMessage, index: number, isStreaming = false): TemplateResult | typeof nothing {
    const hidden = message as { opener?: boolean; resumeAnchor?: boolean };
    if (hidden.opener || hidden.resumeAnchor) return nothing;
    const role = (message as { role?: string }).role;
    if (role === "user" || role === "user-with-attachments") {
      const attachments = ((message as UserMessageWithAttachments).attachments ?? []) as UserAttachmentView[];
      const sendFailure = (message as { sendFailure?: string }).sendFailure;
      const steered = Boolean((message as { steered?: boolean }).steered);
      const speaker = speakerLabelFor(message);
      const deleted = Boolean((message as { deleted?: boolean }).deleted);
      const edited = !deleted && Boolean((message as { edited?: boolean }).edited);
      return html`
        <article class="message-row user-row ${steered ? "steered-row" : ""}" data-index=${index}>
          ${steered ? html`<div class="steer-label">↪ steered the running task</div>` : nothing}
          ${speaker ? html`<div class="speaker-label">${speaker}</div>` : nothing}
          <div class="message-bubble user-bubble ${deleted ? "deleted-bubble" : ""}">
            <div class="pin-content">
              ${isReadOnlySlackView() ? slackWireBubble(messageText(message)) : markdown(messageText(message))}
              ${attachments.length ? html`<div class="message-files">${attachments.map(userAttachmentBadge)}</div>` : nothing}
              ${edited || deleted ? html`<span class="revision-badge">(${deleted ? "deleted" : "edited"})</span>` : nothing}
            </div>
          </div>
          <button class="pin-toggle" type="button" hidden aria-expanded="false">Show more</button>
          ${
            sendFailure
              ? html`<div class="send-failure">
                  <span>${sendFailure}</span>
                  <button class="btn compact" type="button" @click=${() => void retryFailedSend(message, index)}>
                    ${icon(RefreshCw, 12)} Retry
                  </button>
                </div>`
              : nothing
          }
          ${messageMeta(message, index)}
        </article>
      `;
    }
    if (role === "system-note") {
      const note = message as unknown as HistorySystemNote;
      const who = note.speaker ?? "The user";
      return html`
        <article class="message-row system-note-row" data-index=${index}>
          <div class="system-note">
            ${
              note.action === "deleted"
                ? html`${who} deleted their message`
                : html`${who} edited their message: <span class="system-note-text">${note.content}</span>`
            }
          </div>
        </article>
      `;
    }
    if (role === "assistant") {
      const msg = message as AssistantMessage;
      if ((msg as AssistantWork).retryableSend) return nothing;
      const work = isStreaming ? null : (msg as AssistantWork).work;
      const text = assistantDisplayText(messageText(msg)).trim();
      const hasText = Boolean(text);
      const showWork = shouldShowApprovalWork(msg, work, text) && shouldShowWork(work, hasText);
      const deliveredFiles = (msg as AssistantWork).deliveredFiles;
      const hasVisibleContent =
        showWork ||
        hasText ||
        Boolean(deliveredFiles?.length) ||
        msg.content.some((chunk) => chunk.type === "thinking" && chunk.thinking.trim());
      if (!hasVisibleContent && msg.stopReason !== "error" && msg.stopReason !== "aborted") return nothing;
      return html`
        <article class="message-row assistant-row ${isStreaming ? "streaming" : ""}" data-index=${index}>
          <div class="assistant-body">
            ${showWork ? workBlock(work, isStreaming) : nothing} ${assistantContent(msg, isStreaming, showWork)}
            ${assistantFileList(deliveredFiles)}
            ${msg.stopReason === "error" && msg.errorMessage ? html`<div class="composer-error inline">${msg.errorMessage}</div>` : nothing}
            ${msg.stopReason === "aborted" ? html`<div class="stopped-note">${icon(Ban, 13)}<span>Stopped</span></div>` : nothing}
            ${isStreaming ? nothing : messageMeta(msg, index)}
          </div>
        </article>
      `;
    }
    return nothing;
  }

  function copyableText(message: AgentMessage): string {
    const raw = messageText(message);
    if (!isReadOnlySlackView()) return raw;
    const role = (message as { role?: string }).role;
    return role === "user" || role === "user-with-attachments" ? slackWireToPlain(raw) : stripSlackDirectives(raw);
  }

  function messageMeta(message: AgentMessage, index: number): TemplateResult | typeof nothing {
    const text = copyableText(message).trim();
    const ts = (message as { timestamp?: number }).timestamp;
    if (!text && ts === undefined) return nothing;
    const forkable = Boolean(index >= 0 && chatState.threadRef && chatState.sessionId && chatState.agent);
    return html`
      <div class="message-meta">
        ${ts !== undefined ? html`<span class="message-time">${formatClock(ts)}</span>` : nothing}
        ${
          text
            ? html`<button
                class="msg-copy"
                type="button"
                ${tip("Copy")}
                aria-label="Copy message"
                @click=${(e: Event) => void copyMessage(text, e.currentTarget as HTMLButtonElement)}
              >
                ${icon(Copy, 13)}
              </button>`
            : nothing
        }
        ${
          forkable
            ? html`<button
                class="msg-copy msg-fork"
                type="button"
                ${tip("Fork conversation from here")}
                aria-label="Fork conversation from here"
                @click=${() => void forkFromMessage(index)}
              >
                ${icon(GitFork, 13)}
              </button>`
            : nothing
        }
      </div>
    `;
  }

  async function forkFromMessage(index: number): Promise<void> {
    const agent = chatState.agent;
    const sessionId = chatState.sessionId;
    const sourceThreadRef = chatState.threadRef;
    if (!agent || !sessionId) return;
    const messages = agent.state.messages as Array<{ role?: string }>;
    const target = messages[index];
    if (!target) return;
    const isUser = target.role === "user" || target.role === "user-with-attachments";
    let userOrdinal = 0;
    for (let i = 0; i <= index; i++) {
      const role = messages[i]?.role;
      if (role === "user" || role === "user-with-attachments") userOrdinal++;
    }
    try {
      const { entries } = await api<{ entries: SessionEntry[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      const anchor = chatState.transcriptAnchorSeq;
      if (anchor !== null) userOrdinal += userMessagesBefore(entries ?? [], anchor);
      const upToSeq = forkCutSeq(entries ?? [], userOrdinal, isUser);
      const forked = await forkSession(sessionId, upToSeq);
      const split = inheritedTranscript(forked.session, forked.entries ?? []);
      ctx.composer.carryModelPick(sourceThreadRef, forked.session.threadRef);
      mountContinuable(
        forked.session.threadRef,
        forked.session.id,
        forked.session.scopeId,
        entriesToMessages(split.current, transcriptModel()),
        forked.session.channelName ?? null,
        forked.session,
        entriesToMessages(split.inherited, transcriptModel()),
      );
      await refreshSessions({ silent: true });
      renderList();
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Could not fork the conversation.");
      drawActiveChat();
    }
  }

  function formatClock(ms: number): string {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  async function copyMessage(text: string, btn: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    btn.classList.add("copied");
    btn.replaceChildren(icon(Check, 13));
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.classList.remove("copied");
      btn.replaceChildren(icon(Copy, 13));
    }, 1200);
  }

  function withReturnTo(url: string): string {
    const returnTo = deepLinkPath(UI_BASE, "chats", chatState.sessionId);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}returnTo=${encodeURIComponent(returnTo)}`;
  }

  function connectorWidget(link: ConnectorLink): TemplateResult {
    const name =
      CONNECTOR_NAMES[link.provider] ??
      (link.provider ? link.provider[0]!.toUpperCase() + link.provider.slice(1) : "your account");
    if (link.provider && connectedConnectors.has(link.provider)) {
      return html`<div class="connector-widget connected" role="status">
        <span class="connector-widget-icon">${icon(Check, 18)}</span>
        <span class="connector-widget-text"
          ><strong>Connected ${name}</strong><small>Authorized. Its tools work here now</small></span
        >
      </div>`;
    }
    return html`<a class="connector-widget" href=${withReturnTo(link.url)} target="_blank" rel="noreferrer">
      <span class="connector-widget-icon">${icon(Plug, 18)}</span>
      <span class="connector-widget-text"
        ><strong>Connect ${name}</strong><small>Authorize access in a new tab</small></span
      >
      ${icon(ChevronRight, 16)}
    </a>`;
  }

  function playgroundCard(playground: PlaygroundArtifact): TemplateResult {
    const src = withBase(playgroundPath(playground.artifactId));
    const source = withBase(playgroundPath(playground.artifactId, true));
    return html`<section class="playground-card">
      <header class="playground-header">
        <span class="playground-title">${icon(Rocket, 16)}<strong>${playground.title}</strong></span>
        <nav class="playground-actions" aria-label="Playground actions">
          <a href=${source} target="_blank" rel="noreferrer">${icon(FileText, 14)} Source</a>
          <a href=${src} target="_blank" rel="noreferrer">${icon(Maximize2, 14)} Open</a>
        </nav>
      </header>
      <iframe
        class="playground-frame"
        src=${src}
        title=${playground.title}
        sandbox="allow-scripts allow-forms allow-pointer-lock"
        referrerpolicy="no-referrer"
      ></iframe>
    </section>`;
  }

  function isReadOnlySlackView(): boolean {
    return !chatState.agent && chatState.forkSession !== null && surfaceOf(chatState.forkSession) === "slack";
  }

  function assistantDisplayText(text: string): string {
    return isReadOnlySlackView() ? stripSlackDirectives(text) : text;
  }

  function slackWireBubble(text: string): TemplateResult {
    const self = (appState.me?.user?.split("@")[0] ?? "").trim().toLowerCase();
    const chip = (handle: string): TemplateResult =>
      html`<span class="slack-mention ${handle.toLowerCase() === self ? "self" : ""}">@${handle}</span>`;
    return html`<div class="slack-wire-text" dir="auto">
      ${splitSlackWire(text).map((seg) => {
        if (seg.kind === "mention") return chip(seg.handle);
        if (seg.kind === "link")
          return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
            >${seg.label}</a
          >`;
        return seg.text;
      })}
    </div>`;
  }

  function assistantContent(message: AssistantMessage, isStreaming = false, hasWork = false): TemplateResult[] {
    const parts: TemplateResult[] = [];
    for (const chunk of message.content) {
      if (chunk.type === "text") {
        const shown = assistantDisplayText(chunk.text);
        const links = shown.trim() ? connectorLinksIn(shown, location.origin) : [];
        const body = links.length ? stripConnectorLinks(shown) : shown;
        if (body.trim())
          parts.push(
            html`<div class="streaming-text ${isStreaming ? "live-stream" : ""}" dir="auto">
              ${isStreaming ? streamingMarkdown(body) : markdown(body)}
            </div>`,
          );
        for (const link of links) parts.push(connectorWidget(link));
      }
      if (chunk.type === "thinking" && chunk.thinking.trim()) {
        parts.push(
          html`<details class="thinking">
            <summary>${sheenLabel("Thinking", isStreaming)}</summary>
            ${markdown(chunk.thinking)}
          </details>`,
        );
      }
    }
    if (
      parts.length === 0 &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      !hasWork &&
      !(message as AssistantWork).deliveredFiles?.length
    )
      parts.push(typingRow());
    for (const playground of playgroundsIn((message as AssistantWork).work?.activity)) {
      parts.push(playgroundCard(playground));
    }
    return parts;
  }

  function assistantFileList(files: DeliveredFile[] | undefined): TemplateResult | typeof nothing {
    if (!files?.length) return nothing;
    return html`<div class="message-files">${files.map((f) => deliveredFileBadge(f))}</div>`;
  }

  let escapedSegs: string[] = [];
  let escapedSrc: string[] = [];
  function streamingMarkdown(text: string): TemplateResult {
    const { segments, tail } = splitStreamingMarkdown(text);
    if (segments.length < escapedSrc.length) {
      escapedSrc = [];
      escapedSegs = [];
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] ?? "";
      if (escapedSrc[i] !== seg) {
        escapedSrc[i] = seg;
        escapedSegs[i] = escapeLoneDollars(normalizePlainTextFences(seg));
      }
    }
    escapedSrc.length = segments.length;
    escapedSegs.length = segments.length;
    return html`${escapedSegs.map((seg) => html`<markdown-block dir="auto" .content=${seg}></markdown-block>`)}<markdown-block
        class="stream-tail"
        dir="auto"
        .content=${escapeLoneDollars(normalizePlainTextFences(tail))}
      ></markdown-block>`;
  }

  function messageText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (c): c is TextContent => Boolean(c) && typeof c === "object" && (c as { type?: string }).type === "text",
        )
        .map((c) => c.text ?? "")
        .join("\n");
    }
    return "";
  }

  function typingRow(): TemplateResult {
    return html`<div class="thinking-placeholder">
      ${waveLoader({ width: 14.1, label: "Thinking" })}${sheenLabel("Thinking", true)}
    </div>`;
  }

  function syncWorkTicker(): void {
    const goalTicking = Boolean(
      chatState.agent?.state.isStreaming && latestGoal(visibleMessages(chatState.agent))?.status === "active",
    );
    const active = (chatState.liveWork?.status === "working" && !chatState.liveWork.stale) || goalTicking;
    if (active && !workTicker) {
      workTicker = setInterval(() => drawActiveChat(), 1000);
    } else if (!active && workTicker) {
      clearInterval(workTicker);
      workTicker = null;
    }
  }

  function clearLiveWork(): void {
    chatState.liveWork = null;
    chatState.pendingSend = null;
    syncWorkTicker();
  }

  function shouldShowWork(work: WorkBlock | null | undefined, hasText: boolean): work is WorkBlock {
    if (!work) return false;
    if (work.activity.length > 0) return true;
    if (work.pendingApprovals?.length) return true;
    return work.status === "thinking" && !hasText;
  }

  function shouldShowApprovalWork(
    message: AssistantMessage,
    work: WorkBlock | null | undefined,
    text: string,
  ): boolean {
    if ((message as AssistantWork & { approvalDecision?: "denied" }).approvalDecision === "denied") return false;
    if (text === "Denied." && work?.activity.some((a) => a.type === "tool_call" || a.type === "approval_request"))
      return false;
    return true;
  }

  let readonlyRedraw: (() => void) | null = null;

  const bgPanel = {
    requested: null as { sessionId: string | null; threadRef: string | null } | null,
    open: false,
    loading: false,
    error: "",
    detail: null as SessionBackgroundView | null,
    openJob: null as string | null,
    output: new Map<string, { text: string; cursor: number; state: "running" | "exited"; exitCode?: number }>(),
    timer: null as ReturnType<typeof setInterval> | null,
    fetchSeq: 0,
    epoch: 0,
  };

  function requestBackgroundPanel(sessionId: string | null, threadRef: string | null): void {
    const mounted = sessionId ? sessionId === chatState.sessionId : threadRef === chatState.threadRef;
    if (mounted) {
      openBackgroundPanel();
      return;
    }
    bgPanel.requested = { sessionId, threadRef };
  }

  function resetBackgroundPanel(): void {
    if (bgPanel.timer) clearInterval(bgPanel.timer);
    bgPanel.timer = null;
    bgPanel.open = false;
    bgPanel.loading = false;
    bgPanel.error = "";
    bgPanel.detail = null;
    bgPanel.openJob = null;
    bgPanel.output.clear();
    bgPanel.fetchSeq++;
    bgPanel.epoch++;
    readonlyRedraw = null;
  }

  function consumeBackgroundPanelRequest(): void {
    const req = bgPanel.requested;
    bgPanel.requested = null;
    if (!req) return;
    const matches = req.sessionId ? req.sessionId === chatState.sessionId : req.threadRef === chatState.threadRef;
    if (matches) openBackgroundPanel();
  }

  function openBackgroundPanel(): void {
    if (bgPanel.open) return;
    bgPanel.open = true;
    void refreshBackgroundDetail();
    bgPanel.timer = setInterval(() => void backgroundPanelTick(), 2_500);
    redrawBackgroundPanel();
  }

  function closeBackgroundPanel(): void {
    if (bgPanel.timer) clearInterval(bgPanel.timer);
    bgPanel.timer = null;
    bgPanel.open = false;
    bgPanel.openJob = null;
    redrawBackgroundPanel();
  }

  function toggleBackgroundPanel(): void {
    if (bgPanel.open) closeBackgroundPanel();
    else openBackgroundPanel();
  }

  function redrawBackgroundPanel(): void {
    if (readonlyRedraw) readonlyRedraw();
    else drawActiveChat();
  }

  async function refreshBackgroundDetail(): Promise<void> {
    const id = chatState.sessionId;
    if (!id) {
      bgPanel.detail = { jobs: [], watches: [], crons: [] };
      return;
    }
    const seq = ++bgPanel.fetchSeq;
    bgPanel.loading = !bgPanel.detail;
    try {
      const d = await api<SessionBackgroundView>(`/api/sessions/${encodeURIComponent(id)}/background`);
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.detail = d;
      bgPanel.error = "";
    } catch (e) {
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.error = errMessage(e, "Failed to load background activity.");
    } finally {
      if (seq === bgPanel.fetchSeq) {
        bgPanel.loading = false;
        redrawBackgroundPanel();
      }
    }
  }

  async function backgroundPanelTick(): Promise<void> {
    await refreshBackgroundDetail();
    if (bgPanel.openJob) await pollJobOutput(bgPanel.openJob);
    const d = bgPanel.detail;
    if (d) {
      const row = sessionsState.list.find((r) =>
        chatState.sessionId ? r.id === chatState.sessionId : r.threadRef === chatState.threadRef,
      );
      if (
        row &&
        ((row.backgroundJobs ?? 0) !== d.jobs.length ||
          (row.watches ?? 0) !== d.watches.length ||
          (row.crons ?? 0) !== d.crons.length)
      ) {
        await refreshSessions({ silent: true });
        redrawBackgroundPanel();
      }
    }
  }

  function toggleJobOutput(processId: string): void {
    bgPanel.openJob = bgPanel.openJob === processId ? null : processId;
    if (bgPanel.openJob && !bgPanel.output.has(processId)) void pollJobOutput(processId);
    redrawBackgroundPanel();
  }

  async function pollJobOutput(processId: string): Promise<void> {
    const id = chatState.sessionId;
    if (!id) return;
    const epoch = bgPanel.epoch;
    const prev = bgPanel.output.get(processId);
    let text = prev?.text ?? "";
    let cursor = prev?.cursor ?? 0;
    let state: "running" | "exited" = prev?.state ?? "running";
    let exitCode = prev?.exitCode;
    try {
      for (let i = 0; i < 8; i++) {
        const read = await api<SessionBackgroundOutput>(
          `/api/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(processId)}/output?sinceCursor=${cursor}`,
        );
        cursor = read.cursor;
        text = (text + read.chunk).slice(-16_384);
        state = read.state;
        exitCode = read.exitCode;
        if (read.chunk.length < 60_000) break;
      }
      if (epoch !== bgPanel.epoch) return;
      bgPanel.output.set(processId, { text, cursor, state, ...(exitCode !== undefined ? { exitCode } : {}) });
    } catch (e) {
      swallow("web-ui: background job output read", e);
    }
    if (epoch !== bgPanel.epoch) return;
    redrawBackgroundPanel();
  }

  function timeLeft(expiresAt: number): string {
    const mins = Math.round((expiresAt - Date.now()) / 60_000);
    if (mins <= 0) return "expiring";
    if (mins < 60) return `${mins}m left`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m left`;
  }

  function backgroundActivityStrip(): TemplateResult | typeof nothing {
    const row = conversationBackground(sessionsState.list, chatState.sessionId, chatState.threadRef);
    const live =
      bgPanel.open && bgPanel.detail
        ? backgroundLabel(bgPanel.detail.jobs.length, bgPanel.detail.watches.length, bgPanel.detail.crons.length)
        : null;
    const label = (live ?? row)?.label;
    if (!label && !bgPanel.open) return nothing;
    return html`
      <section class="bg-activity ${bgPanel.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(bgPanel.open)}
          ${tip(bgPanel.open ? "Hide background activity" : "Work continuing on the agent's computer. Click to inspect")}
          @click=${toggleBackgroundPanel}
        >
          ${icon(Activity, 13)}<span class="bg-activity-label">${label ?? "Background activity"}</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${bgPanel.open ? backgroundPanelBody() : nothing}
      </section>
    `;
  }

  function backgroundPanelBody(): TemplateResult {
    const d = bgPanel.detail;
    const empty = d && d.jobs.length === 0 && d.watches.length === 0 && d.crons.length === 0;
    return html`<div class="bg-panel" role="region" aria-label="Background activity">
      ${bgPanel.error ? html`<div class="bg-panel-note">${bgPanel.error}</div>` : nothing}
      ${!d && bgPanel.loading ? html`<div class="bg-panel-note">Loading…</div>` : nothing}
      ${empty && !bgPanel.error ? html`<div class="bg-panel-note">Nothing running here anymore.</div>` : nothing}
      ${d ? d.jobs.map((j) => backgroundJobRow(j)) : nothing}
      ${d ? d.watches.map((w) => backgroundWatchRow(w)) : nothing}
      ${d ? d.crons.map((c) => backgroundCronRow(c)) : nothing}
    </div>`;
  }

  function backgroundJobRow(j: SessionBackgroundView["jobs"][number]): TemplateResult {
    const open = bgPanel.openJob === j.processId;
    const out = bgPanel.output.get(j.processId);
    const status =
      out?.state === "exited"
        ? `exited${out.exitCode !== undefined ? ` (${out.exitCode})` : ""}`
        : timeLeft(j.expiresAt);
    return html`
      <div class="bg-row ${open ? "open" : ""}">
        <button
          type="button"
          class="bg-row-head"
          aria-expanded=${String(open)}
          ${tip(open ? "Hide output" : "Show live output")}
          @click=${() => toggleJobOutput(j.processId)}
        >
          ${icon(Terminal, 13)}
          <code class="bg-row-cmd">${j.command}</code>
          <span class="bg-row-meta">started ${relTime(j.startedAt)} · ${status}</span>
          <span class="bg-row-toggle">${icon(ChevronRight, 13)}</span>
        </button>
        ${open ? html`<pre class="bg-row-output">${out ? out.text || "(no output yet)" : "Loading output…"}</pre>` : nothing}
      </div>
    `;
  }

  function backgroundCronRow(c: SessionBackgroundView["crons"][number]): TemplateResult {
    return html`
      <div class="bg-row watch">
        <a class="bg-row-head" href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}>
          ${icon(Clock3, 13)}
          <span class="bg-row-cmd">Cron: <bdi>${c.title ?? "scheduled task"}</bdi></span>
          <span class="bg-row-meta">${c.nextFireAt ? `next fire ${nextFireIn(c.nextFireAt)}` : "paused"}</span>
        </a>
      </div>
    `;
  }

  function nextFireIn(at: number): string {
    const mins = Math.round((at - Date.now()) / 60_000);
    if (mins <= 0) return "due now";
    if (mins < 60) return `in ${mins}m`;
    if (mins < 1440) return `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
    return `in ${Math.floor(mins / 1440)}d`;
  }

  function backgroundWatchRow(w: SessionBackgroundView["watches"][number]): TemplateResult {
    const what = w.pattern ? `output matching /${w.pattern}/` : "any new output";
    const note = w.instructions?.trim();
    return html`
      <div class="bg-row watch">
        <div class="bg-row-head static">
          ${icon(Radar, 13)}
          <span class="bg-row-cmd">Watch: wakes on ${what}${note ? ` · “${note}”` : ""}</span>
          <span class="bg-row-meta"
            >armed ${relTime(w.createdAt)} · ${watchActivityLabel(w)} · ${timeLeft(w.expiresAt)}</span
          >
        </div>
      </div>
    `;
  }

  function goalStrip(agent: Agent): TemplateResult | typeof nothing {
    const goal = latestGoal(visibleMessages(agent));
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) return nothing;
    const paused = goal.status === "paused";
    const streaming = agent.state.isStreaming;
    const elapsed = goalElapsedLabel(goal.createdAt, Date.now());
    let title = "Goal";
    if (paused) title = "Goal paused";
    else if (streaming) title = "Pursuing goal";
    return html`
      <section class="goal-strip ${paused ? "paused" : ""}" aria-live="polite" title=${goal.objective}>
        <span class="goal-strip-icon">${icon(paused ? Pause : Target, 13)}</span>
        <span class="goal-strip-title">${title}</span>
        <span class="goal-strip-objective" dir="auto">${goalObjectiveLabel(goal.objective)}</span>
        ${goal.floor ? html`<span class="goal-strip-meta">at least ${goal.floor}</span>` : nothing}
        ${paused ? nothing : html`<span class="goal-strip-meta">· ${elapsed}</span>`}
      </section>
    `;
  }

  function liveWorkStatus(agent: Agent): TemplateResult | typeof nothing {
    if (!agent.state.isStreaming && chatState.resolvingApprovals.size === 0) return nothing;
    const work = chatState.liveWork ?? { status: "thinking", activity: [] };
    if (work.status !== "thinking" && work.status !== "working") return nothing;
    const summary = liveWorkSummary(work);
    const expandable = Boolean(summary?.detail);
    const expanded = expandable && liveWorkExpanded;
    let title = "";
    if (expandable) title = liveWorkExpanded ? "Show less" : "Show more";
    return html`
      <section class="live-work-status ${expanded ? "expanded" : ""}" aria-live="polite">
        <button
          type="button"
          class="live-work-line ${expandable ? "" : "static"}"
          ?disabled=${!expandable}
          aria-expanded=${expandable ? String(liveWorkExpanded) : nothing}
          ${tip(title)}
          @click=${toggleLiveWorkExpanded}
        >
          ${summary ? html`<span class="tool-icon">${icon(summary.icon, 15)}</span>` : nothing}
          <span class="live-work-label"
            >${summary ? summary.label : sheenLabel(`Thinking${usedToolsSuffix(work)}`, true)}</span
          >
          ${summary?.detail ? html`<span class="live-work-detail">${summary.detail}</span>` : nothing}
          ${expandable ? html`<span class="live-work-toggle">${icon(ChevronRight, 14)}</span>` : nothing}
        </button>
      </section>
    `;
  }

  function toggleLiveWorkExpanded(): void {
    liveWorkExpanded = !liveWorkExpanded;
    drawActiveChat();
  }

  function liveWorkSummary(work: WorkBlock): { icon: IconNode; label: string; detail: string } | null {
    if (work.stale) {
      const active = activeToolRow(work);
      const call = (active?.call?.payload ?? {}) as ToolPayload;
      const tool = call.tool ?? "";
      const verb = active ? (TOOL_META[tool] ?? UNKNOWN_TOOL).active : null;
      return {
        icon: RefreshCw,
        label: verb ? `${verb} interrupted, resuming…` : "Interrupted, resuming…",
        detail: active ? toolDetail(tool, call, (active.result?.payload ?? {}) as ToolPayload) : "",
      };
    }
    const active = activeToolRow(work);
    return active ? activeToolSummary(active, work) : null;
  }

  function activeToolRow(work: WorkBlock): ToolRowModel | null {
    const timeline = buildTimeline(work);
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (item.kind === "tool" && toolRowKind(item.row, work.status) === "running") return item.row;
    }
    return null;
  }

  function activeToolSummary(row: ToolRowModel, work: WorkBlock): { icon: IconNode; label: string; detail: string } {
    const call = (row.call?.payload ?? {}) as ToolPayload;
    const result = (row.result?.payload ?? {}) as ToolPayload;
    const tool = call.tool ?? result.tool ?? "unknown";
    const meta = TOOL_META[tool] ?? UNKNOWN_TOOL;
    const secs = elapsedSeconds(row.call?.createdAt) || workSeconds(work);
    const posting = postSpeechText(row, true);
    if (posting) {
      return {
        icon: MessageSquare,
        label: secs > 0 ? `Posting message for ${secs}s` : "Posting message",
        detail: firstLine(posting, 60),
      };
    }
    return {
      icon: meta.icon,
      label: secs > 0 ? `${meta.active} for ${secs}s` : meta.active,
      detail: toolDetail(tool, call, result),
    };
  }

  function elapsedSeconds(startedAt: number | null | undefined): number {
    if (typeof startedAt !== "number" || startedAt <= 0) return 0;
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  function usedToolsSuffix(work: WorkBlock): string {
    const n = work.activity.filter((a) => a.type === "tool_call").length;
    return n > 0 ? ` (used ${n} tool${n === 1 ? "" : "s"})` : "";
  }

  function workLabel(work: WorkBlock): string {
    if (work.stale && (work.status === "thinking" || work.status === "working")) return "Interrupted, resuming…";
    if (work.status === "thinking") return "Thinking";
    const secs = workSeconds(work);
    return work.status === "working" ? `Working for ${secs}s` : workedLabel("Worked", secs);
  }

  function workBlock(work: WorkBlock, isStreaming: boolean): TemplateResult {
    if (work.status === "thinking" && !work.activity.length) {
      return html`<div class="work work-thinking">
        <div class="work-head">${sheenLabel(workLabel(work), isStreaming)}</div>
      </div>`;
    }
    const timeline = buildTimeline(work);
    const rows = timeline.length
      ? html`<div class="work-rows">${timeline.map((it) => renderTimelineItem(it, work))}</div>`
      : nothing;
    const body = html`<div class="work-divider"></div>
      ${rows}`;
    if (isStreaming || work.status === "working" || work.status === "thinking") {
      return html`<div class="work work-working">
        <div class="work-head">${sheenLabel(workLabel(work), isStreaming)}</div>
        ${body}
      </div>`;
    }
    const openFolds = !!work.pendingApprovals?.length;
    const parts: TemplateResult[] = [];
    let seg: TimelineItem[] = [];
    const flushSeg = (): void => {
      if (!seg.length) return;
      const items = seg;
      seg = [];
      parts.push(
        html`<details class="work-fold" ?open=${openFolds}>
          <summary class="work-head">${segmentSummaryLabel(items, work)}${icon(ChevronRight, 14)}</summary>
          <div class="work-divider"></div>
          <div class="work-rows">${items.map((it) => renderTimelineItem(it, work))}</div>
        </details>`,
      );
    };
    for (const it of timeline) {
      const speech = it.kind === "tool" ? postSpeechText(it.row) : null;
      const demoted = it.kind === "text" && (it.activity.payload as { demoted?: boolean } | null)?.demoted === true;
      // Closing self-logs after a successful surface post are bookkeeping, not
      // another piece of visible work. Keeping them in the transcript is useful
      // for audit/replay, but rendering them creates an empty "Worked" fold.
      if (demoted) continue;
      if (it.kind === "text") {
        flushSeg();
        const text = ((it.activity.payload as { text?: string } | null)?.text ?? "").trim();
        if (text) parts.push(html`<div class="work-said">${markdown(text)}</div>`);
      } else if (speech) {
        flushSeg();
        parts.push(html`<div class="work-said">${markdown(speech)}</div>`);
      } else {
        seg.push(it);
      }
    }
    flushSeg();
    return parts.length ? html`<div class="work work-${work.status}">${parts}</div>` : html``;
  }

  function segmentSummaryLabel(items: TimelineItem[], work: WorkBlock): string {
    const tools = items.filter((it) => it.kind === "tool").length;
    if (tools > 0) return `${tools} tool call${tools === 1 ? "" : "s"}`;
    const secs = workSeconds(work);
    if (work.status === "failed") return secs > 0 ? `Failed after ${secs}s` : "Failed";
    return workedLabel("Worked", secs);
  }

  function approvalSummaryView(a: PendingApproval, expanded = false): TemplateResult {
    const summary = firstLine(a.command, 80);
    const truncated = a.command.includes("\n") || a.command.length > 80;
    return html`
      <div class="approval-head">
        <span class="approval-title">Approval needed</span>
        ${a.reason ? html`<span class="approval-reason-badge">${a.reason}</span>` : nothing}
      </div>
      ${a.summary ? html`<div class="approval-summary-line">${a.summary}</div>` : nothing}
      ${a.purpose ? html`<div class="approval-why"><span class="approval-why-label">Why</span>${a.purpose}</div>` : nothing}
      ${
        expanded
          ? html`<code class="approval-cmd approval-cmd-full">${a.command}</code>`
          : html`<code class="approval-summary" ${tip(a.command)}>${summary}</code>`
      }
      ${
        a.matched
          ? html`<div class="approval-match">
              <span class="approval-match-label">Triggered by</span
              ><code class="approval-match-snippet">${a.matched}</code>
            </div>`
          : nothing
      }
      ${
        !expanded && truncated
          ? html`<details class="approval-full">
              <summary>Show full command</summary>
              <code class="approval-cmd">${a.command}</code>
            </details>`
          : nothing
      }
    `;
  }

  function approvalMarker(a: PendingApproval): TemplateResult {
    return html`<div class="approval-card inline-approval-marker">
      <div class="approval-text">${approvalSummaryView(a)}</div>
    </div>`;
  }

  function sheenLabel(label: string, active: boolean): TemplateResult {
    return html`<span class="sheen-label ${active ? "thinking-sheen" : ""}" data-sheen=${active ? label : ""}
      >${label}</span
    >`;
  }

  function renderTimelineItem(item: TimelineItem, work: WorkBlock): TemplateResult {
    const status = work.status;
    const stale = work.stale === true;
    if (item.kind === "thinking") return thinkingRow(item.activity);
    if (item.kind === "text") return messageRow(item.activity);
    if (item.kind === "approval") return approvalMarker(item.approval);
    const speech = postSpeechText(item.row);
    if (speech) return messageRow({ ...item.row.call!, payload: { text: speech } });
    return toolRow(item.row, work, status, stale);
  }

  function thinkingRow(activity: ToolActivity): TemplateResult {
    const text = (activity.payload as { thinking?: string } | null)?.thinking ?? "";
    const preview = firstLine(text.replace(/\s+/g, " ").trim());
    return html`<details class="thinking-row">
      <summary class="thinking-summary">
        <span class="tool-icon">${icon(Brain, 13)}</span>
        <span class="tool-label" title=${preview ? `Thinking: ${preview}` : "Thinking"}>${preview || "Thinking"}</span>
        ${icon(ChevronRight, 14)}
      </summary>
      <div class="thinking-body">${markdown(text)}</div>
    </details>`;
  }

  function messageRow(activity: ToolActivity): TemplateResult {
    const text = (activity.payload as { text?: string } | null)?.text ?? "";
    return html`<div class="work-message">${markdown(text)}</div>`;
  }

  const TOOL_META: Record<string, { icon: IconNode; active: string; done: string; attempted: string }> = {
    execute: { icon: Terminal, active: "Running command", done: "Ran command", attempted: "Tried command" },
    read: { icon: FileText, active: "Reading file", done: "Read file", attempted: "Tried reading file" },
    write: { icon: Pencil, active: "Writing file", done: "Wrote file", attempted: "Tried writing file" },
    publish: { icon: Rocket, active: "Publishing", done: "Published", attempted: "Tried publishing" },
    recall: { icon: Brain, active: "Searching memory", done: "Searched memory", attempted: "Tried searching memory" },
    memory: { icon: Brain, active: "Using memory", done: "Used memory", attempted: "Tried using memory" },
    history: {
      icon: ScrollText,
      active: "Searching history",
      done: "Searched history",
      attempted: "Tried searching history",
    },
    background: {
      icon: Terminal,
      active: "Managing process",
      done: "Managed process",
      attempted: "Tried managing process",
    },
  };
  const UNKNOWN_TOOL = { icon: Wrench, active: "Working", done: "Finished step", attempted: "Tried step" };

  function toolName(tool: string): string {
    const parts = tool.split(/__|[/:.]/).filter(Boolean);
    const meaningful = ["mcp", "connector"].includes(parts[0]?.toLowerCase() ?? "") ? parts.slice(1) : parts;
    const names: Record<string, string> = { github: "GitHub", api: "API", url: "URL", id: "ID" };
    return meaningful
      .flatMap((part) => part.split(/[-_]/))
      .filter(Boolean)
      .map((part) => names[part.toLowerCase()] ?? part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }

  function firstLine(s: string, max?: number): string {
    const line = s.split("\n")[0] ?? "";
    return max !== undefined && line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  function toolDetail(tool: string, call: ToolPayload, result: ToolPayload): string {
    switch (toolCategory({ ...result, ...call, tool })) {
      case "execute":
        return call.command ? firstLine(call.command) : "";
      case "read":
        return call.path ?? result.path ?? "";
      case "write": {
        const path = call.path ?? result.path ?? "";
        const bytes = result.bytes ?? call.bytes;
        return bytes !== undefined ? `${path} · ${formatBytes(bytes)}` : path;
      }
      case "publish":
        return result.url ?? result.name ?? call.name ?? "";
      case "recall":
      case "history": {
        const seq = call.seq ?? result.seq;
        if (seq !== undefined) return result.found === false ? `entry #${seq} · not found` : `entry #${seq}`;
        const q = call.query ?? result.query ?? "";
        return result.count !== undefined ? `${q} · ${result.count} result${result.count === 1 ? "" : "s"}` : q;
      }
      case "memory": {
        const action = call.action ?? result.action ?? "";
        const q = call.query ?? result.query ?? "";
        let detail = q;
        if (result.count !== undefined) {
          detail = `${q} · ${result.count} result${result.count === 1 ? "" : "s"}`;
        } else if (result.added !== undefined) {
          detail = `${result.added} saved`;
        }
        return [action, detail].filter(Boolean).join(" ");
      }
      case "background": {
        const action = call.action ?? result.action ?? "";
        const target = call.command ? firstLine(call.command, 48) : (call.process_id ?? call.monitor_id ?? "");
        return [action, target].filter(Boolean).join(" ");
      }
      default:
        return genericToolDetail(call, result);
    }
  }

  function genericToolDetail(call: ToolPayload, result: ToolPayload): string {
    const keys = [
      "command",
      "path",
      "query",
      "pattern",
      "glob",
      "url",
      "name",
      "action",
      "file",
      "filename",
      "database",
      "filter",
      "repository",
      "resource",
      "title",
    ];
    for (const source of [call, nestedToolInput(call), result, nestedToolInput(result)]) {
      for (const key of keys) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) return firstLine(value.trim());
      }
    }
    return "";
  }

  function nestedToolInput(payload: ToolPayload): ToolPayload {
    const record = payload as Record<string, unknown>;
    for (const key of ["input", "arguments", "args"]) {
      const value = record[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolPayload;
    }
    return {};
  }

  function toolPayloadText(payload: ToolPayload, omitted: string[] = []): string {
    const hidden = new Set(["tool", "callId", ...omitted]);
    const entries = Object.entries(payload as Record<string, unknown>).filter(
      ([key, value]) => !hidden.has(key) && value !== undefined,
    );
    if (!entries.length) return "";
    if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1] as string;
    return JSON.stringify(Object.fromEntries(entries), null, 2);
  }

  function toolPayloadCard(label: string, text: string): TemplateResult | typeof nothing {
    if (!text) return nothing;
    return html`<div class="tool-payload-card">
      <div class="tool-payload-label">${label}</div>
      <pre class="tool-payload-body">${text}</pre>
    </div>`;
  }

  function toolDisclosure(
    tool: string,
    call: ToolPayload,
    result: ToolPayload,
    work: WorkBlock,
    activity: ToolActivity | null,
  ): TemplateResult {
    const input = toolPayloadText(call);
    const hasExecOutput =
      toolCategory({ ...result, ...call, tool }) === "execute" && toolExecutionOutput(result) !== null;
    const output = toolPayloadText(result, hasExecOutput ? ["stdout", "stderr", "code", "timedOut", "result"] : []);
    return html`<div class="tool-disclosure">
      ${toolPayloadCard("Input", input)} ${hasExecOutput ? execOutputCard(result, work, activity) : nothing}
      ${toolPayloadCard("Result", output)}
    </div>`;
  }

  function toolRow(row: ToolRowModel, work: WorkBlock, status: WorkBlock["status"], stale = false): TemplateResult {
    if (row.approval) {
      const p = (row.approval.payload ?? {}) as ToolPayload;
      return html`<div class="tool-row tool-approval">
        <span class="tool-icon">${icon(Wrench, 13)}</span>
        <span class="tool-label"
          >Approval
          needed${p.reason ? html` <span class="tool-detail">${firstLine(p.reason, 90)}</span>` : nothing}</span
        >
      </div>`;
    }
    const call = (row.call?.payload ?? {}) as ToolPayload;
    const result = (row.result?.payload ?? {}) as ToolPayload;
    const tool = call.tool ?? result.tool ?? "unknown";
    const knownMeta = TOOL_META[toolCategory({ ...result, ...call, tool })];
    const meta = knownMeta ?? UNKNOWN_TOOL;
    const name = toolName(tool) || "Tool";
    const kind = toolRowKind(row, status);
    let label = knownMeta ? meta.attempted : `Tried ${name}`;
    if (kind === "approval") label = "Approval needed";
    else if (kind === "running") {
      const active = knownMeta ? meta.active : name;
      label = stale ? `${active} — interrupted` : active;
    } else if (kind === "ok") label = knownMeta ? meta.done : name;
    let why = "";
    if (kind === "approval") why = firstLine(result.reason ?? "", 90);
    else if (kind === "failed") why = firstLine(result.error ?? result.reason ?? "", 90);
    const base = kind === "approval" ? "" : toolDetail(tool, call, result);
    const attempts = row.attempts && row.attempts > 1 ? `${row.attempts} attempts` : "";
    const detail = [base, why, attempts].filter(Boolean).join(" · ");
    const visible = detail || label;
    const classes = ["tool-row", `tool-${kind}`].join(" ");
    const head = html`<span class="tool-icon">${icon(meta.icon, 13)}</span>
      <span class="tool-label" title=${detail ? `${label}: ${detail}` : label}>${visible}</span>`;
    if (!row.call && !row.result) return html`<div class="${classes}">${head}</div>`;
    return html`<details class="${classes} tool-expandable">
      <summary class="tool-summary">${head}${icon(ChevronRight, 14)}</summary>
      ${toolDisclosure(tool, call, result, work, row.result ?? null)}
    </details>`;
  }

  function execOutputCard(result: ToolPayload, work: WorkBlock, activity: ToolActivity | null): TemplateResult {
    const out = toolExecutionOutput(result) ?? "";
    return html`<div class="code-card">
      <div class="code-card-head"><span class="code-card-lang">bash</span></div>
      <pre class="code-card-body">${out}</pre>
      <div class="code-card-foot">
        exit ${result.code ?? "unknown"}${result.timedOut ? " · timed out" : ""}
        ${
          activity?.truncated
            ? html`<button class="show-full-btn" type="button" @click=${() => void loadFullEntry(work, activity)}>
                Show full output
              </button>`
            : nothing
        }
      </div>
    </div>`;
  }

  function redrawTranscript(): void {
    if (readonlyRedraw) readonlyRedraw();
    else drawActiveChat();
  }

  async function loadFullEntry(work: WorkBlock, activity: ToolActivity): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || !activity.truncated) return;
    try {
      const full = await fetchEntry(sessionId, activity.seq);
      work.activity = work.activity.map((a) =>
        a === activity ? { ...a, payload: full.payload, truncated: false } : a,
      );
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Couldn't load the full output.");
    }
    redrawTranscript();
  }

  function fileChip(name: string, size?: number, href?: string): TemplateResult {
    return chipBadge(Paperclip, name, size, href);
  }

  function inlineHtmlName(name?: string, mimeType?: string): boolean {
    if (mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html") return true;
    return /\.html?$/i.test(name ?? "");
  }

  const dismissedHtmlPreviews = new Set<string>();

  function inlineHtmlFrame(name: string, src: string, size?: number, href?: string): TemplateResult {
    const key = `${chatState.sessionId ?? "new"}:${href ?? src}:${name}`;
    const chip = fileChip(name, size, href);
    if (dismissedHtmlPreviews.has(key)) return chip;
    return html`<span class="file-html-unfurl"
      ><span class="file-html-header"
        ><span dir="auto">${name}</span
        ><button
          type="button"
          aria-label="Dismiss ${name} preview"
          title="Dismiss preview"
          @click=${() => {
            dismissedHtmlPreviews.add(key);
            redrawTranscript();
          }}
        >
          ${icon(X, 14)}
        </button></span
      ><iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy"></iframe>${chip}</span
    >`;
  }

  function imageChip(name: string, size?: number, href?: string): TemplateResult {
    return chipBadge(FileImage, name, size, href, true);
  }

  interface UserAttachmentView {
    fileName: string;
    mimeType?: string;
    size?: number;
    content?: string;
    artifactId?: string;
  }

  const localAttachmentUrls = new Map<UserAttachmentView, string>();

  function localContentUrl(a: UserAttachmentView): string | undefined {
    if (!a.content) return undefined;
    const cached = localAttachmentUrls.get(a);
    if (cached) return cached;
    try {
      const b64 = a.content.startsWith("data:") ? (a.content.split(",")[1] ?? "") : a.content;
      const bytes = base64ToBytes(b64);
      const blob = new Blob([bytes as BlobPart], { type: a.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      localAttachmentUrls.set(a, url);
      return url;
    } catch {
      return undefined;
    }
  }

  function userAttachmentBadge(a: UserAttachmentView): TemplateResult {
    const artifactHref = a.artifactId ? fileContentUrl(a.artifactId, a.fileName) : undefined;
    if (a.mimeType?.startsWith("image/")) {
      const dataUrl =
        a.content && (a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`);
      const download = !artifactHref || !browserRenderableImage(a.mimeType);
      return chipBadge(FileImage, a.fileName, a.size, artifactHref ?? dataUrl ?? undefined, download);
    }
    if (inlineHtmlName(a.fileName, a.mimeType)) {
      let src = artifactHref;
      if (!src && a.content) {
        src = a.content.startsWith("data:") ? a.content : `data:text/html;base64,${a.content}`;
      }
      if (src) return inlineHtmlFrame(a.fileName, src, a.size, artifactHref);
    }
    return fileChip(a.fileName, a.size, artifactHref ?? localContentUrl(a));
  }

  function deliveredFileBadge(file: DeliveredFile): TemplateResult {
    if (!file.artifactId) return fileChip(file.name, file.sizeBytes);
    const href = fileContentUrl(file.artifactId, file.name);
    if (file.mimetype?.startsWith("image/")) {
      if (!browserRenderableImage(file.mimetype)) return imageChip(file.name, file.sizeBytes, href);
      return html`<a class="file-image" href=${href} target="_blank" rel="noreferrer" ${tip(file.name)}
        ><img src=${href} alt=${file.name} loading="lazy"
      /></a>`;
    }
    if (inlineHtmlName(file.name, file.mimetype)) return inlineHtmlFrame(file.name, href, file.sizeBytes, href);
    return fileChip(file.name, file.sizeBytes, href);
  }

  function scrollToBottom(): void {
    scrollTranscript(true);
  }

  function scrollTranscript(force = false): void {
    transcriptViewport.sync(ctx.container()?.querySelector<HTMLElement>(".chat-scroll") ?? null);
    transcriptViewport.follow(force);
  }

  redrawHooks.add(redrawForConnector);

  return {
    state: chatState,
    hasLiveRun: () => hasLiveRun(runSlot),
    signalLiveRun: (kind, text) =>
      signalLiveRun(runSlot, kind, text, {
        threadRef: chatState.threadRef,
        scopeId: chatState.scopeId,
        channelName: chatState.contextName,
      }),
    stopLiveRun,
    currentTurnOptions,
    newChat,
    teardown: teardownActiveChat,
    resetChatState,
    mountContinuable,
    mountReadOnly,
    mountLoadingPane,
    scrollToBottom,
    drawActiveChat,
    setTranscriptWindow,
    setPins,
    requestBackgroundPanel,
    activePendingApprovals,
    hasUnresolvedApproval,
    resolveCommandApproval,
    approvalSummaryView,
    notePendingSessionOnSend,
    syncPaneState: postCurrentPaneState,
    onDelivery,
    resumeIfIdle,
    redraw: () => drawActiveChat(),
    dispose,
  };
}
