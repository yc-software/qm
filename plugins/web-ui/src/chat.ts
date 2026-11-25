import { sideChatExcerpt } from "./side-chat-excerpt";
import { createSideChatController } from "./side-chat";
import { createReadOnlySession } from "./readonly-session";
import { assistantSidebar, assistantMessage } from "./assistant-sidebar";
import { formatMessageTime } from "./message-time.ts";
import { viaLine } from "./via-label.ts";
import { replyVersions, replyVersionsPanel, replyVersionsToggle, rowEntrySeqs } from "./reply-versions.ts";
import { messageEntrySeqs, highlightMessage } from "./message-link.ts";
import { appEditSlug } from "../../chassis/src/app-edit";
import { isConnectionReturn } from "./connection-return";
import "./onboarding-welcome";
import { setupContent } from "./setup-widget";
import { welcomeLayout } from "./welcome-session";
import { connectorCard } from "./connector-widget";
import {
  activityDescription,
  activityLabel,
  activityGroupSummary,
  activityGroups,
  thinkingLabel,
  thinkingPresentation,
  sessionPresentation,
} from "./activity-presentation";
import { dismissGeneratedActivity, loadGeneratedActivities } from "./generated-activities";
import { playgroundPath, playgroundsIn, type PlaygroundArtifact } from "./playground";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SlackOutbox } from "./slack-outbox";
import { appTag, openInSurface, reactionChips, slackTitle, slackWireBubble } from "./slack-thread-view";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { markdown } from "./message-markdown";
import { onSpeakerAvatars, speakerAvatar } from "./speaker-avatars";
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ref } from "lit/directives/ref.js";
import { guard } from "lit/directives/guard.js";
import {
  Activity,
  ArrowDown,
  BookOpen,
  Search,
  Brain,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Cog,
  Copy,
  FileImage,
  FileText,
  Files,
  GitFork,
  Link2,
  Maximize2,
  MessageSquare,
  Paperclip,
  Pause,
  Play,
  Pencil,
  Pin,
  Radar,
  RefreshCw,
  RotateCcw,
  Target,
  Rocket,
  ScrollText,
  SquareTerminal as Terminal,
  TriangleAlert,
  Wrench,
  X,
  type IconNode,
} from "lucide";
import {
  APPROVAL_GONE_MESSAGE,
  messageText,
  continuableMessages,
  hasRecordedRunReply,
  messagesWithStreaming,
  userItemMessage,
  appendConsumedSteers,
  withBase,
  type SessionPin,
  activeRunForThread,
  stopThreadRun,
  api,
  approvalDecidableDuringRun,
  createRunSlot,
  hasLiveRun,
  requestStop,
  resumeAnchor,
  runIsTerminal,
  signalLiveRun,
  attachPendingApprovals,
  itemsToMessages,
  fetchItem,
  fetchTranscript,
  fetchSessionApprovals,
  currentEarlierCount,
  forkOriginDetails,
  forkCutSeq,
  forkSession,
  cancelSessionGoal,
  resumeSessionGoal,
  inheritedRefreshItems,
  inheritedTranscript,
  loadInheritedTranscript,
  makeCoreStreamFn,
  makeOpenerStreamFn,
  makeRunResumeStreamFn,
  type LocatedRun,
  resolveApproval,
  unresolvedApprovals,
  type RunPoll,
  TAIL_TURNS,
  type ApprovalDecision,
  type AssistantWork,
  type CoreSession,
  type DeliveredFile,
  type HistorySystemNote,
  type HistoryApprovalDecision,
  type PendingApproval,
  type SessionBackgroundOutput,
  type SessionBackgroundView,
  type SubagentMailRef,
  type TranscriptPage,
  type TurnOptions,
  type TurnRuntime,
  type WorkBlock,
  deleteEphemeralSession,
  fileContentUrl,
  onChatPrefsChange,
  pinLatestPrompt,
  switchedDefault,
} from "./core-bridge";
import { approvalRecord } from "./approval-card";
import {
  buildTimeline,
  rowArgs,
  rowTool,
  toolBody,
  toolCallArguments,
  messageWorkTimeline,
  retractedReplies,
  workTimelineSegments,
  streamedAnswer,
  currentTextPhase,
  postSpeechText,
  toolCategory,
  toolRowKind,
  sessionToolView,
  type TimelineItem,
  type ToolPayload,
  type ToolRowModel,
} from "./timeline";
import { activityItems, retractedReason, type Item } from "./items";
import "./slack-setup";
import { connectorLinksIn, stripConnectorLinks, type ConnectorLink } from "./connector-link";
import { deepLinkPath, sessionLink, UI_BASE } from "./deep-link";
import type { ChatSurface, ConvCtx } from "./conv-types";
import { errMessage, swallow } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { tellEmbedderOfFinishedTools } from "./embedder";
import { slackPreviewText, slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { collectReactions, continuedSpeakers, fromSomeoneElse, hiddenMessage, slackAppIcon } from "./slack-view";
import { charForName } from "./emoji-picker";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { transcriptModel, defaultEffortForModel } from "./model-options";
import {
  attachmentGallery,
  avatarTpl,
  brandMark,
  brandName,
  chipBadge,
  copyText,
  formatBytes,
  relTime,
  sheenLabel,
  waveLoader,
} from "./ui";
import { icon } from "./icons";
import { animateDetailsToggle } from "./details-motion";
import { htmlPreviewCard } from "./html-preview";
import { audioPlayer, dataUrl, mediaFeed, mediaKind, openMediaViewer, videoThumb, type MediaItem } from "./media";
import { checkedReplyStep, createLiveStepLine, currentStep, preStepWork } from "./live-step";
import { appState, renderSidebarTop, switchView, syncUrlFromState } from "./shell";
import { hasWelcomeScreen } from "./shell-state";
import { contextsState, scopeTitle } from "./contexts";
import { openProjectPage, scopeToolCount, sessionTopbarTpl, setScopedSession } from "./session-scope";
import {
  addPendingSession,
  onSessionDragStart,
  endSessionDrag,
  dropPendingSession,
  replacePendingSession,
  groupDmTitle,
  refreshSessions,
  refreshTree,
  renderList,
  sessionsState,
  sessionSlackUrl,
  defaultSessionTitle,
  openSession,
  workingMark,
} from "./sessions";
import {
  backgroundLabel,
  clearWorking,
  conversationBackground,
  cronRowMeta,
  isAbandonedNewChat,
  shouldStartProactiveOpener,
  markWorking,
  chatSurfaceOf,
  watchActivityLabel,
} from "./session-list";
import { liveTurnOf } from "./working-dot";
import {
  GOAL_RESUME_PROMPT,
  goalElapsedLabel,
  goalObjectiveLabel,
  goalWorkedLabel,
  type GoalStripState,
} from "./goal-strip";
import { ackKey, subagentRows, subagentSummary, visibleSubagents, type SubagentRow } from "./subagent-activity";
import { createSwarmStrip } from "./swarm-strip.ts";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";
import { ephemeralEmptyTpl, ephemeralTopbarTpl } from "./ephemeral-chat";
import { createForkOriginController, forkOriginView } from "./fork-origin";
import { sessionPersonaChip } from "./personas";
import { base64ToBytes } from "./paste-text";
import { pageAnchor, storeTranscript } from "./transcript-cache";
import { tip } from "./tooltip";
import { goalWorked, workSeconds, workedLabel } from "./work-duration";
import { liveWorkDuration } from "./live-work-duration";
import { decorateTextCodeBlocks } from "./text-code";

import { createTranscriptViewport, preserveTranscriptScroll } from "./transcript-viewport";
import { suggestedActivities } from "./suggested-activities";
import { reportHandledError } from "./browser-errors.ts";
import { uiCanvasPanel } from "./ui-canvas";

installMarkdownSanitizer();

const detachedAgents = new WeakSet<Agent>();
interface SubagentStop {
  state: "stopping" | "failed";
  run: number | undefined;
  error?: string;
}
const SUBAGENT_STOP_LABEL = { idle: "Stop", stopping: "Stopping…", failed: "Couldn't stop" };
interface SettledRowKey {
  day: string;
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
  forking: boolean;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function markConnectorConnected(provider: string): void {
  if (!provider) return;
  connectedConnectors.add(provider);
  for (const hook of redrawHooks) hook();
}

export function createChatSurface(
  ctx: ConvCtx,
  dependencies: { fetchTranscript?: typeof fetchTranscript; openSession?: typeof openSession } = {},
): ChatSurface {
  const runSlot = createRunSlot((message) => {
    ctx.composer.state.error = message;
  });
  const sideChats = createSideChatController(ctx);
  let pendingFork: { index: number } | null = null;
  const transcriptViewport = createTranscriptViewport({ pinPrompt: pinLatestPrompt });
  const stopPrefsWatch = onChatPrefsChange(() => transcriptViewport.refresh());
  let preserveConnectionScroll = isConnectionReturn();
  let connectionReturnMessageCount: number | null = null;
  const transcriptFetcher = dependencies.fetchTranscript ?? fetchTranscript;
  const sessionOpener = dependencies.openSession ?? openSession;

  const goalCancels = new Set<string>();
  const goalResumes = new Set<string>();
  const chatState = {
    agent: null as Agent | null,
    host: null as HTMLElement | null,
    threadRef: null as string | null,
    ephemeral: false,
    sessionId: null as string | null,
    scopeId: null as string | null,
    contextName: null as string | null,
    rememberedThreadRef: null as string | null,
    rememberedSessionId: null as string | null,
    rememberedScopeId: null as string | null,
    rememberedContextName: null as string | null,
    liveWork: null as WorkBlock | null,
    goal: null as GoalStripState | null,
    turnRuntime: null as TurnRuntime | null,
    pendingSend: null as string | null,
    normalStreamFn: null as Agent["streamFn"] | null,
    onWork: null as ((work: WorkBlock) => void) | null,
    resolvingApprovals: new Set<string>(),
    declineApprovalsOnSend: false,
    transcriptAnchorSeq: null as number | null,
    earlierCount: 0,
    loadingEarlier: false,
    forkSession: null as CoreSession | null,
    inheritedMessages: [] as ReturnType<typeof itemsToMessages>,
    inheritedExpanded: false,
    inheritedLoaded: false,
    pins: [] as SessionPin[],
    pinsExpanded: false,
    labelSpeakers: false,
    assistantSpeakerLabel: "",
  };

  const inlineSteers = new Map<number, { message: AgentMessage; index: number }>();
  let continuedSpeakerRows = new Set<AgentMessage>();
  let versions = replyVersions([]);
  let slackReactions = collectReactions([], messageText);
  const slackOutbox = new SlackOutbox();
  const steerMessageCache = new WeakMap<WorkBlock["activity"], Array<{ seq: number; message: AgentMessage }>>();

  function prepareMessageRows(messages: AgentMessage[]): void {
    inlineSteers.clear();
    versions = replyVersions(messages);
    const messageIndices = new Map(
      messages.map((message, index) => [(message as { entrySeq?: number }).entrySeq, index]),
    );
    for (const message of messages) {
      const activity = (message as AssistantWork).work?.activity;
      if (!activity || isReadOnlySlackView()) continue;
      let steers = steerMessageCache.get(activity);
      if (!steers) {
        steers = activityItems(activity).flatMap((item) => {
          if (item.kind !== "SteeringMessage") return [];
          const user = userItemMessage(item);
          return user ? [{ seq: item.seq, message: user as AgentMessage }] : [];
        });
        steerMessageCache.set(activity, steers);
      }
      for (const steer of steers) {
        const index = messageIndices.get(steer.seq);
        inlineSteers.set(steer.seq, {
          message: index === undefined ? steer.message : messages[index]!,
          index:
            index === undefined ? -1 : index - (chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0),
        });
      }
    }
    updateSpeakerLabels([...messages, ...[...inlineSteers.values()].map((steer) => steer.message)]);
    slackReactions = collectReactions(isReadOnlySlackView() ? messages : [], (message) =>
      message.role === "assistant" ? assistantDisplayText(messageText(message)) : messageText(message),
    );
    continuedSpeakerRows = continuedSpeakers(
      isReadOnlySlackView(),
      messages.filter((m) => !hiddenMessage(m) && !rendersInsideWork(m) && !slackReactions.reactionRows.has(m)),
    );
  }

  function isSideChatSurface(): boolean {
    return Boolean(ctx.container()?.closest(".side-chat-panel"));
  }

  function updateSpeakerLabels(messages: AgentMessage[]): void {
    const names = new Set<string>();
    for (const m of messages) {
      const speaker = (m as { role?: string; speaker?: string }).speaker;
      if ((m as { role?: string }).role === "user" && typeof speaker === "string" && speaker.trim())
        names.add(speaker.trim());
    }
    const viewer = appState.me?.displayName?.trim().toLowerCase();
    chatState.labelSpeakers =
      isSideChatSurface() ||
      isReadOnlySlackView() ||
      names.size > 1 ||
      (Boolean(viewer) && [...names].some((n) => n.toLowerCase() !== viewer));
    chatState.assistantSpeakerLabel = chatState.labelSpeakers ? brandName() : "";
  }

  function speakerLabelFor(message: AgentMessage): string | undefined {
    if (!chatState.labelSpeakers) return undefined;
    const speaker = (message as { speaker?: string }).speaker;
    if (typeof speaker === "string" && speaker.trim()) return speaker.trim();
    return isSideChatSurface() ? appState.me?.displayName || "You" : undefined;
  }

  function speakerMember(message: AgentMessage): { principalId: string; avatarUrl?: string } | undefined {
    const speakerId = (message as { speakerId?: string }).speakerId;
    if (!speakerId) return undefined;
    const project = contextsState.list.find((c) => c.scopeId === chatState.scopeId)?.project;
    const member = project?.members.find((m) => m.principalId === speakerId);
    if (member?.avatarUrl) return member;
    return { principalId: speakerId, avatarUrl: speakerAvatar(speakerId) };
  }

  function speakerTime(message: AgentMessage): TemplateResult | typeof nothing {
    const ts = (message as { timestamp?: number }).timestamp;
    return (isSideChatSurface() || isReadOnlySlackView()) && ts !== undefined
      ? html`<time class="speaker-time">${formatMessageTime(ts)}</time>`
      : nothing;
  }

  function speakerLabelTpl(speaker: string | undefined, message: AgentMessage): TemplateResult | typeof nothing {
    if (!speaker || continuedSpeakerRows.has(message)) return nothing;
    const member = speakerMember(message);
    return html`<div class="speaker-label">
      ${avatarTpl({ key: member?.principalId ?? speaker, name: speaker, avatarUrl: member?.avatarUrl })}<span
        title=${speaker}
        >${isSideChatSurface() || isReadOnlySlackView() ? speaker : speaker.split(/\s+/, 1)[0]!.toLowerCase()}</span
      >${speakerTime(message)}
    </div>`;
  }
  let transcriptRefreshGeneration = 0;
  let approvalsEpoch = 0;
  const forkOriginController = createForkOriginController({
    state: chatState,
    load: async () => {
      const session = chatState.forkSession;
      if (!session) return [];
      const items = await loadInheritedTranscript(session, [], transcriptFetcher);
      return itemsToMessages(items, transcriptModel());
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
      drawActiveChat();
    },
    setError: (error) => {
      ctx.composer.state.error = error;
    },
  });

  async function openSessionById(sourceId: string): Promise<void> {
    try {
      const listed = sessionsState.list.find((session) => session.id === sourceId);
      const page = await transcriptFetcher(sourceId, { tailTurns: TAIL_TURNS });
      const source = listed ?? page.session;
      if (!source) throw new Error("missing session");
      await sessionOpener(source, Promise.resolve(page));
    } catch {
      ctx.composer.state.error = "Couldn't open that session.";
      redrawTranscript();
    }
  }

  let ctaThreadRef: string | null | undefined;
  let ctaText = CHAT_CTAS[0]!;
  let workTicker: ReturnType<typeof setInterval> | null = null;
  let liveWorkExpanded = false;
  let liveFoldOpened = false;
  const liveStepLine = createLiveStepLine(() => drawActiveChat());
  const openThinking = new Set<string>();

  function notePendingSessionOnSend(): void {
    if (chatState.ephemeral || !chatState.threadRef || chatState.sessionId !== null) return;
    const existing = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
    if (existing) {
      if (chatState.agent) adoptActiveSessionFromList(chatState.agent);
      return;
    }
    addPendingSession(chatState.threadRef, chatState.scopeId, chatState.contextName);
  }

  function teardownActiveChat(): void {
    cleanupEphemeral();
    chatState.ephemeral = false;
    sideChats.dispose();
    transcriptViewport.dispose();
    transcriptRefreshGeneration++;
    readOnly.clear();
    preserveOutgoingWorkingDot(null);
    detachActiveChat();
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

  function cleanupEphemeral(keepalive = false): void {
    if (!chatState.ephemeral || !chatState.threadRef) return;
    const hasSent = (chatState.agent?.state.messages.length ?? 0) > 0 || chatState.sessionId !== null;
    if (hasSent) void deleteEphemeralSession(chatState.threadRef, keepalive);
  }

  function newTemporaryChat(): string {
    appState.currentView = "chats";
    renderSidebarTop();
    const threadRef = `web:${appState.me?.user ?? "anon"}:${crypto.randomUUID()}`;
    ctx.composer.resetComposer();
    forkOriginController.reset();
    mountContinuable(threadRef, null, null, [], null, undefined, [], true);
    renderList();
    ctx.composer.focusComposerEnd();
    return threadRef;
  }

  function newChat(
    context?: { scopeId: string; name: string | null },
    threadRef = `web:${appState.me?.user ?? "anon"}:${crypto.randomUUID()}`,
  ): string {
    appState.currentView = "chats";
    renderSidebarTop();
    const user = appState.me?.user ?? "anon";
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
    const live = liveTurnOf(chatState);
    if (!live || live === nextThreadRef) return;
    sessionsState.list = markWorking(sessionsState.list, live);
  }

  function detachActiveChat(): void {
    if (chatState.host) render(nothing, chatState.host);
    if (!chatState.agent) return;
    detachedAgents.add(chatState.agent);
    chatState.agent.abort();
  }

  function bindAgentLifecycle(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    hooks: {
      onEvent?: (e: { type: string }) => void;
      isWorking?: () => boolean;
      beforeRefresh?: () => void;
      afterRefresh?: (wasUnsaved: boolean) => void;
    } = {},
  ): void {
    let listedWorking = false;
    agent.subscribe((e) => {
      hooks.onEvent?.(e);
      scheduleStreamDraw(agent);
      if (e.type === "agent_end" && !detachedAgents.has(agent))
        sessionsState.list = clearWorking(sessionsState.list, threadRef);
      const working = hooks.isWorking ? hooks.isWorking() : agent.state.isStreaming;
      if (working !== listedWorking || e.type === "agent_end") {
        listedWorking = working;
        renderList();
      }
      if (e.type !== "agent_end") return;
      void agent
        .waitForIdle()
        .then(async () => {
          if (agent === chatState.agent) clearLiveWork();
          const wasUnsaved = agent === chatState.agent && chatState.sessionId === null;
          try {
            await refreshSessions({ silent: true });
          } catch (error) {
            reportHandledError("web:sessions_refresh", error);
          }
          if (!detachedAgents.has(agent)) {
            sessionsState.list = clearWorking(sessionsState.list, threadRef);
            renderList();
          }
          if (agent !== chatState.agent) return;
          hooks.beforeRefresh?.();
          await refreshTranscriptFromItems(agent);
          hooks.afterRefresh?.(wasUnsaved);
          void followNextQueuedRun(agent, threadRef, normalStreamFn, onWork);
        })
        .catch((error: unknown) => reportHandledError("web:agent_idle", error));
    });
  }

  function mountContinuable(
    threadRef: string,
    sessionId: string | null,
    scopeId: string | null,
    messages: ReturnType<typeof itemsToMessages>,
    contextName: string | null = null,
    session?: CoreSession,
    inheritedMessages: ReturnType<typeof itemsToMessages> = [],
    ephemeral = false,
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    if (chatState.ephemeral && chatState.threadRef !== threadRef) cleanupEphemeral();
    readOnly.clear();
    preserveOutgoingWorkingDot(threadRef);
    dropAbandonedNewChat(threadRef);
    detachActiveChat();
    ctx.composer.resetComposer();
    forkOriginController.reset();
    chatState.ephemeral = ephemeral;
    chatState.threadRef = threadRef;
    chatState.sessionId = sessionId;
    chatState.scopeId = scopeId;
    chatState.contextName = contextName;
    chatState.forkSession = session ?? null;
    chatState.inheritedMessages = inheritedMessages;
    chatState.inheritedExpanded = false;
    chatState.inheritedLoaded = !session?.forkedFrom;
    chatState.rememberedThreadRef = ephemeral ? null : threadRef;
    chatState.rememberedSessionId = ephemeral ? null : sessionId;
    chatState.rememberedScopeId = ephemeral ? null : scopeId;
    chatState.rememberedContextName = ephemeral ? null : contextName;
    ctx.composer.state.draft = ephemeral ? "" : storedDraft(threadRef);
    syncLocation();
    chatState.transcriptAnchorSeq = null;
    chatState.earlierCount = 0;
    chatState.loadingEarlier = false;
    chatState.pins = [];
    chatState.goal = null;
    chatState.turnRuntime = null;
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
      convertToLlm: () => [],
    });
    chatState.agent = agent;
    clearLiveWork();
    resetBackgroundPanel();
    chatState.resolvingApprovals.clear();
    openThinking.clear();
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

    let titlePollStarted = false;
    bindAgentLifecycle(agent, threadRef, normalStreamFn, onWork, {
      onEvent: (e) => {
        if (!titlePollStarted && agent.state.isStreaming) {
          titlePollStarted = true;
          const row = sessionsState.list.find((r) => r.threadRef === threadRef);
          if (!row?.title?.trim()) void settleNewSessionTitle(agent, threadRef);
        }
        if (agent === chatState.agent && (agent.state.isStreaming || e.type === "agent_end"))
          chatState.pendingSend = null;
      },
      isWorking: () => agent.state.isStreaming || chatState.pendingSend !== null,
      beforeRefresh: () => adoptActiveSessionFromList(agent),
      afterRefresh: (wasUnsaved) => {
        void ctx.composer.refreshRuntimeSelection(scopeId, agent, true);
        if (wasUnsaved && chatState.sessionId) void settleNewSessionTitle(agent, threadRef);
      },
    });

    container.replaceChildren(chatState.host);
    const opening = startProactiveOpenerIfNew(agent, threadRef, normalStreamFn, onWork, sessionId, scopeId, messages);
    const runningSince = !opening && session?.working ? session.workingSince : undefined;
    if (runningSince !== undefined) void resumeTrackedRun(agent, threadRef, normalStreamFn, onWork, runningSince);
    drawActiveChat(agent, { forceScroll: true });
    const me = appState.me;
    if (!sessionId && me && (scopeId === null || scopeId === me.personalScope)) {
      void loadGeneratedActivities(me, () => {
        if (appState.me === me && chatState.agent === agent && !chatState.sessionId) drawActiveChat(agent);
      });
    }
    ctx.composer.focusComposerEnd();
    ctx.ensureDeliveryStream();
    if (!opening && runningSince === undefined) void resumeTrackedRun(agent, threadRef, normalStreamFn, onWork);
    consumeBackgroundPanelRequest();
  }

  function startProactiveOpenerIfNew(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    sessionId: string | null,
    scopeId: string | null,
    messages: ReturnType<typeof itemsToMessages>,
  ): boolean {
    if (ctx.inbox || hasWelcomeScreen(appState.me) || appEditSlug(threadRef, appState.me?.user)) return false;
    if (
      !shouldStartProactiveOpener({
        started: proactiveOpenerStarted,
        sessionId,
        scopeId,
        messageCount: messages.length,
        loaded: sessionsState.loaded,
        sessions: sessionsState.list,
      })
    )
      return false;
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
    const target = {
      scopeId: chatState.scopeId,
      channelName: chatState.contextName,
      ...(chatState.ephemeral ? { ephemeral: true } : {}),
      ...(chatState.declineApprovalsOnSend ? { declinePendingApprovals: true } : {}),
    };
    if (ctx.composer.followsDefault()) return target;
    return {
      effortLevel: ctx.composer.state.effortLevel,
      fastMode: ctx.composer.state.fastMode,
      ...target,
    };
  }

  function turnRuntime(): TurnRuntime | null {
    return chatState.turnRuntime;
  }

  function inheritedHeader(): TemplateResult | typeof nothing {
    if (ctx.container()?.closest(".side-chat-panel")) return nothing;
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
    sideChats.onDelivery(threadRef);
    const agent = chatState.agent;
    if (!agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    void refreshTranscriptFromItems(agent);
  }

  async function stopLiveRun(): Promise<void> {
    if (runSlot.stopGeneration === runSlot.generation) return;
    const agent = chatState.agent;
    const generation = runSlot.generation;
    requestStop(runSlot);
    drawActiveChat();
    if (!hasLiveRun(runSlot)) return;
    try {
      await signalLiveRun(runSlot, "abort", undefined, { threadRef: chatState.threadRef });
    } catch (err) {
      if (generation !== runSlot.generation || runSlot.stopGeneration !== generation || agent !== chatState.agent)
        return;
      runSlot.stopGeneration = null;
      throw err;
    } finally {
      if (agent === chatState.agent) drawActiveChat();
    }
  }

  function resumeIfIdle(): void {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming || !chatState.threadRef || !chatState.normalStreamFn || !chatState.onWork)
      return;
    void resumeTrackedRun(agent, chatState.threadRef, chatState.normalStreamFn, chatState.onWork);
  }

  let catchingUp = false;

  function catchUp(): void {
    sideChats.catchUp();
    const { agent, threadRef, normalStreamFn, onWork } = chatState;
    if (!agent || agent.state.isStreaming || !threadRef || catchingUp) return;
    catchingUp = true;
    const resumed = normalStreamFn && onWork ? resumeTrackedRun(agent, threadRef, normalStreamFn, onWork) : false;
    void Promise.resolve(resumed)
      .then((ok) =>
        ok || agent !== chatState.agent || agent.state.isStreaming ? undefined : refreshTranscriptFromItems(agent),
      )
      .finally(() => {
        catchingUp = false;
      });
  }

  function syncLocation(): void {
    if (ctx.ownsUrl) syncUrlFromState(chatState.ephemeral ? null : undefined);
    else postCurrentPaneState();
  }

  function redrawForConnector(): void {
    if (chatState.agent) drawActiveChat();
  }

  const stopAvatarWatch = onSpeakerAvatars(() => {
    drawActiveChat();
  });
  const onPageHide = () => cleanupEphemeral(true);
  window.addEventListener("pagehide", onPageHide);

  function dispose(): void {
    window.removeEventListener("pagehide", onPageHide);
    syncSubagentRowsRefresh(null);
    redrawHooks.delete(redrawForConnector);
    stopAvatarWatch();
    stopPrefsWatch();
    teardownActiveChat();
  }

  async function approveDuringRun(agent: Agent, decision: ApprovalDecision): Promise<void> {
    if (chatState.resolvingApprovals.has(decision.requestId)) return;
    chatState.resolvingApprovals.add(decision.requestId);
    ctx.composer.state.error = "";
    drawActiveChat(agent);
    try {
      await resolveApproval(decision);
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not send the approval.");
    } finally {
      if (agent === chatState.agent) {
        chatState.resolvingApprovals.delete(decision.requestId);
        drawActiveChat(agent);
      }
    }
  }

  async function approveCommand(agent: Agent, decision: ApprovalDecision): Promise<void> {
    if (agent !== chatState.agent || !chatState.threadRef) return;
    if (agent.state.isStreaming) {
      if (activePendingApprovals().some((approval) => approval.requestId === decision.requestId))
        await approveDuringRun(agent, decision);
      return;
    }
    if (chatState.resolvingApprovals.size > 0) return;
    chatState.resolvingApprovals.add(decision.requestId);
    approvalsEpoch++;
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
      const submitted = await resolveApproval(decision);
      if (submitted.status === "gone" && agent === chatState.agent) ctx.composer.state.error = APPROVAL_GONE_MESSAGE;
      if (submitted.status === "resumed" && chatState.normalStreamFn && chatState.onWork)
        await resumeRun(
          agent,
          threadRef,
          chatState.normalStreamFn,
          chatState.onWork,
          submitted.runId,
          undefined,
          () => {
            releaseSubmission();
            drawActiveChat(agent);
          },
        );
    } catch (err) {
      if (agent === chatState.agent) {
        ctx.composer.state.error = errMessage(err, "Could not send the approval.");
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
        await refreshTranscriptFromItems(agent);
      }
      const active = chatState.agent;
      if (active) {
        await active.waitForIdle();
        await syncPendingApprovals(active);
        drawActiveChat(active);
      }
    }
  }

  async function resolveCommandApproval(decision: ApprovalDecision): Promise<void> {
    const ro = readOnly.approve(decision);
    if (ro) await ro;
    else if (chatState.agent) await approveCommand(chatState.agent, decision);
  }

  function activePendingApprovals(): PendingApproval[] {
    const agent = chatState.agent;
    if (!agent) return [];
    const streaming = agent.state.isStreaming;
    const byId = new Map<string, PendingApproval>();
    for (const m of agent.state.messages) {
      if ((m as { role?: string }).role !== "assistant") continue;
      for (const approval of (m as AssistantWork).work?.pendingApprovals ?? []) {
        if (streaming && !approvalDecidableDuringRun(approval)) continue;
        if (!chatState.resolvingApprovals.has(approval.requestId)) byId.set(approval.requestId, approval);
      }
    }
    return unresolvedApprovals([...byId.values()]);
  }

  async function syncPendingApprovals(
    agent: Agent,
    messages?: AgentMessage[],
    pending?: Promise<{ approvals: PendingApproval[] } | null>,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const id = chatState.sessionId;
    if (!id || agent !== chatState.agent) return false;
    const r = await (pending ?? fetchSessionApprovals(id));
    if (!r || id !== chatState.sessionId || agent !== chatState.agent || !isCurrent()) return false;
    const target = messages ?? agent.state.messages;
    for (const message of target) delete (message as AssistantWork).work?.pendingApprovals;
    attachPendingApprovals(target, r.approvals ?? [], transcriptModel());
    if (target === agent.state.messages) approvalsEpoch++;
    return true;
  }

  function attachApprovalsWhenLoaded(
    sessionId: string,
    pending: Promise<{ approvals: PendingApproval[] } | null>,
  ): void {
    const agent = chatState.agent;
    if (!agent || chatState.sessionId !== sessionId) return;
    const epoch = approvalsEpoch;
    const isCurrent = (): boolean =>
      epoch === approvalsEpoch &&
      !agent.state.isStreaming &&
      chatState.pendingSend === null &&
      chatState.resolvingApprovals.size === 0;
    const nonEmpty = pending.then(async (r) => {
      await transcriptRefreshesSettled();
      return r?.approvals.length ? r : null;
    });
    void syncPendingApprovals(agent, undefined, nonEmpty, isCurrent).then((attached) => {
      if (attached) drawActiveChat(agent);
    });
  }

  let transcriptRefresh: Promise<void> = Promise.resolve();

  function refreshTranscriptFromItems(agent: Agent): Promise<void> {
    const refresh = replaceTranscriptFromItems(agent);
    transcriptRefresh = refresh;
    return refresh;
  }

  async function transcriptRefreshesSettled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = transcriptRefresh;
      await current.catch(() => undefined);
    } while (current !== transcriptRefresh);
  }

  function pageMessages(page: TranscriptPage): AgentMessage[] {
    const split = inheritedTranscript(chatState.forkSession ?? {}, page.items);
    return itemsToMessages(split.current, transcriptModel());
  }

  function commitTranscriptPage(agent: Agent, page: TranscriptPage, messages: AgentMessage[]): void {
    const fork = chatState.forkSession ?? {};
    chatState.pins = page.pins ?? [];
    chatState.goal = page.goal ?? null;
    if (page.runtime) chatState.turnRuntime = page.runtime;
    const refreshedInherited = inheritedRefreshItems(fork, page.items, chatState.inheritedLoaded);
    if (refreshedInherited) chatState.inheritedMessages = itemsToMessages(refreshedInherited, transcriptModel());
    agent.state.messages = messages;
    approvalsEpoch++;
    chatState.earlierCount = currentEarlierCount(fork, page.earlierItems ?? 0);
    chatState.transcriptAnchorSeq = pageAnchor(page);
  }

  function transcriptAnchor(): number | null {
    return chatState.transcriptAnchorSeq;
  }

  function applyTranscript(
    s: CoreSession,
    page: TranscriptPage,
    approvals: Promise<{ approvals: PendingApproval[] } | null> | null,
    mountedAnchor: number | null,
  ): Promise<void> {
    if (chatState.sessionId !== s.id || chatState.loadingEarlier || transcriptAnchor() !== mountedAnchor)
      return Promise.resolve();
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming) return Promise.resolve();
    const generation = ++transcriptRefreshGeneration;
    const original = agent.state.messages;
    const isCurrent = (): boolean =>
      generation === transcriptRefreshGeneration &&
      s.id === chatState.sessionId &&
      agent === chatState.agent &&
      !agent.state.isStreaming &&
      agent.state.messages === original;
    const refresh = (async () => {
      const messages = pageMessages(page);
      if (approvals) {
        await syncPendingApprovals(agent, messages, approvals, isCurrent);
        if (!isCurrent()) return;
      }
      commitTranscriptPage(agent, page, messages);
      drawActiveChat(agent);
    })();
    transcriptRefresh = refresh;
    return refresh;
  }

  async function replaceTranscriptFromItems(agent: Agent): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || agent !== chatState.agent || agent.state.isStreaming) return drawActiveChat(agent);
    const generation = ++transcriptRefreshGeneration;
    const originalMessages = agent.state.messages;
    const last = originalMessages.at(-1) as AssistantWork | undefined;
    const isCurrent = (): boolean =>
      generation === transcriptRefreshGeneration &&
      sessionId === chatState.sessionId &&
      agent === chatState.agent &&
      !agent.state.isStreaming &&
      agent.state.messages === originalMessages &&
      agent.state.messages.at(-1) === last;
    if (last?.stopReason === "error" && !last.interruptedRunId) return drawActiveChat(agent);
    try {
      if (last?.stopReason === "error" && last.interruptedRunId) {
        const run = await api<RunPoll>(`/api/runs/${encodeURIComponent(last.interruptedRunId)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!isCurrent()) return;
        if (
          !runIsTerminal(run) ||
          run.status === "failed" ||
          !["ok", "silent", "react"].includes(run.result?.status ?? "")
        )
          return drawActiveChat(agent);
      }
      const anchor = chatState.transcriptAnchorSeq;
      const page = await transcriptFetcher(sessionId, anchor !== null ? { sinceSeq: anchor } : undefined);
      if (!isCurrent()) return;
      if (last?.stopReason === "error" && !hasRecordedRunReply(page.items, last.interruptedRunId!))
        return drawActiveChat(agent);
      const messages = pageMessages(page);
      if (last?.stopReason === "aborted" && !savedStopOrNewerTurn(originalMessages, messages))
        return drawActiveChat(agent);
      await syncPendingApprovals(agent, messages);
      if (!isCurrent()) return;
      commitTranscriptPage(agent, page, messages);
      if (anchor === null) storeTranscript(sessionId, page);
    } catch (error) {
      reportHandledError("web:transcript_refresh", error);
    }
    drawActiveChat(agent);
  }

  function savedStopOrNewerTurn(local: AgentMessage[], saved: AgentMessage[]): boolean {
    const turns = (messages: AgentMessage[]) => messages.filter((message) => message.role === "user").length;
    return (saved.at(-1) as AssistantWork | undefined)?.stopReason === "aborted" || turns(saved) > turns(local);
  }

  function observeLiveWork(agent: Agent): (work: WorkBlock) => void {
    const tellEmbedder = tellEmbedderOfFinishedTools();
    return (work: WorkBlock) => {
      if (agent !== chatState.agent) return;
      tellEmbedder(work);
      appendConsumedSteers(agent.state.messages, work);
      if (work.runtime && switchedDefault(work.runtime) && work.runtime.modelId !== chatState.turnRuntime?.modelId)
        void ctx.composer.followScopeDefault(agent);
      if (work.runtime) chatState.turnRuntime = work.runtime;
      else if (work !== chatState.liveWork) chatState.turnRuntime = null;
      chatState.liveWork = work;
      syncWorkTicker();
      scheduleStreamDraw(agent);
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
    } catch (error) {
      reportHandledError("web:reattach_active_run", error);
      return;
    }
    if (agent !== chatState.agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    const next = ctx.composer.queuedRunsFor(threadRef).find((r) => r.runId === active.runId);
    ctx.composer.setQueuedRuns(threadRef, active.queued);
    if (!active.runId || !active.run || runIsTerminal(active.run)) return drawActiveChat(agent);
    const recorded = (agent.state.messages.at(-1) as { role?: string } | undefined)?.role === "user";
    if (active.run.input) agent.state.messages = continuableMessages(agent.state.messages, active.run.input).messages;
    else if (!recorded && !next) agent.state.messages = [...agent.state.messages, resumeAnchor()];
    agent.streamFn = makeRunResumeStreamFn(active.runId, active.run, onWork, runSlot);
    try {
      await (!active.run.input && next && !recorded ? agent.prompt(next.text) : agent.continue());
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not follow the queued message.");
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromItems(agent);
      }
    }
  }

  async function resumeTrackedRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    runningSince?: number,
  ): Promise<boolean> {
    const lookup = activeRunForThread(threadRef).then(
      (activeRun) => {
        if (agent === chatState.agent && threadRef === chatState.threadRef)
          ctx.composer.setQueuedRuns(threadRef, activeRun.queued);
        return activeRun.runId && activeRun.run && !runIsTerminal(activeRun.run)
          ? { runId: activeRun.runId, run: activeRun.run }
          : null;
      },
      (error: unknown) => {
        reportHandledError("web:resume_active_run", error);
        return null;
      },
    );
    if (runningSince !== undefined)
      return resumeRun(agent, threadRef, normalStreamFn, onWork, lookup, undefined, undefined, runningSince);
    const located = await lookup;
    return located ? resumeRun(agent, threadRef, normalStreamFn, onWork, located.runId, located.run) : false;
  }

  async function resumeRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    target: string | Promise<LocatedRun | null>,
    initialRun?: RunPoll,
    onStarted?: () => void,
    runningSince?: number,
  ): Promise<boolean> {
    if (
      agent !== chatState.agent ||
      (ctx.inbox ? !ctx.visible() : appState.currentView !== "chats") ||
      agent.state.isStreaming
    )
      return false;
    if (typeof target === "string") {
      await refreshTranscriptFromItems(agent);
      if (agent !== chatState.agent || agent.state.isStreaming) return false;
      if (!initialRun) initialRun = await api<RunPoll>(`/api/runs/${encodeURIComponent(target)}`);
      if (agent !== chatState.agent || agent.state.isStreaming) return false;
    }
    const { messages: msgs, popped } = continuableMessages(agent.state.messages, initialRun?.input);
    agent.state.messages = msgs;
    const seedText = popped
      .map((m) => messageText(m).trim())
      .filter(Boolean)
      .join("\n\n");
    const run =
      typeof target === "string"
        ? target
        : target.then((located) => {
            if (located && agent === chatState.agent)
              agent.state.messages = continuableMessages(agent.state.messages, located.run.input).messages;
            return located;
          });
    const seed =
      runningSince === undefined
        ? undefined
        : { startedAt: runningSince, activity: popped.flatMap((m) => (m as AssistantWork).work?.activity ?? []) };
    agent.streamFn = makeRunResumeStreamFn(run, initialRun, onWork, runSlot, seedText, seed);
    try {
      const completion = agent.continue();
      if (agent.state.isStreaming) onStarted?.();
      await completion;
    } catch (err) {
      if (agent === chatState.agent)
        ctx.composer.state.error = errMessage(err, "Could not reconnect to the running task.");
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromItems(agent);
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
  }

  function postCurrentPaneState(): void {
    if (!ctx.pane) return;
    const live = liveTurnOf(chatState);
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

  function mountLoadingPane(): () => boolean {
    dropAbandonedNewChat(null);
    teardownActiveChat();
    const container = ctx.container();
    if (!container) return () => false;
    const host = document.createElement("div");
    host.className = "custom-chat";
    render(
      html`<div class="custom-chat-shell">
        <div class="chat-loading">${waveLoader()}</div>
      </div>`,
      host,
    );
    container.replaceChildren(host);
    return () => container.contains(host);
  }

  function mountLoadError(retry: () => void): void {
    const container = ctx.container();
    if (!container) return;
    const host = document.createElement("div");
    host.className = "empty compact";
    render(
      html`<p role="alert">Couldn't load this conversation.</p>
        <button class="btn" @click=${retry}>Retry</button>`,
      host,
    );
    container.replaceChildren(host);
  }

  const readOnly = createReadOnlySession({
    slackOutbox,
    resolvingApprovals: chatState.resolvingApprovals,
    onRedraw: () => drawActiveChat(),
    onDelivery,
    onScrollToBottom: scrollToBottom,
    onError: (message) => {
      ctx.composer.state.error = message;
    },
  });

  function mountReadOnly(
    s: CoreSession,
    messages: ReturnType<typeof itemsToMessages>,
    earlierCount = 0,
    anchorSeq: number | null = null,
    inheritedMessages: ReturnType<typeof itemsToMessages> = [],
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    const sameSession = readOnly.session()?.id === s.id;
    preserveOutgoingWorkingDot(s.threadRef);
    dropAbandonedNewChat(s.threadRef);
    detachActiveChat();
    clearLiveWork();
    chatState.host = null;
    ctx.composer.resetComposer();
    if (!sameSession) forkOriginController.reset();
    chatState.threadRef = s.threadRef;
    chatState.sessionId = s.id;
    chatState.scopeId = s.scopeId;
    chatState.forkSession = s;
    chatState.transcriptAnchorSeq = anchorSeq;
    chatState.earlierCount = earlierCount;
    chatState.loadingEarlier = false;
    if (!(sameSession && chatState.inheritedLoaded)) {
      chatState.inheritedMessages = inheritedMessages;
      chatState.inheritedLoaded = !s.forkedFrom;
    }
    if (!sameSession) {
      chatState.inheritedExpanded = false;
      chatState.pins = [];
      chatState.goal = null;
      chatState.turnRuntime = null;
    }
    syncLocation();
    resetBackgroundPanel();
    const agent = new Agent({
      initialState: { systemPrompt: "", model: transcriptModel(), messages, tools: [] },
      convertToLlm: () => [],
    });
    chatState.agent = agent;
    chatState.resolvingApprovals.clear();
    openThinking.clear();
    const onWork = observeLiveWork(agent);
    const normalStreamFn = makeCoreStreamFn(s.threadRef, agent, currentTurnOptions, onWork, runSlot);
    agent.streamFn = normalStreamFn;
    chatState.normalStreamFn = normalStreamFn;
    chatState.onWork = onWork;
    const priorHost = sameSession ? container.querySelector<HTMLElement>(":scope > .readonly-chat") : null;
    const restoreScroll = priorHost ? preserveTranscriptScroll(priorHost) : null;
    const host = priorHost ?? document.createElement("div");
    host.className = `custom-chat readonly-chat ${s.surface === "slack" ? "slack-thread-chat" : ""}`;
    chatState.host = host;
    readOnly.activate(s, container, sameSession, messages);
    bindAgentLifecycle(agent, s.threadRef, normalStreamFn, onWork, {
      afterRefresh: () => void readOnly.refreshApprovals(),
    });
    void readOnly.refreshApprovals();
    drawActiveChat(agent);
    if (!priorHost) container.replaceChildren(host);
    if (!restoreScroll || readOnly.consumeFollowSend()) scrollToBottom();
    else restoreScroll();
    ctx.ensureDeliveryStream();
    const runningSince = s.working ? s.workingSince : undefined;
    void resumeTrackedRun(agent, s.threadRef, normalStreamFn, onWork, runningSince);
    consumeBackgroundPanelRequest();
  }

  function mountReadOnlyPage(s: CoreSession, page: TranscriptPage): void {
    const split = inheritedTranscript(s, page.items);
    mountReadOnly(
      s,
      itemsToMessages(split.current, transcriptModel()),
      currentEarlierCount(s, page.earlierItems ?? 0),
      page.items?.[0]?.seq ?? null,
      itemsToMessages(split.inherited, transcriptModel()),
    );
    setPins(page.pins ?? []);
  }

  function welcomeGreeting(animate = true): TemplateResult {
    return html`
      <article class="message-row assistant-row welcome-greeting">
        <div class="assistant-body">
          <qm-onboarding-welcome
            .me=${appState.me}
            .animateWelcome=${animate}
            .onIdea=${(prompt: string) => chatState.agent && ctx.composer.fillSuggestedPrompt(prompt, chatState.agent)}
            .base=${withBase("")}
          ></qm-onboarding-welcome>
        </div>
      </article>
    `;
  }

  function setTurnRuntime(runtime: TurnRuntime | null): void {
    chatState.turnRuntime = runtime;
    if (chatState.agent) drawActiveChat(chatState.agent);
  }

  function setGoal(goal: GoalStripState | null): void {
    chatState.goal = goal;
    if (chatState.agent) drawActiveChat(chatState.agent);
  }

  function setPins(pins: SessionPin[]): void {
    chatState.pins = pins;
    drawActiveChat();
  }

  function togglePins(e: Event): void {
    if ((e.target as Element | null)?.closest("a")) return;
    chatState.pinsExpanded = !chatState.pinsExpanded;
    drawActiveChat();
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
            : html`<div class="pinned-strip-peek">
                ${markdown(first.text ?? first.preview ?? `entry #${first.entrySeq}`)}
              </div>`
        }
        <button class="pinned-strip-toggle" aria-expanded=${expanded} title=${expanded ? "Collapse pins" : "Show pins"}>
          ${icon(expanded ? ChevronUp : ChevronDown, 13)}
        </button>
      </div>
      ${
        expanded
          ? pins.map(
              (p) =>
                html`<div class="pinned-item">
                  <div class="pinned-item-text">${markdown(p.text ?? p.preview ?? `entry #${p.entrySeq}`)}</div>
                  ${p.text && p.preview ? html`<div class="pinned-item-preview">${markdown(p.preview)}</div>` : nothing}
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

  function earlierNotice(): TemplateResult {
    return html`<div class="earlier-messages">
      <button
        class="earlier-messages-btn"
        ?disabled=${chatState.loadingEarlier}
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
    if (!agent || !sessionId || anchor === null || chatState.loadingEarlier) return;
    chatState.loadingEarlier = true;
    transcriptViewport.cancelFollow();
    drawActiveChat(agent);
    try {
      const page = await fetchTranscript(sessionId, { beforeSeq: anchor, tailTurns: TAIL_TURNS });
      if (agent !== chatState.agent || sessionId !== chatState.sessionId || anchor !== chatState.transcriptAnchorSeq)
        return;
      const split = inheritedTranscript(chatState.forkSession ?? {}, page.items);
      const earlierMessages = itemsToMessages(split.current, transcriptModel());
      if (!chatState.inheritedLoaded)
        chatState.inheritedMessages = [
          ...itemsToMessages(split.inherited, transcriptModel()),
          ...chatState.inheritedMessages,
        ];
      agent.state.messages = [...earlierMessages, ...agent.state.messages];
      const rawRemaining = page.earlierItems ?? 0;
      chatState.transcriptAnchorSeq = rawRemaining > 0 ? (page.items?.[0]?.seq ?? null) : null;
      chatState.earlierCount = currentEarlierCount(chatState.forkSession ?? {}, rawRemaining);
      chatState.loadingEarlier = false;
      drawActiveChat(agent);
    } catch (error) {
      reportHandledError("web:load_earlier", error);
    } finally {
      if (agent === chatState.agent && sessionId === chatState.sessionId && chatState.loadingEarlier) {
        chatState.loadingEarlier = false;
        drawActiveChat(agent);
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
      if (runSlot.stopGeneration === runSlot.generation) return "Stopping…";
      if (currentTextPhase(work)?.phase === "final_answer") return "Responding…";
      const summary = liveWorkSummary(work);
      if (!summary) return "Thinking…";
      return summary.detail ? `${summary.label}: ${summary.detail}` : summary.label;
    }
    return null;
  }

  ctx.onDensityChange(() => drawActiveChat());

  function drawActiveChat(agent = chatState.agent, opts: { forceScroll?: boolean } = {}): void {
    const roSession = readOnly.session();
    if (
      ctx.composerOnly ||
      !agent ||
      agent !== chatState.agent ||
      !chatState.host ||
      (!roSession && !ctx.inbox && appState.currentView !== "chats")
    )
      return;
    for (const message of agent.state.messages) {
      const work = (message as AssistantWork).work;
      if (work?.pendingApprovals) work.pendingApprovals = unresolvedApprovals(work.pendingApprovals);
    }
    if (!roSession) {
      adoptActiveSessionFromList(agent);
      if (!ctx.visible()) {
        postCurrentPaneState();
        return;
      }
    }
    transcriptViewport.beforeRender();
    const currentMessages = visibleMessages(agent);
    if (roSession) {
      readOnly.confirmSlackMessages(currentMessages);
    } else {
      if (preserveConnectionScroll) {
        connectionReturnMessageCount ??= currentMessages.length;
        if (connectionReturnMessageCount !== currentMessages.length) preserveConnectionScroll = false;
      }
      sideChats.sync();
    }
    const messages = [
      ...(chatState.inheritedExpanded ? chatState.inheritedMessages : []),
      ...currentMessages,
      ...(roSession ? readOnly.pendingSlackMessages() : []),
    ];
    prepareMessageRows(messages);
    const isNewUser = sessionsState.list.filter((s) => s.id).length === 0;
    const editingApp = appEditSlug(chatState.threadRef, appState.me?.user);
    const welcome = welcomeLayout({
      me: appState.me,
      sessions: sessionsState.list,
      threadRef: chatState.threadRef,
      scopeId: chatState.scopeId,
      isNewUser,
      empty: !messages.length,
      draft: Boolean(ctx.composer.state.draft),
    });
    const showWelcome = !chatState.ephemeral && !ctx.inbox && !editingApp && welcome.show;
    let messageContent: Array<TemplateResult | typeof nothing> | TemplateResult | typeof nothing = nothing;
    const inheritedOffset = chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0;
    if (messages.length) {
      messageContent = messages.map(
        (m, i) =>
          html`${settledChatMessage(m, i - inheritedOffset, agent.state.isStreaming && m === agent.state.streamingMessage)}${roSession ? nothing : sideChats.markers(messageEntrySeqs(m), i - inheritedOffset + chatState.inheritedMessages.length)}`,
      );
    }
    const tier = ctx.density();
    const glanceTier = tier === "card" || tier === "strip" ? tier : null;
    const emptyChat = !messages.length && (showWelcome || !chatState.forkSession);
    const showSuggestions =
      !ctx.inbox &&
      emptyChat &&
      !chatState.ephemeral &&
      !editingApp &&
      !welcome.hideSuggestions &&
      !glanceTier &&
      (!ctx.pane || tier === "full") &&
      !chatState.sessionId &&
      (chatState.scopeId === null || chatState.scopeId === appState.me?.personalScope) &&
      !agent.state.isStreaming;
    const me = appState.me;
    const redrawSuggestions = () => {
      if (appState.me === me && !chatState.sessionId) drawActiveChat();
    };
    const suggestions = showSuggestions
      ? suggestedActivities(me?.suggestedActivities, {
          onSelect: (activity) => ctx.composer.fillSuggestedPrompt(activity.prompt, agent),
          ...(me?.suggestedActivitiesGeneration
            ? { onDismiss: (activity) => dismissGeneratedActivity(me, activity, redrawSuggestions) }
            : {}),
          redraw: redrawSuggestions,
          collapsed: Boolean(
            ctx.composer.state.draft || ctx.composer.state.attachments.length || ctx.composer.state.processingFiles,
          ),
        })
      : nothing;
    let content: TemplateResult;
    if (roSession) {
      const approvals = readOnly.approvals();
      const chatSurface = chatSurfaceOf(roSession);
      const slackReply = readOnly.slackReply();
      const header =
        roSession.surface === "slack"
          ? chatHeader(
              roSession.type === "channel"
                ? slackTitle(defaultSessionTitle(roSession), roSession.title?.trim())
                : groupDmTitle(roSession),
              null,
              messages,
              { shown: 3, named: true },
              openInSurface(sessionSlackUrl(roSession), chatSurface?.label),
            )
          : chatHeader(groupDmTitle(roSession), chatSurface ? chatSurface.label : "Read-only", messages, {
              shown: 5,
              named: false,
            });
      content = html`
        <div class="custom-chat-shell">
          ${header}
          ${
            slackReply
              ? nothing
              : html`<div class="readonly-banner">
                  This conversation is read-only here.${chatSurface ? ` Reply in ${chatSurface.label}.` : ""}
                </div>`
          }
          ${swarmUi.strip(roSession.id)} ${backgroundActivityStrip()}
          ${approvals.length ? ctx.composer.composerApprovalPanel(approvals) : nothing}
          <section class="chat-scroll readonly-scroll" tabindex="0" aria-label="Conversation">
            ${pinnedStrip()}
            <div class="message-stack">
              ${inheritedHeader()} ${chatState.earlierCount > 0 ? earlierNotice() : nothing} ${messageContent}
              ${
                !messages.length && !agent.state.isStreaming
                  ? html`<div class="empty compact">No readable messages in this conversation.</div>`
                  : nothing
              }
              ${liveWorkStatus(agent)}
              ${ctx.composer.state.error ? html`<div class="composer-error inline">${ctx.composer.state.error}</div>` : nothing}
            </div>
          </section>
          <div class="chat-bottom-dock">
            ${goalStrip(agent, { readOnly: true })} ${slackReply ?? nothing} ${scrollBottomButton()}
          </div>
        </div>
      `;
    } else if (ctx.inbox) {
      content = assistantSidebar({
        context: ctx.inbox.context(),
        messages: html`${pinnedStrip()} ${inheritedHeader()} ${chatState.earlierCount > 0 ? earlierNotice() : nothing}
        ${messageContent} ${waitingSteerRows(agent)}
        ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}`,
        status: liveWorkStatus(agent),
        busy: agent.state.isStreaming,
        showPrompts: !messages.length,
        toolbar: html`${goalStrip(agent)} ${ctx.composer.queuedStrip(agent)} ${subagentStrip()}
        ${swarmUi.strip(chatState.sessionId)} ${backgroundActivityStrip()}`,
        composer: ctx.composer.composerForm(agent),
        onPrompt: (prompt) => ctx.composer.fillSuggestedPrompt(prompt, agent),
        onDragEnter: (event) => ctx.composer.onDragEnter(event),
        onDragOver: (event) => ctx.composer.onDragOver(event),
        onDragLeave: (event) => ctx.composer.onDragLeave(event),
        onDrop: (event) => void ctx.composer.onDrop(event, agent),
        overlay: ctx.composer.state.dragging
          ? html`<div class="drop-overlay">
              <div class="drop-overlay-card">${icon(Files, 30)}<span>Drop files or folders to attach</span></div>
            </div>`
          : nothing,
      });
    } else {
      content = html`
        <div class="side-chat-layout" @keydown=${sideChats.onKeydown}>
          <div
            class="custom-chat-shell ${editingApp ? "app-edit-chat" : ""} ${ctx.pane ? "in-pane" : ""} ${ctx.composer.state.dragging ? "dragging" : ""} ${
              emptyChat && !glanceTier && !editingApp ? `empty-chat ${showWelcome ? "welcome-chat" : ""}` : ""
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
            ${uiCanvasPanel(ctx)} ${glanceTier || ctx.pane || editingApp ? nothing : sessionTopbar(emptyChat)}
            ${glanceTier ? paneGlance(agent, messages, glanceTier) : nothing}
            <section
              class="chat-scroll"
              tabindex="0"
              aria-label="Conversation"
              @mouseup=${chatState.ephemeral ? nothing : sideChats.select}
              @mousemove=${chatState.ephemeral ? nothing : sideChats.hover}
              @mouseleave=${chatState.ephemeral ? nothing : sideChats.leave}
              @keyup=${chatState.ephemeral ? nothing : sideChats.select}
              @scroll=${sideChats.onScroll}
            >
              ${pinnedStrip()}
              <div
                class="message-stack ${emptyChat ? "empty-stack" : ""} ${sideChats.hasChats() ? "with-side-chats" : ""}"
              >
                ${showWelcome ? welcomeGreeting(!messages.length) : nothing} ${inheritedHeader()}
                ${chatState.earlierCount > 0 ? earlierNotice() : nothing} ${messageContent} ${waitingSteerRows(agent)}
                ${glanceTier ? nothing : liveWorkStatus(agent)}
                ${emptyChat && chatState.ephemeral ? ephemeralEmptyTpl() : nothing}
                ${
                  emptyChat && !chatState.ephemeral && !isNewUser && !editingApp && !showWelcome
                    ? html`<h1 class="chat-cta">${chatCta()}</h1>`
                    : nothing
                }
                ${ctx.pane ? suggestions : nothing}
                ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}
              </div>
            </section>
            <div class="chat-bottom-dock">
              ${goalStrip(agent)} ${ctx.composer.queuedStrip(agent)} ${subagentStrip()}
              ${swarmUi.strip(chatState.sessionId)} ${backgroundActivityStrip()}
              ${showWelcome && welcome.hideComposer ? nothing : ctx.composer.composerForm(agent)}
              ${ctx.pane ? nothing : suggestions} ${scrollBottomButton()}
            </div>
          </div>
          ${sideChats.view()}
        </div>
      `;
    }
    render(content, chatState.host);
    transcriptViewport.afterRender();
    const host = chatState.host;
    requestAnimationFrame(() => {
      if (chatState.host !== host || chatState.agent !== agent || !host.isConnected) return;
      decorateTextCodeBlocks(host);
      if (roSession) {
        if (opts.forceScroll) scrollToBottom();
        transcriptViewport.sync(host.querySelector<HTMLElement>(".chat-scroll"));
      } else {
        ctx.composer.resizeComposer();
        scrollTranscript(opts.forceScroll);
      }
    });
    if (!roSession) postCurrentPaneState();
  }

  function sessionTopbar(emptyChat = false): TemplateResult | typeof nothing {
    if (chatState.ephemeral) return ephemeralTopbarTpl(emptyChat, () => newTemporaryChat());
    const scope = chatState.scopeId;
    const session = sessionsState.list.find((s) =>
      chatState.sessionId
        ? s.id === chatState.sessionId
        : Boolean(chatState.threadRef) && s.threadRef === chatState.threadRef,
    );
    const currentSession = session ?? chatState.forkSession;
    const parentId = currentSession?.parentSessionId;
    const parent = parentId ? sessionsState.list.find((row) => row.id === parentId) : undefined;
    const title = currentSession?.title?.trim() ?? "";
    const crumb = scope && !scope.startsWith("personal:") ? scopeTitle(scope, chatState.contextName) : null;
    const forkedFrom =
      chatState.forkSession && chatState.sessionId === chatState.forkSession.id
        ? chatState.forkSession.forkedFrom
        : undefined;
    return sessionTopbarTpl({
      sessionId: chatState.sessionId ?? session?.id,
      crumb,
      title,
      parent: parentId
        ? { title: parent?.title?.trim() || "Parent session", onClick: () => void openSessionById(parentId) }
        : null,
      fork: forkedFrom
        ? {
            title: forkedFrom.title?.trim() || "another conversation",
            onClick: () => void forkOriginController.navigate(),
          }
        : null,
      persona: sessionPersonaChip(currentSession),
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
        switchView(tool);
      },
    });
  }

  type Participant = { key: string; name: string; avatarUrl?: string };

  function conversationParticipants(messages: AgentMessage[]): Participant[] {
    const seen = new Map<string, Participant>();
    for (const message of messages) {
      const name = (message as { speaker?: string }).speaker?.trim();
      if (!name) continue;
      const member = speakerMember(message);
      const key = member?.principalId ?? name;
      if (!seen.has(key)) seen.set(key, { key, name, avatarUrl: member?.avatarUrl });
    }
    return [...seen.values()];
  }

  function participantStack(people: Participant[], max: number): TemplateResult | typeof nothing {
    if (!people.length) return nothing;
    const shown = people.slice(0, max);
    const rest = people.slice(max);
    return html`<div class="chat-participants" role="list" aria-label=${`${people.length} participants`}>
      ${shown.map((person) => html`<span role="listitem" class="chat-participant">${avatarTpl(person)}</span>`)}
      ${rest.length ? html`<span class="chat-participant-more" ${tip(rest.map((p) => p.name).join(", "))}>+${rest.length}</span>` : nothing}
    </div>`;
  }

  function peopleNames(people: Participant[], shown: number): string {
    const named = people.slice(0, shown).map((person) => (person.key === appState.me?.user ? "you" : person.name));
    return `${named.join(", ")}${people.length > shown ? ` +${people.length - shown}` : ""}`;
  }

  function chatHeader(
    title: string | TemplateResult,
    subtitle: string | null,
    messages: AgentMessage[],
    people: { shown: number; named: boolean },
    action: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    const participants = conversationParticipants(messages);
    return html`
      <header class="chat-topbar">
        <div class="chat-heading">
          <div class="chat-title" dir="auto">${title}</div>
          ${subtitle === null ? nothing : html`<div class="chat-subtitle">${subtitle}</div>`}
        </div>
        ${participantStack(people.named ? participants.slice(0, people.shown) : participants, people.shown)}
        ${people.named && participants.length ? html`<span class="chat-participant-names">${peopleNames(participants, people.shown)}</span>` : nothing}
        ${action}
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
    return messagesWithStreaming(agent.state.messages, agent.state.streamingMessage);
  }

  function settledChatMessage(
    message: AgentMessage,
    index: number,
    isStreaming: boolean,
  ): TemplateResult | typeof nothing {
    if (rendersInsideWork(message) || versions.absorbed.has(message)) return nothing;
    const msg = message as AssistantWork & {
      stopReason?: string;
      errorMessage?: string;
      approvalDecision?: string;
      sendFailure?: string;
    };
    const work = msg.work;
    const cacheable =
      !isStreaming &&
      !(message as { subagentMail?: SubagentMailRef }).subagentMail &&
      !versions.earlier.has(message) &&
      !activityItems(work?.activity ?? []).some(
        (item) => item.kind === "SteeringMessage" || ["session", "sessions", "subagents"].includes(item.tool ?? ""),
      ) &&
      (!work || ((work.status === "complete" || work.status === "failed") && !work.pendingApprovals?.length));
    if (!cacheable) return chatMessage(message, index, isStreaming);
    const forkable = Boolean(!readOnly.active() && chatState.threadRef && chatState.sessionId && chatState.agent);
    const forking = pendingFork !== null;
    const speaker = speakerLabelFor(message);
    const speakerLabel =
      message.role === "assistant" && chatState.labelSpeakers
        ? `${chatState.assistantSpeakerLabel || brandName()}\n${slackAppIcon(chatState.forkSession, message, appState.me?.slackAppIconUrl) ?? ""}`
        : speaker && `${speaker}\n${speakerMember(message)?.avatarUrl ?? ""}\n${continuedSpeakerRows.has(message)}`;
    const edited = Boolean((message as { edited?: boolean }).edited);
    const deleted = Boolean((message as { deleted?: boolean }).deleted);
    const day = new Date().toDateString();
    const hit = settledRowCache.get(message as object);
    if (
      hit &&
      hit.day === day &&
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
      hit.forking === forking &&
      hit.speakerLabel === speakerLabel &&
      hit.edited === edited &&
      hit.deleted === deleted
    ) {
      return hit.tpl;
    }
    const tpl = chatMessage(message, index, isStreaming);
    settledRowCache.set(message as object, {
      day,
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
      forking,
      speakerLabel,
      edited,
      deleted,
      tpl,
    });
    return tpl;
  }

  function chatMessage(
    message: AgentMessage,
    index: number,
    isStreaming = false,
    inline = false,
  ): TemplateResult | typeof nothing {
    if (hiddenMessage(message) || slackReactions.reactionRows.has(message)) return nothing;
    const role = (message as { role?: string }).role;
    if (!inline && (rendersInsideWork(message) || versions.absorbed.has(message))) return nothing;
    if (role === "user" || role === "user-with-attachments") {
      const mail = (message as { subagentMail?: SubagentMailRef }).subagentMail;
      if (mail) {
        return html`
          <article
            class="message-row subagent-mail-row"
            data-index=${index}
            data-entry-seqs=${messageEntrySeqs(message).join(" ")}
          >
            ${subagentChip(mail.title, mail.sessionId)}
            <span class="subagent-mail-note">${SUBAGENT_MAIL_NOTES[mail.kind] ?? mail.kind.replace(/_/g, " ")}</span>
          </article>
        `;
      }

      const rawText = messageText(message);
      const quote = isSideChatSurface() && index === 0 ? chatState.forkSession?.sideChat?.quote : undefined;
      const excerpt = quote ? sideChatExcerpt(quote) : "";
      const displayText = excerpt && rawText.startsWith(excerpt) ? rawText.slice(excerpt.length) : rawText;
      const attachments = ((message as UserMessageWithAttachments).attachments ?? []) as UserAttachmentView[];
      const sendFailure = (message as { sendFailure?: string }).sendFailure;
      const speaker = speakerLabelFor(message);
      const deleted = Boolean((message as { deleted?: boolean }).deleted);
      const edited = !deleted && Boolean((message as { edited?: boolean }).edited);
      if (ctx.inbox)
        return assistantMessage({
          role: "human",
          text: `${messageText(message)}${edited || deleted ? ` (${deleted ? "deleted" : "edited"})` : ""}`,
          index,
          entrySeqs: messageEntrySeqs(message).join(" "),
          before: html`${speakerLabelTpl(speaker, message)}${attachmentGallery(attachments, userVisual, (attachment) => userAttachmentBadge(attachment, attachments))}`,
          after: sendFailure
            ? html`<div class="send-failure">
                <span>${sendFailure}</span
                ><button class="btn compact" type="button" @click=${() => void retryFailedSend(message, index)}>
                  ${icon(RefreshCw, 12)} Retry
                </button>
              </div>`
            : nothing,
          meta: messageMeta(message, index),
        });
      return html`
        <article
          class="message-row user-row ${speaker ? "named-user-row" : ""} ${inline ? "steered-row" : ""} ${fromSomeoneElse(message, appState.me?.user) ? "others-row" : ""} ${continuedSpeakerRows.has(message) ? "continued-row" : ""} ${slackOutbox.sending(message) ? "sending-row" : ""}"
          data-index=${index}
          data-entry-seqs=${messageEntrySeqs(message).join(" ")}
        >
          ${speakerLabelTpl(speaker, message)}
          ${attachmentGallery(attachments, userVisual, (attachment) => userAttachmentBadge(attachment, attachments))}
          <div
            class="message-bubble user-bubble ${deleted ? "deleted-bubble" : ""}"
            ?hidden=${!messageText(message).trim() && !edited && !deleted}
          >
            <div class="pin-content">
              ${isReadOnlySlackView() ? slackWireBubble(displayText, slackSelf()) : markdown(displayText)}
              ${edited || deleted ? html`<span class="revision-badge">(${deleted ? "deleted" : "edited"})</span>` : nothing}
            </div>
            <button class="pin-toggle" type="button" hidden aria-expanded="false">
              <span class="pin-toggle-label">Show more</span>${icon(ChevronDown, 14)}
            </button>
          </div>
          ${reactionChips(slackReactions.onMessage.get(message))}
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
    if (role === "approval-decision") {
      return html`<article
        class="message-row approval-record-row"
        data-index=${index}
        data-entry-seqs=${messageEntrySeqs(message).join(" ")}
      >
        ${approvalRecord(message as unknown as HistoryApprovalDecision)}
      </article>`;
    }
    if (role === "system-note") {
      const note = message as unknown as HistorySystemNote;
      const row = (body: TemplateResult) => html`
        <article
          class="message-row system-note-row"
          data-index=${index}
          data-entry-seqs=${messageEntrySeqs(message).join(" ")}
        >
          <div class="system-note">${body}</div>
        </article>
      `;
      if (note.note === "notice") return row(html`${note.content}`);
      if (note.note === "goal_cancelled")
        return row(html`Goal cancelled: <span class="system-note-text">${goalObjectiveLabel(note.content)}</span>`);
      const who = note.byAgent ? brandName() : (note.speaker ?? "The user");
      const whose = note.byAgent ? "its" : "their";
      if (note.action === "deleted") return row(html`${who} deleted ${whose} message`);
      const preview = slackPreviewText(note.content, charForName);
      return row(
        html`<span class="system-note-line" title=${preview}
          >${who} edited ${whose}
          message${preview ? html`: <span class="system-note-text">${preview}</span>` : nothing}</span
        >`,
      );
    }
    if (role === "assistant") {
      const msg = (
        versions.superseded.has(message) ? { ...message, content: [] } : (versions.folded.get(message) ?? message)
      ) as AssistantMessage;
      if ((msg as AssistantWork).retryableSend) return nothing;
      const work = (msg as AssistantWork).work;
      const text = assistantDisplayText(messageText(msg)).trim();
      const hasText = Boolean(text);
      const showWork =
        (msg as AssistantWork & { approvalDecision?: string }).approvalDecision !== "denied" &&
        shouldShowWork(work, isStreaming || msg.stopReason === "error" || msg.stopReason === "aborted" ? "" : text);
      const steeringOnly = !showWork && work ? workTimeline(work, text).filter((item) => item.kind === "steer") : [];
      let workView: TemplateResult | typeof nothing =
        work && steeringOnly.length ? html`${steeringOnly.map((item) => renderTimelineItem(item, work))}` : nothing;
      if (showWork) {
        const workText = isStreaming ? messageText(msg) : text;
        workView = workBlock(
          work,
          isStreaming,
          msg.stopReason === "aborted" || msg.stopReason === "error" ? "" : workText,
          (msg as AssistantWork).streamingBaseline ?? "",
        );
      }
      const preStep =
        isStreaming &&
        !showWork &&
        runSlot.stopGeneration !== runSlot.generation &&
        (chatState.liveWork ?? work) === work &&
        preStepWork(work) &&
        !text.trim();
      if (preStep) workView = preStepHead(work);
      if (msg.stopReason === "aborted") {
        workView = work ? workBlock(work, false, "", "", true) : html`<div class="stopped-head">You stopped</div>`;
      }
      const deliveredFiles = (msg as AssistantWork).deliveredFiles;
      const hasVisibleContent =
        showWork ||
        preStep ||
        steeringOnly.length > 0 ||
        hasText ||
        Boolean(deliveredFiles?.length) ||
        msg.content.some((chunk) => chunk.type === "thinking" && chunk.thinking.trim());
      if (!hasVisibleContent && msg.stopReason !== "error" && msg.stopReason !== "aborted") return nothing;
      if (ctx.inbox)
        return assistantMessage({
          role: "agent",
          index,
          entrySeqs: rowEntrySeqs(
            versions,
            message,
            messageEntrySeqs(message).filter((seq) => !inlineSteers.has(seq)),
          ),
          streaming: isStreaming,
          content: html`${workView} ${assistantContent(msg, isStreaming, showWork)} ${assistantFileList(deliveredFiles)}
          ${msg.stopReason === "error" && msg.errorMessage ? html`<div class="composer-error inline">${msg.errorMessage}</div>` : nothing}
          ${replyVersionsPanel(versions, message)}`,
          meta: isStreaming ? nothing : messageMeta(message, index),
        });
      const labeled = chatState.labelSpeakers;
      const workBelow = isReadOnlySlackView();
      return html`
        <article
          class="message-row assistant-row ${labeled ? "named-assistant-row" : ""} ${isStreaming ? "streaming" : ""} ${continuedSpeakerRows.has(message) ? "continued-row" : ""}"
          data-index=${index}
          data-entry-seqs=${rowEntrySeqs(
            versions,
            message,
            messageEntrySeqs(message).filter((seq) => !inlineSteers.has(seq)),
          )}
        >
          ${
            labeled && !continuedSpeakerRows.has(message)
              ? html`<div class="speaker-label">
                  ${brandMark(slackAppIcon(chatState.forkSession, msg, appState.me?.slackAppIconUrl))}<span>${chatState.assistantSpeakerLabel || brandName()}</span>${isReadOnlySlackView() ? appTag() : nothing}${speakerTime(msg)}
                </div>`
              : nothing
          }
          ${viaLine(msg as AssistantWork)}
          <div class="assistant-body">
            ${workBelow ? nothing : workView} ${assistantContent(msg, isStreaming, showWork)}
            ${assistantFileList(deliveredFiles)}
            ${msg.stopReason === "error" && msg.errorMessage ? html`<div class="composer-error inline">${msg.errorMessage}</div>` : nothing}
            ${workBelow && workView !== nothing ? html`<div class="slack-work">${workView}</div>` : nothing}
            ${reactionChips(slackReactions.onMessage.get(message))}
            ${isStreaming ? nothing : messageMeta(message, index)} ${replyVersionsPanel(versions, message)}
          </div>
        </article>
      `;
    }
    return nothing;
  }

  function copyableText(message: AgentMessage): string {
    const raw = message.role === "assistant" ? assistantDisplayText(messageText(message)) : messageText(message);
    if (!isReadOnlySlackView()) return raw;
    const role = (message as { role?: string }).role;
    return role === "user" || role === "user-with-attachments" ? slackWireToPlain(raw) : stripSlackDirectives(raw);
  }

  function messageMeta(message: AgentMessage, index: number): TemplateResult | typeof nothing {
    const text = copyableText(message).trim();
    const ts = (message as { timestamp?: number }).timestamp;
    if (!text && ts === undefined) return nothing;
    const forkable = Boolean(
      !readOnly.active() && index >= 0 && chatState.threadRef && chatState.sessionId && chatState.agent,
    );
    const earlier = versions.earlier.get(message);
    return html`
      <div class="message-meta ${earlier ? "has-versions" : ""}">
        ${ts !== undefined ? html`<span class="message-time">${formatMessageTime(ts)}</span>` : nothing}
        ${earlier ? replyVersionsToggle(message, () => drawActiveChat()) : nothing}
        ${
          text
            ? html`<button
                class="msg-copy"
                type="button"
                ${tip("Copy")}
                aria-label="Copy message"
                @click=${(e: Event) => void copyText(text, e.currentTarget as HTMLButtonElement)}
              >
                ${icon(Copy, 13)}${icon(Check, 13)}
              </button>`
            : nothing
        }
        ${
          chatState.sessionId && messageEntrySeqs(message).length
            ? html`<button
                class="msg-copy"
                type="button"
                ${tip("Copy message link")}
                aria-label="Copy message link"
                @click=${(e: Event) => void copyText(sessionLink(location.origin, UI_BASE, chatState.sessionId!, messageEntrySeqs(message)[0]), e.currentTarget as HTMLButtonElement)}
              >
                ${icon(Link2, 13)}${icon(Check, 13)}
              </button>`
            : nothing
        }
        ${
          forkable
            ? html`<button
                class="msg-copy msg-fork"
                type="button"
                ${tip(pendingFork ? "Forking..." : "Fork conversation from here")}
                aria-label=${pendingFork?.index === index ? "Forking conversation…" : "Fork conversation from here"}
                ?disabled=${pendingFork !== null}
                aria-busy=${pendingFork?.index === index ? "true" : "false"}
                @click=${() => void forkFromMessage(index)}
              >
                ${pendingFork?.index === index ? waveLoader({ width: 13, height: 13, label: "Forking" }) : icon(GitFork, 13)}
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
    if (!agent || !sessionId || pendingFork) return;
    const messages = agent.state.messages;
    if (!messages[index]) return;
    const floorSeq = Math.max(chatState.forkSession?.forkBoundarySeq ?? -1, (chatState.transcriptAnchorSeq ?? 0) - 1);
    const pendingRef = `web:fork:${crypto.randomUUID()}`;
    pendingFork = { index };
    ctx.composer.state.error = "";
    addPendingSession(pendingRef, chatState.scopeId, chatState.contextName, true);
    if (chatState.scopeId) sessionsState.collapsedProjectScopes.delete(chatState.scopeId);
    renderList();
    drawActiveChat();
    try {
      const { items } = await fetchTranscript(sessionId);
      const upToSeq = forkCutSeq(items, messages, index, floorSeq);
      if (upToSeq === undefined) throw new Error("That message is still saving. Try forking again in a moment.");
      const forked = await forkSession(sessionId, upToSeq);
      replacePendingSession(pendingRef, forked.session);
      if (chatState.agent !== agent || chatState.sessionId !== sessionId) return;
      const split = inheritedTranscript(forked.session, forked.items);
      ctx.composer.carryModelPick(sourceThreadRef, forked.session.threadRef);
      mountContinuable(
        forked.session.threadRef,
        forked.session.id,
        forked.session.scopeId,
        itemsToMessages(split.current, transcriptModel()),
        forked.session.channelName ?? null,
        forked.session,
        itemsToMessages(split.inherited, transcriptModel()),
      );
      renderList();
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Could not fork the conversation.");
    } finally {
      pendingFork = null;
      dropPendingSession(pendingRef);
      drawActiveChat();
    }
  }

  function withReturnTo(url: string): string {
    const returnTo = deepLinkPath(UI_BASE, "chats", chatState.sessionId);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}returnTo=${encodeURIComponent(returnTo)}`;
  }

  async function continueAfterConnection(name: string): Promise<void> {
    const agent = chatState.agent;
    if (!agent) return;
    await ctx.composer.refreshRuntimeSelection(chatState.scopeId, agent);
    await ctx.composer.sendSuggestedPrompt(`I connected ${name}. Please continue.`, agent);
  }

  function connectorWidget(link: ConnectorLink): TemplateResult {
    if (link.provider === "slack-bot") return html`<qm-slack-setup></qm-slack-setup>`;
    return connectorCard(link, connectedConnectors.has(link.provider), withReturnTo);
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

  function slackSelf(): string {
    return (appState.me?.user?.split("@")[0] ?? "").trim().toLowerCase();
  }

  function isReadOnlySlackView(): boolean {
    return readOnly.active() && chatState.forkSession?.surface === "slack";
  }

  function workTimeline(work: WorkBlock, finalText: string): TimelineItem[] {
    const timeline = messageWorkTimeline(work, finalText);
    return isReadOnlySlackView() ? timeline.filter((item) => item.kind !== "steer") : timeline;
  }

  function rendersInsideWork(message: AgentMessage): boolean {
    return Boolean((message as { steered?: boolean }).steered) && !isReadOnlySlackView();
  }

  function assistantDisplayText(text: string): string {
    return isReadOnlySlackView() ? stripSlackDirectives(text) : text;
  }

  function assistantText(
    text: string,
    returnKey: string | null,
    body: (text: string) => TemplateResult,
  ): TemplateResult[] {
    const parts: TemplateResult[] = [];
    for (const [partIndex, part] of setupContent(text).entries()) {
      if (part.type !== "text") {
        if (returnKey !== null)
          parts.push(
            html`<qm-onboarding-welcome
              class="inline-setup"
              .me=${appState.me}
              .base=${withBase("")}
              .widget=${part.type === "setup" ? "apps" : part.type}
              .toolkit=${part.type === "setup" ? (part.toolkit ?? "") : ""}
              .onConnected=${continueAfterConnection}
              .returnKey=${`${returnKey}:${partIndex}`}
              .setupOnly=${true}
              .animateWelcome=${false}
            ></qm-onboarding-welcome>`,
          );
        continue;
      }
      const links = part.text.trim() ? connectorLinksIn(part.text, location.origin) : [];
      const shown = links.length ? stripConnectorLinks(part.text, links) : part.text;
      if (shown.trim()) parts.push(body(shown));
      for (const link of links) parts.push(connectorWidget(link));
    }
    return parts;
  }

  function assistantContent(message: AssistantMessage, isStreaming = false, hasWork = false): TemplateResult[] {
    const animating = isStreaming && runSlot.stopGeneration !== runSlot.generation;
    const parts: TemplateResult[] = [];
    const answered = message.content.some((chunk) => chunk.type === "text" && chunk.text.trim());
    const finishedWork = isStreaming || !answered ? undefined : (message as AssistantWork).work;
    if (finishedWork)
      for (const draft of retractedReplies(finishedWork)) parts.push(retractedRow(draft.reason, draft.text));
    for (const [chunkIndex, chunk] of message.content.entries()) {
      if (chunk.type === "text") {
        const work = (message as AssistantWork).work;
        const phase = work ? currentTextPhase(work) : null;
        const streamingFinal = isStreaming && phase?.phase === "final_answer";
        const workActive =
          hasWork && isStreaming && !streamingFinal && (work?.status === "working" || work?.status === "thinking");
        const text = isStreaming && work ? streamedAnswer(chunk.text, work) : chunk.text;
        const baseline = (message as AssistantWork).streamingBaseline ?? "";
        parts.push(
          ...assistantText(
            assistantDisplayText(workActive ? "" : text),
            (message as AssistantWork).persisted ? `reply:${message.timestamp}:${chunkIndex}` : null,
            (body) =>
              html`<div class="streaming-text ${animating ? "live-stream" : ""}" dir="auto">
                ${markdown(body, animating, isStreaming && work ? streamedAnswer(baseline, work) : baseline)}
              </div>`,
          ),
        );
      }
      if (chunk.type === "thinking" && chunk.thinking.trim()) {
        const live = animating && chunkIndex === message.content.length - 1;
        parts.push(
          html`<details class="thinking">
            <summary>${sheenLabel(thinkingLabel(live), live)}</summary>
            ${markdown(chunk.thinking)}
          </details>`,
        );
      }
    }
    for (const playground of playgroundsIn((message as AssistantWork).work?.activity)) {
      parts.push(playgroundCard(playground));
    }
    const continuing = isStreaming ? undefined : (message as AssistantWork).continuing;
    if (continuing)
      parts.push(html`<div class="continuing-note">${icon(RefreshCw, 13)}<span>Continuing: ${continuing}</span></div>`);
    return parts;
  }

  function assistantFileList(files: DeliveredFile[] | undefined): TemplateResult | typeof nothing {
    if (!files?.length) return nothing;
    const media: MediaItem[] = [];
    const audio: MediaItem[] = [];
    const rest: DeliveredFile[] = [];
    for (const file of files) {
      const item = deliveredMedia(file);
      if (!item) rest.push(file);
      else if (item.kind === "audio") audio.push(item);
      else media.push(item);
    }
    return html`${media.length ? html`<div class="message-media">${mediaFeed(media)}</div>` : nothing}
    ${audio.length ? html`<div class="message-files message-audio">${audio.map(audioPlayer)}</div>` : nothing}
    ${rest.length ? html`<div class="message-files">${rest.map(deliveredFileBadge)}</div>` : nothing}`;
  }

  function syncWorkTicker(): void {
    const goalTicking = Boolean(chatState.agent?.state.isStreaming && currentGoal()?.status === "active");
    const active =
      (chatState.liveWork?.status === "working" && !chatState.liveWork.stale) || goalTicking || subagentUi.ticking;
    if (active && !workTicker) {
      workTicker = setInterval(() => drawActiveChat(), 1000);
    } else if (!active && workTicker) {
      clearInterval(workTicker);
      workTicker = null;
    }
  }

  function currentGoal(): GoalStripState | null {
    return chatState.liveWork?.goal ?? chatState.goal;
  }

  function clearLiveWork(): void {
    if (chatState.liveWork?.goal) chatState.goal = chatState.liveWork.goal;
    chatState.liveWork = null;
    liveFoldOpened = false;
    liveStepLine.reset();
    chatState.pendingSend = null;
    syncWorkTicker();
  }

  function shouldShowWork(work: WorkBlock | null | undefined, finalText: string): work is WorkBlock {
    return Boolean(work && (workTimeline(work, finalText).length || work.pendingApprovals?.length));
  }

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
    readOnly.clear();
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
    drawActiveChat();
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
    return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
  }

  function backgroundActivityStrip(): TemplateResult | typeof nothing {
    const counts = conversationBackground(sessionsState.list, chatState.sessionId, chatState.threadRef);
    const row = counts ? backgroundLabel(counts.jobs, counts.watches, counts.crons) : null;
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
          @click=${toggleBackgroundPanel}
        >
          ${icon((live ?? row)?.jobs ? Cog : Activity, 13)}<span class="bg-activity-label"
            >${label ?? "Background activity"}</span
          >
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
          ${
            j.purpose
              ? html`<span class="bg-row-cmd bg-job-purpose">${j.purpose}</span>`
              : html`<code class="bg-row-cmd">${j.command}</code>`
          }
          <span class="bg-row-meta">started ${relTime(j.startedAt)} · ${status}</span>
          <span class="bg-row-toggle">${icon(ChevronRight, 13)}</span>
        </button>
        ${open ? html`<pre class="bg-row-output">${j.purpose ? `${j.command}\n\n` : ""}${out ? out.text || "(no output yet)" : "Loading output…"}</pre>` : nothing}
      </div>
    `;
  }

  function backgroundCronRow(c: SessionBackgroundView["crons"][number]): TemplateResult {
    return html`
      <div class="bg-row watch">
        <a class="bg-row-head" href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}>
          ${icon(Clock3, 13)}
          <span class="bg-row-cmd">Cron: <bdi>${c.title ?? "scheduled task"}</bdi></span>
          <span class="bg-row-meta">${cronRowMeta(c)}</span>
        </a>
      </div>
    `;
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

  const swarmUi = createSwarmStrip(() => drawActiveChat());
  const SUBAGENT_ACK_KEY = "qm.subagentAck";
  const SUBAGENT_POLL_MS = 4000;
  const subagentUi = {
    expanded: false,
    stops: new Map<string, SubagentStop>(),
    ticking: false,
    rowsRoot: null as string | null,
    rowsTimer: null as ReturnType<typeof setInterval> | null,
    approvals: new Map<string, PendingApproval[]>(),
    approvalsKey: "",
    acknowledged: new Set<string>(
      (() => {
        try {
          return JSON.parse(localStorage.getItem(SUBAGENT_ACK_KEY) ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
    ),
  };

  function syncSubagentRowsRefresh(rootId: string | null): void {
    if (subagentUi.rowsRoot === rootId) return;
    if (subagentUi.rowsTimer) clearInterval(subagentUi.rowsTimer);
    subagentUi.rowsTimer = rootId ? setInterval(() => refreshTree(rootId), SUBAGENT_POLL_MS) : null;
    subagentUi.rowsRoot = rootId;
  }

  async function stopSubagent(rootId: string, row: SubagentRow): Promise<void> {
    const { id, threadRef, workingSince } = row.session;
    if (subagentUi.stops.get(id)?.state === "stopping") return;
    const stop: SubagentStop = { state: "stopping", run: workingSince };
    subagentUi.stops.set(id, stop);
    drawActiveChat();
    try {
      if ((await stopThreadRun(threadRef)) === "ended" && subagentUi.stops.get(id) === stop)
        subagentUi.stops.delete(id);
      refreshTree(rootId);
    } catch (err) {
      swallow("web-ui: subagent stop", err);
      if (subagentUi.stops.get(id) === stop) {
        stop.state = "failed";
        stop.error = errMessage(err, "Could not stop the subagent.");
      }
    }
    drawActiveChat();
  }

  function pruneSubagentStops(rows: readonly SubagentRow[]): void {
    for (const [id, stop] of subagentUi.stops) {
      const row = rows.find((candidate) => candidate.session.id === id && candidate.state === "working");
      const run = row?.session.workingSince;
      if (!row || (stop.run !== undefined && run !== undefined && run !== stop.run)) subagentUi.stops.delete(id);
    }
  }

  function subagentStopTpl(rootId: string, row: SubagentRow): TemplateResult | typeof nothing {
    if (row.state !== "working") return nothing;
    const { state: stop, error } = subagentUi.stops.get(row.session.id) ?? {};
    return html`<button
      type="button"
      class="subagent-row-action"
      title=${error ?? nothing}
      ?disabled=${stop === "stopping"}
      @click=${() => void stopSubagent(rootId, row)}
    >
      ${SUBAGENT_STOP_LABEL[stop ?? "idle"]}
    </button>`;
  }

  function acknowledgeSubagent(row: SubagentRow): void {
    subagentUi.acknowledged.add(ackKey(row));
    try {
      localStorage.setItem(SUBAGENT_ACK_KEY, JSON.stringify([...subagentUi.acknowledged].slice(-200)));
    } catch {
      return drawActiveChat();
    }
    drawActiveChat();
  }

  function syncSubagentApprovals(rows: readonly SubagentRow[]): void {
    const waiting = rows.filter((row) => row.state === "waiting").map((row) => row.session.id);
    const key = waiting.join(",");
    if (key === subagentUi.approvalsKey) return;
    subagentUi.approvalsKey = key;
    for (const id of subagentUi.approvals.keys()) if (!waiting.includes(id)) subagentUi.approvals.delete(id);
    for (const id of waiting)
      void fetchSessionApprovals(id).then((r) => {
        if (!subagentUi.approvalsKey.split(",").includes(id)) return;
        subagentUi.approvals.set(id, r?.approvals ?? []);
        drawActiveChat();
      });
  }

  function resolveSubagentApproval(childId: string, decision: ApprovalDecision): void {
    if (chatState.resolvingApprovals.has(decision.requestId)) return;
    chatState.resolvingApprovals.add(decision.requestId);
    ctx.composer.state.error = "";
    drawActiveChat();
    void resolveApproval(decision)
      .then(() => {
        subagentUi.approvals.set(
          childId,
          (subagentUi.approvals.get(childId) ?? []).filter((a) => a.requestId !== decision.requestId),
        );
      })
      .catch((err: unknown) => {
        ctx.composer.state.error = errMessage(err, "Could not send the approval.");
      })
      .finally(() => {
        chatState.resolvingApprovals.delete(decision.requestId);
        subagentUi.approvalsKey = "";
        void refreshSessions({ silent: true }).finally(() => drawActiveChat());
      });
  }

  const SUBAGENT_STATE_LABEL: Record<SubagentRow["state"], string> = {
    working: "working",
    waiting: "waiting",
    done: "done",
    failed: "failed",
  };

  function subagentRowTpl(rootId: string, row: SubagentRow): TemplateResult {
    const now = Date.now();
    const elapsed = goalElapsedLabel(row.startedAt, row.endedAt ?? now);
    const approvals = unresolvedApprovals(subagentUi.approvals.get(row.session.id) ?? []);
    const title = row.session.title?.trim() || "Subagent";
    return html`<div class="subagent-row ${row.state}" style=${`--subagent-depth:${row.depth - 1}`}>
      <button type="button" class="subagent-row-head" @click=${() => void openSessionById(row.session.id)}>
        ${row.state === "working" ? workingMark() : nothing}
        ${row.state === "waiting" ? html`<span class="awaiting-dot" aria-hidden="true"></span>` : nothing}
        ${row.state === "failed" ? html`<span class="subagent-failed-mark">${icon(TriangleAlert, 12)}</span>` : nothing}
        <span class="subagent-row-title" dir="auto">${title}</span>
        ${
          row.state === "working" && row.session.purpose
            ? html`<span class="subagent-row-purpose" dir="auto">${row.session.purpose}</span>`
            : nothing
        }
        <span class="subagent-row-meta"
          >${row.state === "working" ? elapsed : `${SUBAGENT_STATE_LABEL[row.state]} · ${elapsed}`}</span
        >
      </button>
      ${
        row.state === "failed"
          ? html`<button type="button" class="subagent-row-action" @click=${() => acknowledgeSubagent(row)}>
              Dismiss
            </button>`
          : nothing
      }
      ${subagentStopTpl(rootId, row)}
      ${
        approvals.length
          ? ctx.composer.composerApprovalPanel(approvals, (decision) =>
              resolveSubagentApproval(row.session.id, decision),
            )
          : nothing
      }
    </div>`;
  }

  function subagentStrip(): TemplateResult | typeof nothing {
    const rootId = chatState.sessionId;
    if (!rootId) {
      syncSubagentRowsRefresh(null);
      return nothing;
    }
    const rows = visibleSubagents(subagentRows(sessionsState.list, rootId), subagentUi.acknowledged);
    syncSubagentRowsRefresh(rows.some((row) => row.state === "working") ? rootId : null);
    pruneSubagentStops(rows);
    syncSubagentApprovals(rows);
    subagentUi.ticking = rows.some((row) => row.state === "working" || row.state === "waiting");
    syncWorkTicker();
    if (!rows.length) return nothing;
    const single = rows.length === 1;
    const expanded = single || subagentUi.expanded || rows.some((row) => row.state === "waiting");
    const failed = rows.some((row) => row.state === "failed");
    return html`
      <section class="bg-activity subagent-activity ${expanded ? "expanded" : ""} ${failed ? "has-failed" : ""}">
        ${
          single
            ? nothing
            : html`<button
                type="button"
                class="bg-activity-strip"
                aria-expanded=${String(expanded)}
                @click=${() => {
                  subagentUi.expanded = !subagentUi.expanded;
                  drawActiveChat();
                }}
              >
                ${icon(Bot, 13)}<span class="bg-activity-label">${subagentSummary(rows)}</span>
                <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
              </button>`
        }
        ${expanded ? html`<div class="subagent-list ${single ? "single" : "bg-panel"}">${rows.map((row) => subagentRowTpl(rootId, row))}</div>` : nothing}
      </section>
    `;
  }

  async function cancelGoal(agent: Agent, goal: GoalStripState): Promise<void> {
    const sessionId = chatState.sessionId;
    const key = `${sessionId}:${goal.createdAt}`;
    if (!sessionId || goalCancels.has(key)) return;
    goalCancels.add(key);
    drawActiveChat(agent);
    try {
      await cancelSessionGoal(sessionId);
      if (sessionId === chatState.sessionId) markGoalCancelled(goal.createdAt);
      if (agent === chatState.agent) await refreshTranscriptFromItems(agent);
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Could not cancel the goal.");
    } finally {
      goalCancels.delete(key);
      if (agent === chatState.agent) drawActiveChat(agent);
    }
  }

  function markGoalCancelled(createdAt: number): void {
    for (const holder of [chatState, chatState.liveWork])
      if (holder?.goal?.createdAt === createdAt) holder.goal = { ...holder.goal, status: "cancelled" };
  }

  async function resumeGoalFromBar(agent: Agent, goal: GoalStripState): Promise<void> {
    const sessionId = chatState.sessionId;
    const key = `${sessionId}:${goal.createdAt}`;
    if (!sessionId || agent.state.isStreaming || goalResumes.has(key) || goalCancels.has(key)) return;
    goalResumes.add(key);
    drawActiveChat(agent);
    try {
      const out = await resumeSessionGoal(sessionId);
      if (agent !== chatState.agent || sessionId !== chatState.sessionId) return;
      chatState.goal = out.goal;
      await ctx.composer.sendText(GOAL_RESUME_PROMPT, agent);
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Could not resume the goal.");
    } finally {
      goalResumes.delete(key);
      if (agent === chatState.agent) drawActiveChat(agent);
    }
  }

  function goalStrip(agent: Agent, opts?: { readOnly?: boolean }): TemplateResult | typeof nothing {
    const messages = visibleMessages(agent);
    const goal = currentGoal();
    if (!goal) return nothing;
    const key = `${chatState.sessionId}:${goal.createdAt}`;
    const cancelling = goalCancels.has(key);
    const workedMs = goalWorked(messages, goal);
    const paused = goal.status === "paused";
    if (goal.status !== "active" && !paused) return nothing;
    let title = "Goal";
    if (paused) title = "Goal paused";
    else if (agent.state.isStreaming) title = "Pursuing goal";
    const readOnly = opts?.readOnly === true;
    return html`
      <section class="goal-strip ${paused ? "paused" : ""}" aria-live="polite" title=${goal.objective}>
        ${
          readOnly || agent.state.isStreaming
            ? html`<span class="goal-strip-icon">${icon(paused ? Pause : Target, 13)}</span>`
            : html`<button
                type="button"
                class="chip-x goal-strip-resume"
                aria-label="Resume goal"
                ${tip("Resume goal")}
                ?disabled=${goalResumes.has(key) || cancelling || !ctx.composer.readyToSend()}
                @click=${() => void resumeGoalFromBar(agent, goal)}
              >
                ${icon(Play, 13)}
              </button>`
        }
        <span class="goal-strip-title">${title}</span>
        <span class="goal-strip-objective" dir="auto">${goalObjectiveLabel(goal.objective)}</span>
        <span class="goal-strip-meta">${goalWorkedLabel(workedMs, goal.floor)}</span>
        ${
          readOnly
            ? nothing
            : html`<button
                type="button"
                class="chip-x"
                aria-label="Cancel goal"
                ${tip("Cancel goal")}
                ?disabled=${cancelling || goalResumes.has(key)}
                @click=${() => void cancelGoal(agent, goal)}
              >
                ${icon(X, 13)}
              </button>`
        }
      </section>
    `;
  }

  function liveWorkStatus(agent: Agent): TemplateResult | typeof nothing {
    if (!agent.state.isStreaming && chatState.resolvingApprovals.size === 0) return nothing;
    const work = chatState.liveWork ?? { status: "thinking", activity: [] };
    const streaming = agent.state.streamingMessage as AssistantWork | undefined;
    if (runSlot.stopGeneration === runSlot.generation)
      return shouldShowWork(streaming?.work ?? work, "")
        ? nothing
        : html`<div class="stopped-head" role="status">Stopping…</div>`;
    if (work.status !== "thinking" && work.status !== "working") return nothing;
    if (currentTextPhase(work)?.phase === "final_answer" || shouldShowWork(work, "")) return nothing;
    if (streaming && streaming.work === work && preStepWork(work)) return nothing;
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
      const call = toolBody(active?.call);
      const tool = active?.call?.tool ?? "";
      const verb = active ? (TOOL_META[toolCategory(active.call?.tool ?? null, call)] ?? UNKNOWN_TOOL).active : null;
      return {
        icon: RefreshCw,
        label: verb ? `${verb} interrupted, resuming…` : "Interrupted, resuming…",
        detail: active ? toolDetail(tool, call, toolBody(active.result)) : "",
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
    const call = toolBody(row.call);
    const result = toolBody(row.result);
    const tool = rowTool(row) ?? "unknown";
    const meta = TOOL_META[toolCategory(rowTool(row), rowArgs(row))] ?? UNKNOWN_TOOL;
    const secs = elapsedSeconds(row.call?.createdAt) || workSeconds(work);
    const posting = postSpeechText(row, true);
    if (posting) {
      return {
        icon: MessageSquare,
        label: workedLabel("Posting message", secs),
        detail: firstLine(posting, 60),
      };
    }
    return {
      icon: meta.icon,
      label: workedLabel(meta.active, secs),
      detail: toolDetail(tool, call, result),
    };
  }

  function elapsedSeconds(startedAt: number | null | undefined): number {
    if (typeof startedAt !== "number" || startedAt <= 0) return 0;
    return Math.max(0, (Date.now() - startedAt) / 1000);
  }

  function usedToolsSuffix(work: WorkBlock): string {
    const n = activityItems(work.activity).filter((item) => item.kind === "ToolCall").length;
    return n > 0 ? ` (used ${n} tool${n === 1 ? "" : "s"})` : "";
  }

  function workLabel(work: WorkBlock): string {
    if (work.stale && (work.status === "thinking" || work.status === "working")) return "Interrupted, resuming…";
    if (currentTextPhase(work)?.phase === "final_answer") return workedLabel("Worked", workSeconds(work));
    if (work.status === "thinking") return "Thinking";
    const secs = workSeconds(work);
    return workedLabel(work.status === "working" ? "Working" : "Worked", secs);
  }

  function preStepHead(work: WorkBlock): TemplateResult {
    const step = { icon: Brain, label: "Thinking" };
    liveStepLine.track(step);
    return html`<details class="work work-fold work-${work.status} work-prestep">
      <summary class="work-head">${liveStepLine.line(step, step.label, true, liveWorkDuration(work))}</summary>
    </details>`;
  }

  function timelineKey(item: TimelineItem): string {
    if (item.kind === "tool") return `tool:${item.row.call?.seq ?? item.row.result?.seq ?? item.row.approval?.seq}`;
    if (item.kind === "thinking") return `thinking:${item.step ?? item.seq}`;
    return `${item.kind}:${item.item.seq}`;
  }

  function workBlock(
    work: WorkBlock,
    isStreaming: boolean,
    text: string,
    baseline: string,
    stopped = false,
  ): TemplateResult {
    const active =
      isStreaming &&
      currentTextPhase(work)?.phase !== "final_answer" &&
      (work.status === "working" || work.status === "thinking");
    const segments = workTimelineSegments(workTimeline(work, active ? "" : text));
    return html`${segments.map((segment, index) => {
      const steer = segment[0];
      if (steer?.kind === "steer") return renderTimelineItem(steer, work);
      if (steer?.kind === "text") return renderTimelineItem(steer, work);
      const last = index === segments.length - 1;
      const replies: TemplateResult[] = [];
      const timeline = segment.filter((item) => {
        if (item.kind !== "tool") return true;
        const speech = postSpeechText(item.row);
        if (speech === null) return true;
        replies.push(spokenText(speech, `reply:${item.row.result?.createdAt}:0`, "streaming-text"));
        return false;
      });
      const tail = active && last ? streamedAnswer(text, work) : "";
      const liveTail = active && last && !tail.trim() ? timeline.at(-1) : undefined;
      const liveItem = liveTail?.kind === "thinking" ? timelineKey(liveTail) : undefined;
      const stopping = isStreaming && runSlot.stopGeneration === runSlot.generation;
      const ending = last && (stopped || stopping);
      const animating = active && last && !stopping;
      const live = active && last && !work.stale && !work.pendingApprovals?.length;
      const oneStep = live && !stopping;
      const step = oneStep
        ? (currentStep(timeline, work, (tool, payload) => TOOL_META[toolCategory(tool, payload)] ?? UNKNOWN_TOOL) ??
          checkedReplyStep(segments[index - 1]?.[0]))
        : null;
      let label = last ? workLabel(work) : "Worked";
      if (step) label = step.label;
      if (stopping && last) label = "Stopping…";
      if (stopped && last) label = `You stopped after ${goalElapsedLabel(0, workSeconds(work) * 1000)}`;
      const elapsed = step ? liveWorkDuration(work) : "";
      if (last) liveStepLine.track(step);
      if (
        timeline.length === 1 &&
        !tail.trim() &&
        !oneStep &&
        !(last && (stopped || stopping || work.stale || work.pendingApprovals?.length))
      )
        return html`${renderTimelineItem(timeline[0]!, work, liveItem)}${replies}`;
      let fold =
        timeline.length || tail.trim() || (last && (active || work.pendingApprovals?.length))
          ? html`<details
              class=${ending ? "stopped-work" : `work work-fold work-${work.status}`}
              ?open=${last && (live ? liveFoldOpened : active || !!work.pendingApprovals?.length)}
              @toggle=${(event: Event) => {
                if (live) liveFoldOpened = (event.currentTarget as HTMLDetailsElement).open;
              }}
            >
              <summary class=${ending ? "stopped-head" : "work-head"} @click=${animateDetailsToggle}>
                ${liveStepLine.line(step && last ? step : null, label, animating, elapsed)}
              </summary>
              ${ending ? nothing : html`<div class="work-divider"></div>`}
              <div class="work-rows">
                ${guard(
                  [
                    work,
                    work.activity,
                    work.reasoning,
                    work.status,
                    work.stale,
                    work.pendingApprovals,
                    active,
                    active ? "" : text,
                    sessionsState.list,
                    index,
                    last,
                    liveItem,
                  ],
                  () =>
                    repeat(
                      activityGroups(timeline),
                      (items) => timelineKey(items[0]!),
                      (items) => {
                        if (items.length === 1) return renderTimelineItem(items[0]!, work, liveItem);
                        const summary = activityGroupSummary(items, work.status);
                        const groupIcon = { read: BookOpen, search: Search, execute: Terminal, other: Wrench }[
                          summary.category
                        ];
                        return html`<details
                          class="activity-group work-fold"
                          ?open=${(active && last) || summary.attention}
                        >
                          <summary class="work-head" @click=${animateDetailsToggle}>
                            ${icon(groupIcon, 15)}<span>${summary.label}</span
                            ><span class="activity-chevron">${icon(ChevronRight, 14)}</span>
                          </summary>
                          <div class="work-rows">
                            ${repeat(items, timelineKey, (item) => renderTimelineItem(item, work, liveItem))}
                          </div>
                        </details>`;
                      },
                    ),
                )}
              </div>
            </details>`
          : nothing;
      if (ending && fold === nothing) fold = html`<div class="stopped-head">${label}</div>`;
      const said = tail.trim()
        ? assistantText(
            tail,
            null,
            (body) =>
              html`<div class="work-said streaming-text ${animating ? "live-stream" : ""}" dir="auto">
                ${markdown(body, animating, streamedAnswer(baseline, work))}
              </div>`,
          )
        : nothing;
      return html`${fold}${said}${replies}`;
    })}`;
  }

  function waitingSteerRows(agent: Agent): TemplateResult[] {
    return ctx.composer.waitingSteers(agent).map(
      (q) =>
        html`<div class="inline-steer waiting-steer" aria-busy="true">
          ${chatMessage(
            (q.attachments?.length
              ? { role: "user-with-attachments", content: q.text, attachments: q.attachments, steered: true }
              : {
                  role: "user",
                  content: q.text || (q.hasAttachments ? "(files)" : ""),
                  steered: true,
                }) as unknown as AgentMessage,
            -1,
            false,
            true,
          )}
        </div>`,
    );
  }

  function renderTimelineItem(item: TimelineItem, work: WorkBlock, liveItem?: string): TemplateResult {
    const status = work.status;
    const stale = work.stale === true;
    if (item.kind === "steer") {
      const steer = inlineSteers.get(item.item.seq);
      return html`<div class="inline-steer">
        ${steer ? chatMessage(steer.message, steer.index, false, true) : nothing}
      </div>`;
    }
    if (item.kind === "thinking") {
      const key = timelineKey(item);
      const thought = thinkingPresentation(item.text, key === liveItem);
      return html`<details
        class="thinking-row"
        ?open=${openThinking.has(key)}
        @toggle=${(event: Event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) openThinking.add(key);
          else openThinking.delete(key);
        }}
      >
        <summary class="thinking-summary" @click=${animateDetailsToggle}>
          <span class="tool-icon">${icon(Brain, 15)}</span><span class="thinking-title">${thought.title}</span>
          <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
        </summary>
        <div class="thinking-body">${markdown(thought.body)}</div>
      </details>`;
    }
    if (item.kind === "text") {
      const reason = retractedReason(item.item);
      return reason ? retractedRow(reason, item.item.text ?? "") : interimReply(item.item);
    }
    return toolRow(item.row, work, status, stale);
  }

  function retractedRow(reason: string, text: string): TemplateResult {
    return html`<details class="thinking-row retracted-reply">
      <summary class="thinking-summary" @click=${animateDetailsToggle}>
        <span class="tool-icon">${icon(RotateCcw, 15)}</span><span class="thinking-title">Retracted: ${reason}</span>
        <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
      </summary>
      <div class="thinking-body" dir="auto">${markdown(text)}</div>
    </details>`;
  }

  function interimReply(item: Item): TemplateResult {
    return spokenText(item.text ?? "", `said:text:${item.seq}`, "work-said streaming-text");
  }

  function spokenText(text: string, returnKey: string, className: string): TemplateResult {
    return html`${assistantText(
      text,
      returnKey,
      (body) => html`<div class=${className} dir="auto">${markdown(body)}</div>`,
    )}`;
  }

  const TOOL_META: Record<string, { icon: IconNode; active: string; attempted: string }> = {
    execute: { icon: Terminal, active: "Running command", attempted: "Tried running command" },
    read: { icon: BookOpen, active: "Reading file", attempted: "Tried reading file" },
    skill: { icon: BookOpen, active: "Loading skill", attempted: "Tried loading skill" },
    write: { icon: Pencil, active: "Writing file", attempted: "Tried writing file" },
    publish: { icon: Rocket, active: "Publishing", attempted: "Tried publishing" },
    recall: { icon: Brain, active: "Searching memory", attempted: "Tried searching memory" },
    memory: { icon: Brain, active: "Using memory", attempted: "Tried using memory" },
    history: {
      icon: ScrollText,
      active: "Searching history",
      attempted: "Tried searching history",
    },
    background: {
      icon: Terminal,
      active: "Managing process",
      attempted: "Tried managing process",
    },
  };
  const UNKNOWN_TOOL = { icon: Wrench, active: "Working", attempted: "Tried step" };

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

  const SUBAGENT_MAIL_NOTES: Record<string, string> = {
    final_answer: "finished",
    no_reply: "finished without a reply",
    awaiting_input: "needs an approval",
    errored: "failed",
    refused: "was refused",
  };

  function subagentChip(title: string, sessionId?: string): TemplateResult {
    const session = sessionsState.list.find((row) => row.id === sessionId);
    const inner = html`<span dir="auto">${session?.title || title}</span>`;
    if (!sessionId) return html`<span class="subagent-chip">${inner}</span>`;
    return html`<button
      class="subagent-chip"
      type="button"
      title="Open subagent · Drag to the sidebar to make a top-level session"
      draggable=${session ? "true" : "false"}
      @dragstart=${(e: DragEvent) => {
        if (session) onSessionDragStart(e, session);
        else e.preventDefault();
      }}
      @dragend=${endSessionDrag}
      @click=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        void openSessionById(sessionId);
      }}
    >
      ${inner}
    </button>`;
  }

  function firstLine(s: string, max?: number): string {
    const line = s.split("\n")[0] ?? "";
    return max !== undefined && line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  function toolDetail(tool: string, call: ToolPayload, result: ToolPayload): string {
    if (typeof call.purpose === "string" && call.purpose.trim()) return call.purpose.trim();
    switch (toolCategory(tool, { ...result, ...call })) {
      case "execute":
        return call.command ? firstLine(call.command) : "";
      case "read":
        return call.path ?? result.path ?? "";
      case "skill": {
        const name = call.name ?? result.name ?? "";
        const path = call.path ?? result.path ?? "SKILL.md";
        return path === "SKILL.md" ? name : `${name}/${path}`;
      }
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

  function toolPayloadText(payload: ToolPayload): string {
    const hidden = new Set(["tool", "callId", "workStartedAt", "workFinishedAt", "isError", "retrySafe", "rerun"]);
    const entries = Object.entries(payload as Record<string, unknown>).filter(
      ([key, value]) => !hidden.has(key) && value !== undefined,
    );
    if (!entries.length) return "";
    if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1] as string;
    return JSON.stringify(Object.fromEntries(entries), null, 2);
  }

  function toolPayloadCard(label: string | null, text: string, loadFull?: () => void): TemplateResult | typeof nothing {
    if (!text) return nothing;
    return html`<div class="tool-payload-card">
      ${label ? html`<div class="tool-payload-label">${label}</div>` : nothing}
      <pre class="tool-payload-body">${text}</pre>
      ${loadFull ? html`<div class="code-card-foot"><button class="show-full-btn" type="button" @click=${loadFull}>Show full ${label?.toLowerCase() ?? "command"}</button></div>` : nothing}
    </div>`;
  }

  function toolDisclosure(
    tool: string,
    call: ToolPayload,
    result: ToolPayload,
    work: WorkBlock,
    row: ToolRowModel,
  ): TemplateResult {
    const execution = toolCategory(tool, { ...result, ...call }) === "execute";
    const input = execution ? (call.command ?? "") : toolPayloadText(toolCallArguments(row.call));
    const text = row.result?.text ?? null;
    const output = execution ? "" : toolPayloadText({ ...result, ...(text !== null ? { result: text } : {}) });
    return html`<div class="tool-disclosure">
      ${toolPayloadCard(execution ? null : "Input", input, row.call?.truncated ? () => void loadFullItem(work, row.call!) : undefined)}
      ${toolPayloadCard("Result", output, row.result?.truncated ? () => void loadFullItem(work, row.result!) : undefined)}
    </div>`;
  }

  function toolRow(row: ToolRowModel, work: WorkBlock, status: WorkBlock["status"], stale = false): TemplateResult {
    if (row.approval) {
      return html`<div class="tool-row tool-approval">
        <span class="tool-icon">${icon(Wrench, 13)}</span>
        <span class="tool-label">Approval needed</span>
      </div>`;
    }
    const call = toolBody(row.call);
    const result = toolBody(row.result);
    const tool = rowTool(row) ?? "unknown";
    const knownMeta = TOOL_META[toolCategory(tool, rowArgs(row))];
    const meta = knownMeta ?? UNKNOWN_TOOL;
    const name = toolName(tool) || "Tool";
    const kind = toolRowKind(row, status);
    let label = knownMeta ? meta.attempted : `Tried ${name}`;
    if (kind === "approval")
      label = `${row.pending ? "Waiting for approval" : "Approval requested"}${row.waiting && row.waiting > 1 ? ` · ${row.waiting} calls` : ""}`;
    else if (kind === "running") {
      const active = knownMeta ? meta.active : name;
      label = stale ? `${active} — interrupted` : active;
    } else if (kind === "ok") label = knownMeta ? meta.active : name;
    else if (kind === "failed") label = `Failed ${name}`;
    let why = "";
    if (kind === "failed") why = firstLine(result.error ?? result.reason ?? "", 90);
    const base = kind === "approval" ? "" : toolDetail(tool, call, result);
    const attempts = row.attempts && row.attempts > 1 ? `${row.attempts} attempts` : "";
    const detail = [base, why, attempts].filter(Boolean).join(" · ");
    const semantic = activityLabel(row, status);
    const visible = semantic
      ? [semantic, why, attempts, stale && kind === "running" ? "interrupted" : ""].filter(Boolean).join(" · ")
      : [label, detail].filter(Boolean).join(" ");
    const description = activityDescription(row);
    const session = sessionPresentation(row, status);
    const sessionView = session ? sessionToolView(row, sessionsState.list) : null;
    const sessionDetail = [sessionView?.detail, session?.preview].filter(Boolean).join(" · ");
    const sessionText = session ? [session.label, sessionDetail].filter(Boolean).join(" ") : null;
    const rowIcon = session
      ? Bot
      : { search: Search, read: BookOpen, execute: meta.icon, other: meta.icon }[description.category];
    const classes = ["tool-row", `tool-${kind}`].join(" ");
    const head = html`<span class="tool-icon">${icon(rowIcon, 15)}</span>
      ${session && sessionView?.chipTitle ? html`<span class="session-action">${session.label}</span>${subagentChip(sessionView.chipTitle, sessionView.sessionId)}${sessionDetail ? html`<span class="tool-label session-message" title=${sessionDetail}>${sessionDetail}</span>` : nothing}` : html`<span class="tool-label" title=${sessionText ?? (detail ? `${label}: ${detail}` : label)}>${sessionText ?? visible}</span>`}`;
    if (!row.call && !row.result) return html`<div class="${classes}">${head}</div>`;
    const renderDisclosure = (details: HTMLDetailsElement): void => {
      const host = details.querySelector<HTMLElement>(".tool-disclosure-host");
      if (host) render(details.open ? toolDisclosure(tool, call, result, work, row) : nothing, host);
    };
    return html`<details
      class="${classes} tool-expandable"
      @toggle=${(event: Event) => renderDisclosure(event.currentTarget as HTMLDetailsElement)}
    >
      <summary class="tool-summary" @click=${(event: MouseEvent) => animateDetailsToggle(event, renderDisclosure)}>
        ${head}<span class="activity-chevron">${icon(ChevronRight, 14)}</span>
      </summary>
      <div
        class="tool-disclosure-host"
        ${ref((element) => {
          const details = element?.closest<HTMLDetailsElement>("details");
          if (details) renderDisclosure(details);
        })}
      ></div>
    </details>`;
  }

  function redrawTranscript(): void {
    drawActiveChat();
  }

  async function loadFullItem(work: WorkBlock, item: Item): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || !item.truncated) return;
    try {
      const full = await fetchItem(sessionId, item.seq);
      work.activity = work.activity.map((entry) => ("item" in entry && entry.item === item ? { item: full } : entry));
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Couldn't load the full output.");
    }
    redrawTranscript();
  }

  function fileChip(name: string, size?: number, href?: string, mimetype?: string): TemplateResult {
    return chipBadge(Paperclip, name, size, href, false, mimetype);
  }

  function inlineHtmlName(name?: string, mimeType?: string): boolean {
    if (mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html") return true;
    return /\.html?$/i.test(name ?? "");
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

  let attachmentPeek: HTMLElement | null = null;

  function unpeekAttachment(): void {
    attachmentPeek?.remove();
    attachmentPeek = null;
    document.removeEventListener("scroll", unpeekAttachment, true);
  }

  function peekAttachment(e: Event): void {
    const link = e.currentTarget as HTMLElement | null;
    const img = link?.querySelector("img");
    if (!link || !img || getComputedStyle(link).getPropertyValue("--attachment-compact").trim() !== "1") return;
    unpeekAttachment();
    const bounds = (link.closest(".split-pane-content") ?? document.documentElement).getBoundingClientRect();
    const anchor = link.getBoundingClientRect();
    const pad = 12;
    const chrome = 12;
    const maxW = Math.max(80, Math.min(360, bounds.width - pad * 2 - chrome));
    const maxH = Math.max(60, Math.min(320, bounds.height - anchor.height - pad * 3 - chrome));
    const natural = { w: img.naturalWidth || maxW, h: img.naturalHeight || maxH };
    const scale = Math.min(maxW / natural.w, maxH / natural.h, 1);
    const w = Math.round(natural.w * scale);
    const h = Math.round(natural.h * scale);
    const peek = document.createElement("div");
    peek.className = "attachment-peek";
    peek.setAttribute("aria-hidden", "true");
    const copy = document.createElement("img");
    copy.src = img.currentSrc || img.src;
    copy.alt = "";
    copy.style.width = `${w}px`;
    copy.style.height = `${h}px`;
    peek.append(copy);
    const below = anchor.bottom + 8;
    const top =
      below + h + chrome <= bounds.bottom - pad ? below : Math.max(bounds.top + pad, anchor.top - 8 - h - chrome);
    const left = Math.max(bounds.left + pad, Math.min(anchor.right - w - chrome, bounds.right - pad - w - chrome));
    peek.style.top = `${top}px`;
    peek.style.left = `${left}px`;
    document.body.append(peek);
    attachmentPeek = peek;
    document.addEventListener("scroll", unpeekAttachment, true);
  }

  function userMedia(a: UserAttachmentView): MediaItem | null {
    const kind = mediaKind(a.fileName, a.mimeType);
    if (!kind) return null;
    const download = a.artifactId ? fileContentUrl(a.artifactId, a.fileName) : undefined;
    const inline = kind === "image" && a.content ? dataUrl(a.content, a.mimeType) : undefined;
    const src = download ?? localContentUrl(a) ?? inline;
    if (!src) return null;
    return {
      kind,
      name: a.fileName,
      src,
      ...(download ? { download } : {}),
      ...(typeof a.size === "number" ? { size: a.size } : {}),
    };
  }

  function userVisual(a: UserAttachmentView): boolean {
    const kind = userMedia(a)?.kind;
    return kind === "image" || kind === "video";
  }

  function openUserMedia(event: MouseEvent, all: readonly UserAttachmentView[], current: UserAttachmentView): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    unpeekAttachment();
    const visual = all.filter(userVisual);
    const thumbs = (event.currentTarget as HTMLElement).parentElement!.querySelectorAll(
      ".file-image > :is(img, video)",
    );
    openMediaViewer(
      visual.map((a) => userMedia(a)!),
      visual.indexOf(current),
      { originOf: (index) => thumbs[index] ?? null },
    );
  }

  function userAttachmentBadge(a: UserAttachmentView, all: readonly UserAttachmentView[] = [a]): TemplateResult {
    const artifactHref = a.artifactId ? fileContentUrl(a.artifactId, a.fileName) : undefined;
    const media = userMedia(a);
    if (media?.kind === "audio") return audioPlayer(media);
    if (media) {
      return html`<a
        class="file-image"
        href=${media.src}
        target="_blank"
        rel="noreferrer"
        ${tip(a.fileName)}
        @click=${(event: MouseEvent) => openUserMedia(event, all, a)}
        @mouseenter=${peekAttachment}
        @mouseleave=${unpeekAttachment}
        @focus=${peekAttachment}
        @blur=${unpeekAttachment}
        >${
          media.kind === "video"
            ? videoThumb(media.src)
            : html`<img src=${media.src} alt=${a.fileName} loading="lazy" />`
        }<span class="file-image-name" dir="auto">${a.fileName}</span
        >${typeof a.size === "number" ? html`<small class="file-image-size">${formatBytes(a.size)}</small>` : nothing}</a
      >`;
    }
    if (a.mimeType?.startsWith("image/"))
      return chipBadge(FileImage, a.fileName, a.size, artifactHref ?? localContentUrl(a), true);
    if (inlineHtmlName(a.fileName, a.mimeType)) {
      let src = artifactHref;
      if (!src && a.content) {
        src = dataUrl(a.content, "text/html");
      }
      if (src) return htmlPreviewCard(a.fileName, src, a.size, artifactHref);
    }
    return fileChip(a.fileName, a.size, artifactHref ?? localContentUrl(a), a.mimeType);
  }

  function deliveredMedia(file: DeliveredFile): MediaItem | null {
    const kind = file.artifactId ? mediaKind(file.name, file.mimetype) : null;
    if (!kind) return null;
    const src = fileContentUrl(file.artifactId!, file.name);
    return {
      kind,
      name: file.name,
      src,
      download: src,
      ...(typeof file.sizeBytes === "number" ? { size: file.sizeBytes } : {}),
    };
  }

  function deliveredFileBadge(file: DeliveredFile): TemplateResult {
    if (!file.artifactId) return fileChip(file.name, file.sizeBytes);
    const href = fileContentUrl(file.artifactId, file.name);
    if (file.mimetype?.startsWith("image/")) return imageChip(file.name, file.sizeBytes, href);
    if (inlineHtmlName(file.name, file.mimetype)) return htmlPreviewCard(file.name, href, file.sizeBytes, href);
    return fileChip(file.name, file.sizeBytes, href, file.mimetype);
  }

  function scrollBottomButton(): TemplateResult {
    return html`<button class="scroll-bottom-btn" type="button" aria-label="Scroll to bottom" @click=${scrollToBottom}>
      ${icon(ArrowDown, 16)}
    </button>`;
  }

  function scrollToBottom(): void {
    scrollTranscript(true);
  }

  function scrollTranscript(force = false): void {
    if (preserveConnectionScroll || ctx.container()?.querySelector(".empty-chat qm-onboarding-welcome")) {
      transcriptViewport.sync(null);
      return;
    }
    transcriptViewport.sync(ctx.container()?.querySelector<HTMLElement>(".chat-scroll") ?? null);
    transcriptViewport.follow(force);
  }

  redrawHooks.add(redrawForConnector);

  return {
    state: chatState,
    hasLiveRun: () => hasLiveRun(runSlot),
    signalLiveRun: (kind, text, queuedRunId) =>
      signalLiveRun(
        runSlot,
        kind,
        text,
        {
          threadRef: chatState.threadRef,
          scopeId: chatState.scopeId,
          channelName: chatState.contextName,
        },
        queuedRunId,
      ),
    stopLiveRun,
    isStopping: () => runSlot.stopGeneration === runSlot.generation,
    currentTurnOptions,
    turnRuntime,
    newChat,
    newTemporaryChat,
    teardown: teardownActiveChat,
    resetChatState,
    mountContinuable,
    mountReadOnly,
    attachApprovalsWhenLoaded,
    mountLoadingPane,
    mountLoadError,
    scrollToBottom,
    revealEntry: (seq: number) => {
      if (chatState.inheritedMessages.some((message) => messageEntrySeqs(message).includes(seq))) {
        chatState.inheritedExpanded = true;
        drawActiveChat();
      }
      const host = chatState.host ?? ctx.container()?.querySelector<HTMLElement>(".custom-chat");
      transcriptViewport.cancelFollow();
      const found = host ? highlightMessage(host, seq) : false;
      if (!found) {
        ctx.composer.state.error = "The linked message is unavailable or isn't visible in this conversation.";
        drawActiveChat();
      }
      return found;
    },
    drawActiveChat,
    setTranscriptWindow,
    setPins,
    setGoal,
    setTurnRuntime,
    requestBackgroundPanel,
    activePendingApprovals,
    resolveCommandApproval,
    notePendingSessionOnSend,
    syncPaneState: postCurrentPaneState,
    onDelivery,
    applyTranscript,
    mountReadOnlyPage,
    transcriptAnchor,
    resumeIfIdle,
    catchUp,
    redraw: () => drawActiveChat(),
    dispose,
  };
}
