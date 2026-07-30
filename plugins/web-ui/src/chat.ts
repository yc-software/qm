import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import "./marked-dedupe";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Activity,
  Ban,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileImage,
  FileText,
  Files,
  GitFork,
  Hash,
  Maximize2,
  Paperclip,
  Pencil,
  Plug,
  Radar,
  RefreshCw,
  Rocket,
  ScrollText,
  Terminal,
  Users,
  Wrench,
  type IconNode,
} from "lucide";
import {
  activeRunForThread,
  api,
  attachPendingApprovals,
  entriesToMessages,
  fetchTranscript,
  forkCutSeq,
  forkSession,
  makeCoreStreamFn,
  makeOpenerStreamFn,
  makeRunResumeStreamFn,
  runApprovalTurn,
  sharedContextLabel,
  subscribeDeliveries,
  TAIL_TURNS,
  type ApprovalDecision,
  type AssistantWork,
  type CoreSession,
  type DeliveredFile,
  type PendingApproval,
  type SessionBackgroundOutput,
  type SessionBackgroundView,
  type SessionEntry,
  type ToolActivity,
  type TurnOptions,
  userMessagesBefore,
  type WorkBlock,
  withBase,
} from "./core-bridge";
import { buildTimeline, toolRowKind, type TimelineItem, type ToolPayload, type ToolRowModel } from "./timeline";
import { CONNECTOR_NAMES, connectorLinksIn, stripConnectorLinks, type ConnectorLink } from "./connector-link";
import { deepLinkPath, UI_BASE } from "./deep-link";
import {
  currentDensity,
  embedMode,
  onDensityChange,
  onRelayedDelivery,
  postPaneState,
  requestPaneExpand,
} from "./embed";
import { exitSplitIfActive, relayDeliveryToPanes } from "./split";
import { errMessage, swallow } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { escapeLoneDollars } from "./markdown-dollars";
import { splitStreamingMarkdown } from "./streaming-markdown";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import {
  transcriptModel,
  defaultEffortForModel,
  harnessSupportsEffort,
  harnessSupportsFastMode,
} from "./model-options";
import { browserRenderableImage, formatBytes, icon, relTime } from "./ui";
import { adminSessionLogUrl, appState, can, renderSidebarTop, syncUrlFromState } from "./shell";
import {
  addPendingSession,
  groupDmTitle,
  refreshSessions,
  renderList,
  sessionsState,
  sessionSlackUrl,
  surfaceOf,
} from "./sessions";
import { applySessionState, backgroundLabel, clearWorking, conversationBackground, markWorking } from "./session-list";
import { liveTurnThreadRef } from "./working-dot";
import {
  carryModelPick,
  composerForm,
  composerState,
  currentModelOption,
  focusComposerEnd,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  refreshRuntimeSelection,
  resetComposer,
  resizeComposer,
} from "./composer";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";

installMarkdownSanitizer();

export const chatState = {
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
};

let workTicker: ReturnType<typeof setInterval> | null = null;
let revealedTailLen = 0;
const detachedAgents = new WeakSet<Agent>();
let liveWorkExpanded = false;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function notePendingSessionOnSend(): void {
  if (!chatState.threadRef || chatState.sessionId !== null) return;
  const existing = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
  if (existing) {
    if (chatState.agent) adoptActiveSessionFromList(chatState.agent);
    return;
  }
  addPendingSession(chatState.threadRef, chatState.scopeId, chatState.contextName);
}

let readOnlyView: { id: string; threadRef: string; session: CoreSession } | null = null;

export function teardownActiveChat(): void {
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

export function resetChatState(): void {
  teardownActiveChat();
  proactiveOpenerStarted = false;
  chatState.rememberedThreadRef = null;
  chatState.rememberedSessionId = null;
  chatState.rememberedScopeId = null;
  chatState.rememberedContextName = null;
  connectedConnectors.clear();
}

export function newChat(context?: { scopeId: string; name: string | null }): string {
  appState.currentView = "chats";
  renderSidebarTop();
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:${crypto.randomUUID()}`;
  const carried = storedDraft(newChatDraftKey(user));
  if (carried) saveDraft(threadRef, carried);
  resetComposer();
  mountContinuable(threadRef, null, context?.scopeId ?? null, [], context?.name ?? null);
  renderList();
  focusComposerEnd();
  return threadRef;
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

export function mountContinuable(
  threadRef: string,
  sessionId: string | null,
  scopeId: string | null,
  messages: ReturnType<typeof entriesToMessages>,
  contextName: string | null = null,
): void {
  if (!appState.mainEl) return;
  exitSplitIfActive();
  readOnlyView = null;
  preserveOutgoingWorkingDot(threadRef);
  detachActiveAgent();
  resetComposer();
  chatState.threadRef = threadRef;
  chatState.sessionId = sessionId;
  chatState.scopeId = scopeId;
  chatState.contextName = contextName;
  chatState.rememberedThreadRef = threadRef;
  chatState.rememberedSessionId = sessionId;
  chatState.rememberedScopeId = scopeId;
  chatState.rememberedContextName = contextName;
  composerState.draft = storedDraft(threadRef);
  syncUrlFromState();
  chatState.transcriptAnchorSeq = null;
  chatState.earlierCount = 0;
  chatState.loadingEarlier = false;
  chatState.host = document.createElement("div");
  chatState.host.className = "custom-chat";

  const model = currentModelOption().model;
  const defaultThinkingLevel = defaultEffortForModel(model);
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model,
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
  const normalStreamFn = makeCoreStreamFn(threadRef, agent, currentTurnOptions, onWork);
  agent.streamFn = normalStreamFn;
  chatState.normalStreamFn = normalStreamFn;
  chatState.onWork = onWork;
  void refreshRuntimeSelection(scopeId, agent);

  agent.subscribe((e) => {
    scheduleStreamDraw(agent);
    if (agent === chatState.agent && (agent.state.isStreaming || e.type === "agent_end")) chatState.pendingSend = null;
    if (e.type === "agent_end" && !detachedAgents.has(agent))
      sessionsState.list = clearWorking(sessionsState.list, threadRef);
    renderList();
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
      if (wasUnsaved && chatState.sessionId) void settleNewSessionTitle(agent, chatState.sessionId);
    });
  });

  stickToBottom = true;
  appState.mainEl.replaceChildren(chatState.host);
  const opening = startProactiveOpenerIfNew(agent, threadRef, normalStreamFn, onWork, sessionId, scopeId, messages);
  drawActiveChat(agent, { forceScroll: true });
  focusComposerEnd();
  ensureDeliveryStream();
  if (!opening) void resumeTrackedRun(agent, threadRef, normalStreamFn, onWork);
  consumeBackgroundPanelRequest();
}

let proactiveOpenerStarted = false;

function startProactiveOpenerIfNew(
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
  sessionId: string | null,
  scopeId: string | null,
  messages: ReturnType<typeof entriesToMessages>,
): boolean {
  if (embedMode) return false;
  if (proactiveOpenerStarted || sessionId !== null || scopeId !== null || messages.length > 0) return false;
  if (!sessionsState.loaded) return false;
  if (sessionsState.list.some((s) => s.id)) return false;
  proactiveOpenerStarted = true;
  agent.state.messages = [{ role: "user", content: "", opener: true } as unknown as AgentMessage];
  agent.streamFn = makeOpenerStreamFn(threadRef, agent, currentTurnOptions, onWork);
  void (async () => {
    try {
      await agent.continue();
    } catch (err) {
      if (agent === chatState.agent) composerState.error = errMessage(err, "Could not start the conversation.");
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
  const { harnessId: harness } = currentModelOption();
  return {
    ...(harnessSupportsEffort(harness) ? { effortLevel: composerState.effortLevel } : {}),
    ...(harnessSupportsFastMode(harness) && typeof composerState.fastMode === "boolean"
      ? { fastMode: composerState.fastMode }
      : {}),
    harness,
    scopeId: chatState.scopeId,
    channelName: chatState.contextName,
  };
}

let deliveryStreamOpen = false;
export function ensureDeliveryStream(): void {
  if (deliveryStreamOpen) return;
  deliveryStreamOpen = true;
  const onNudge = (threadRef: string): void => {
    if (!embedMode) void refreshSessions({ silent: true });
    const ro = readOnlyView;
    if (ro && threadRef === ro.threadRef) {
      void api<{ entries: SessionEntry[] }>(`/api/sessions/${encodeURIComponent(ro.id)}`)
        .then((r) => {
          if (readOnlyView?.id === ro.id)
            mountReadOnly(readOnlyView.session, entriesToMessages(r.entries ?? [], transcriptModel()));
        })
        .catch(() => {});
      return;
    }
    const agent = chatState.agent;
    if (!agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    void refreshTranscriptFromEntries(agent);
  };
  if (embedMode) {
    onRelayedDelivery(onNudge);
  } else {
    subscribeDeliveries(
      (threadRef) => {
        relayDeliveryToPanes(threadRef);
        onNudge(threadRef);
      },
      (event) => {
        const { list, matched } = applySessionState(sessionsState.list, event);
        if (matched) {
          sessionsState.list = list;
          renderList();
        } else {
          void refreshSessions({ silent: true });
        }
      },
      () => void refreshSessions({ silent: true }),
    );
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const agent = chatState.agent;
      if (!agent || agent.state.isStreaming || !chatState.threadRef || !chatState.normalStreamFn || !chatState.onWork)
        return;
      void resumeTrackedRun(agent, chatState.threadRef, chatState.normalStreamFn, chatState.onWork);
    });
  }
}

async function approveCommand(agent: Agent, decision: ApprovalDecision): Promise<void> {
  if (agent !== chatState.agent || !chatState.threadRef || agent.state.isStreaming) return;
  if (chatState.resolvingApprovals.size > 0) return;
  chatState.resolvingApprovals.add(decision.requestId);
  composerState.error = "";
  drawActiveChat(agent);
  try {
    await runApprovalTurn(chatState.threadRef, agent, decision, currentTurnOptions, chatState.onWork ?? undefined);
  } catch (err) {
    if (agent === chatState.agent) {
      composerState.error = err instanceof Error ? err.message : "Could not send the approval.";
      drawActiveChat(agent);
    }
  } finally {
    chatState.resolvingApprovals.delete(decision.requestId);
    if (agent === chatState.agent) {
      clearLiveWork();
      try {
        await refreshSessions({ silent: true });
      } catch {
        void 0;
      }
      await refreshTranscriptFromEntries(agent);
    }
  }
}

export function resolveCommandApproval(decision: ApprovalDecision): void {
  const agent = chatState.agent;
  if (agent) void approveCommand(agent, decision);
}

export function activePendingApprovals(): PendingApproval[] {
  const agent = chatState.agent;
  if (!agent || agent.state.isStreaming) return [];
  const byId = new Map<string, PendingApproval>();
  for (const m of agent.state.messages) {
    if ((m as { role?: string }).role !== "assistant") continue;
    for (const approval of (m as AssistantWork).work?.pendingApprovals ?? []) {
      byId.set(approval.requestId, approval);
    }
  }
  return [...byId.values()];
}

export function hasUnresolvedApproval(): boolean {
  return activePendingApprovals().length > 0;
}

async function refreshTranscriptFromEntries(agent: Agent): Promise<void> {
  const sessionId = chatState.sessionId;
  if (!sessionId || agent !== chatState.agent || agent.state.isStreaming) return drawActiveChat(agent);
  const last = agent.state.messages[agent.state.messages.length - 1] as { stopReason?: string } | undefined;
  if (last?.stopReason === "error" || last?.stopReason === "aborted") return drawActiveChat(agent);
  try {
    const anchor = chatState.transcriptAnchorSeq;
    const page = await fetchTranscript(sessionId, anchor !== null ? { sinceSeq: anchor } : undefined);
    if (agent !== chatState.agent || agent.state.isStreaming) return;
    const messages = entriesToMessages(page.entries ?? [], transcriptModel());
    try {
      const r = await api<{ approvals: PendingApproval[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/approvals`);
      attachPendingApprovals(messages, r.approvals ?? [], transcriptModel());
    } catch {
      void 0;
    }
    if (agent !== chatState.agent || agent.state.isStreaming) return;
    agent.state.messages = messages;
    chatState.earlierCount = page.earlierEntries ?? 0;
    if (chatState.earlierCount === 0) chatState.transcriptAnchorSeq = null;
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

async function resumeTrackedRun(
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
): Promise<boolean> {
  if (!agent.state.messages.length) return false;
  let activeRun: Awaited<ReturnType<typeof activeRunForThread>>;
  try {
    activeRun = await activeRunForThread(threadRef);
  } catch {
    return false;
  }
  if (!activeRun || agent !== chatState.agent || appState.currentView !== "chats" || agent.state.isStreaming)
    return false;
  const msgs = agent.state.messages.slice();
  while (msgs.length && (msgs[msgs.length - 1] as { role?: string }).role === "assistant") msgs.pop();
  if (!msgs.length) return false;
  agent.state.messages = msgs;
  agent.streamFn = makeRunResumeStreamFn(activeRun.runId, activeRun.run, onWork);
  try {
    await agent.continue();
  } catch (err) {
    if (agent === chatState.agent)
      composerState.error = err instanceof Error ? err.message : "Could not reconnect to the running task.";
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
  syncUrlFromState();
  renderList();
  drawActiveChat(agent);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function postCurrentPaneState(): void {
  if (!embedMode) return;
  const live = liveTurnThreadRef({
    mountedThreadRef: chatState.threadRef,
    isStreaming: Boolean(chatState.agent?.state.isStreaming),
    pendingSend: chatState.pendingSend,
  });
  postPaneState({
    threadRef: chatState.threadRef ?? chatState.rememberedThreadRef,
    sessionId: chatState.sessionId ?? chatState.rememberedSessionId,
    working: live !== null,
  });
}

async function settleNewSessionTitle(agent: Agent, sessionId: string): Promise<void> {
  const titled = (): boolean => {
    const s = sessionsState.list.find((row) => row.id === sessionId);
    return Boolean(s?.title && s.title.trim());
  };
  if (titled()) return;
  for (const delay of [600, 1200, 2400, 4000]) {
    await sleep(delay);
    if (agent !== chatState.agent || chatState.sessionId !== sessionId) return;
    try {
      await refreshSessions({ silent: true });
    } catch {
      void 0;
    }
    if (titled()) return;
  }
}

export function mountLoadingPane(): void {
  if (!appState.mainEl || appState.currentView !== "chats") return;
  const host = document.createElement("div");
  host.className = "custom-chat";
  render(
    html`<div class="custom-chat-shell">
      <div class="chat-loading"><span class="spinner"></span></div>
    </div>`,
    host,
  );
  appState.mainEl.replaceChildren(host);
}

export function mountReadOnly(
  s: CoreSession,
  messages: ReturnType<typeof entriesToMessages>,
  earlierCount = 0,
  anchorSeq: number | null = null,
): void {
  if (!appState.mainEl) return;
  exitSplitIfActive();
  preserveOutgoingWorkingDot(s.threadRef);
  detachActiveAgent();
  chatState.agent = null;
  clearLiveWork();
  chatState.host = null;
  resetComposer();
  chatState.threadRef = null;
  chatState.sessionId = s.id;
  chatState.scopeId = s.scopeId;
  syncUrlFromState();

  resetBackgroundPanel();
  const host = document.createElement("div");
  host.className = "custom-chat readonly-chat";
  const draw = () =>
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
            <div class="message-stack">
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
                            const scroller = appState.mainEl?.querySelector<HTMLElement>(".chat-scroll");
                            const priorHeight = scroller?.scrollHeight ?? 0;
                            const priorTop = scroller?.scrollTop ?? 0;
                            const remaining = page.earlierEntries ?? 0;
                            mountReadOnly(
                              s,
                              [...entriesToMessages(page.entries ?? [], transcriptModel()), ...messages],
                              remaining,
                              remaining > 0 ? (page.entries?.[0]?.seq ?? null) : null,
                            );
                            requestAnimationFrame(() => {
                              const scrollerNow = appState.mainEl?.querySelector<HTMLElement>(".chat-scroll");
                              if (!scrollerNow) return;
                              scrollerNow.scrollTop = priorTop + (scrollerNow.scrollHeight - priorHeight);
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
              ${messages.length ? messages.map((m, i) => chatMessage(m, i)) : html`<div class="empty compact">No readable messages in this conversation.</div>`}
            </div>
          </section>
        </div>
      `,
      host,
    );
  readonlyRedraw = draw;
  draw();
  appState.mainEl.replaceChildren(host);
  readOnlyView = { id: s.id, threadRef: s.threadRef, session: s };
  ensureDeliveryStream();
  consumeBackgroundPanelRequest();
}

function welcomeGreeting(): TemplateResult {
  return html`
    <article class="message-row assistant-row welcome-greeting">
      <div class="assistant-body">
        <div class="streaming-text">
          ${markdown(
            "Hi — I'm your AI teammate 👋\n\n" +
              "I run tasks on a computer of my own and work across your connected tools — Slack, Google Workspace, GitHub, Linear, and the open web — and I remember what we work on together.\n\n" +
              "Want to get set up? Tell me your name and what you're working on, and I'll take it from there — or just ask me anything to dive straight in.",
          )}
        </div>
      </div>
    </article>
  `;
}

export function setTranscriptWindow(anchorSeq: number | null, earlierCount: number): void {
  chatState.transcriptAnchorSeq = earlierCount > 0 ? anchorSeq : null;
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
    const earlierMessages = entriesToMessages(page.entries ?? [], transcriptModel());
    const scroller = chatState.host?.querySelector<HTMLElement>(".chat-scroll");
    const priorHeight = scroller?.scrollHeight ?? 0;
    const priorTop = scroller?.scrollTop ?? 0;
    agent.state.messages = [...earlierMessages, ...agent.state.messages];
    const remaining = page.earlierEntries ?? 0;
    chatState.transcriptAnchorSeq = remaining > 0 ? (page.entries?.[0]?.seq ?? null) : null;
    chatState.earlierCount = remaining;
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
      <button type="button" class="pane-strip" title="Expand this pane" @click=${() => requestPaneExpand()}>
        <span class="pane-strip-text">${now ?? snippet}</span>
        ${icon(Maximize2, 13)}
      </button>
    `;
  }
  return html`
    <section class="pane-card" aria-live="polite">
      ${now ? html`<div class="pane-card-now"><span class="pane-card-now-label">Now</span><span class="pane-card-now-text">${now}</span></div>` : nothing}
      ${snippet ? html`<div class="pane-card-last">${snippet}</div>` : nothing}
    </section>
  `;
}

function paneNowLine(agent: Agent): string | null {
  if (activePendingApprovals().length) return "Needs your approval";
  if (agent.state.isStreaming || chatState.resolvingApprovals.size > 0) {
    const work = chatState.liveWork ?? { status: "thinking", activity: [] };
    const summary = liveWorkSummary(work);
    if (!summary) return "Thinking…";
    return summary.detail ? `${summary.label} — ${summary.detail}` : summary.label;
  }
  return null;
}

onDensityChange(() => drawActiveChat());

export function drawActiveChat(agent = chatState.agent, opts: { forceScroll?: boolean } = {}): void {
  if (!agent || agent !== chatState.agent || !chatState.host || appState.currentView !== "chats") return;
  const messages = visibleMessages(agent);
  const isNewUser = sessionsState.list.filter((s) => s.id).length === 0;
  let messageContent: Array<TemplateResult | typeof nothing> | TemplateResult | typeof nothing = nothing;
  if (messages.length) {
    messageContent = messages.map((m, i) =>
      settledChatMessage(m, i, agent.state.isStreaming && m === agent.state.streamingMessage),
    );
  } else if (isNewUser) {
    messageContent = welcomeGreeting();
  }
  const tier = currentDensity();
  const glanceTier = tier === "card" || tier === "strip" ? tier : null;
  render(
    html`
      <div
        class="custom-chat-shell ${composerState.dragging ? "dragging" : ""}"
        @dragenter=${(e: DragEvent) => onDragEnter(e)}
        @dragover=${(e: DragEvent) => onDragOver(e)}
        @dragleave=${(e: DragEvent) => onDragLeave(e)}
        @drop=${(e: DragEvent) => void onDrop(e, agent)}
      >
        ${
          composerState.dragging
            ? html`<div class="drop-overlay">
                <div class="drop-overlay-card">${icon(Files, 30)}<span>Drop files or folders to attach</span></div>
              </div>`
            : nothing
        }
        ${contextBanner()}
        ${
          glanceTier
            ? paneGlance(agent, messages, glanceTier)
            : html`<section class="chat-scroll" @scroll=${onTranscriptScroll}>
                <div class="message-stack ${messages.length ? "" : "empty-stack"}">
                  ${chatState.earlierCount > 0 ? earlierNotice(agent) : nothing} ${messageContent}
                  ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}
                </div>
              </section>`
        }
        <div class="chat-bottom-dock">${backgroundActivityStrip()} ${liveWorkDock(agent)} ${composerForm(agent)}</div>
      </div>
    `,
    chatState.host,
  );
  decorateStreamingTail();
  resizeComposer();
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

function contextBanner(): TemplateResult | typeof nothing {
  const label = sharedContextLabel(chatState.scopeId, chatState.contextName);
  if (!label) return nothing;
  const glyph = chatState.scopeId?.startsWith("group:") ? Users : Hash;
  return html`<div
    class="context-banner"
    title="This chat runs in the ${label} context — the agent works with that context's files and memory, separate from your personal context."
  >
    ${icon(glyph, 13)}<span><strong>${label}</strong> context</span>
  </div>`;
}

function chatHeader(title: string | TemplateResult, detail: string, readOnly: boolean): TemplateResult {
  return html`
    <header class="chat-topbar">
      <div class="chat-heading">
        <div class="chat-title">${title}</div>
        <div class="chat-subtitle">${readOnly ? "Read-only" : detail}</div>
      </div>
      <div class="topbar-actions">
        ${
          chatState.sessionId && can("admin")
            ? html`<a
                class="icon-btn subtle"
                title="View session log (admin)"
                href=${adminSessionLogUrl(chatState.sessionId, chatState.scopeId ?? `org:${appState.me?.org ?? ""}`)}
                target="_blank"
                rel="noreferrer"
                >${icon(ScrollText, 17)}</a
              >`
            : nothing
        }
        <button
          class="icon-btn subtle"
          title="Refresh conversations"
          @click=${() => void refreshSessions({ refreshContexts: true })}
        >
          ${icon(RefreshCw, 17)}
        </button>
      </div>
    </header>
  `;
}

function visibleMessages(agent: Agent): AgentMessage[] {
  const out = [...agent.state.messages];
  if (agent.state.streamingMessage) out.push(agent.state.streamingMessage);
  return out;
}

interface SettledRowKey {
  index: number;
  activity: WorkBlock["activity"] | undefined;
  status: WorkBlock["status"] | undefined;
  stale: boolean | undefined;
  deliveredFiles: unknown;
  stopReason: unknown;
  errorMessage: unknown;
  approvalDecision: unknown;
  forkable: boolean;
  tpl: TemplateResult | typeof nothing;
}
const settledRowCache = new WeakMap<object, SettledRowKey>();

function settledChatMessage(
  message: AgentMessage,
  index: number,
  isStreaming: boolean,
): TemplateResult | typeof nothing {
  const msg = message as AssistantWork & { stopReason?: string; errorMessage?: string; approvalDecision?: string };
  const work = msg.work;
  const cacheable =
    !isStreaming &&
    (!work || ((work.status === "complete" || work.status === "failed") && !work.pendingApprovals?.length));
  if (!cacheable) return chatMessage(message, index, isStreaming);
  const forkable = Boolean(chatState.threadRef && chatState.sessionId && chatState.agent);
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
    hit.forkable === forkable
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
    forkable,
    tpl,
  });
  return tpl;
}

function chatMessage(message: AgentMessage, index: number, isStreaming = false): TemplateResult | typeof nothing {
  if ((message as { opener?: boolean }).opener) return nothing;
  const role = (message as { role?: string }).role;
  if (role === "user" || role === "user-with-attachments") {
    const attachments = ((message as UserMessageWithAttachments).attachments ?? []) as UserAttachmentView[];
    const steered = Boolean((message as { steered?: boolean }).steered);
    return html`
      <article class="message-row user-row ${steered ? "steered-row" : ""}" data-index=${index}>
        ${steered ? html`<div class="steer-label">↪ steered the running task</div>` : nothing}
        <div class="message-bubble user-bubble">
          ${markdown(messageText(message))}
          ${attachments.length ? html`<div class="message-files">${attachments.map(userAttachmentBadge)}</div>` : nothing}
        </div>
        ${messageMeta(message, index)}
      </article>
    `;
  }
  if (role === "assistant") {
    const msg = message as AssistantMessage;
    const work = isStreaming ? null : (msg as AssistantWork).work;
    const text = messageText(msg).trim();
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

function messageMeta(message: AgentMessage, index: number): TemplateResult | typeof nothing {
  const text = messageText(message).trim();
  const ts = (message as { timestamp?: number }).timestamp;
  if (!text && ts === undefined) return nothing;
  const forkable = Boolean(chatState.threadRef && chatState.sessionId && chatState.agent);
  return html`
    <div class="message-meta">
      ${ts !== undefined ? html`<span class="message-time">${formatClock(ts)}</span>` : nothing}
      ${
        text
          ? html`<button
              class="msg-copy"
              type="button"
              title="Copy"
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
              title="Fork conversation from here"
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
    carryModelPick(sourceThreadRef, forked.session.threadRef);
    mountContinuable(
      forked.session.threadRef,
      forked.session.id,
      forked.session.scopeId,
      entriesToMessages(forked.entries ?? [], transcriptModel()),
      forked.session.channelName ?? null,
    );
    await refreshSessions({ silent: true });
    renderList();
  } catch (err) {
    composerState.error = errMessage(err, "Could not fork the conversation.");
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

const connectedConnectors = new Set<string>();

export function markConnectorConnected(provider: string): void {
  if (!provider) return;
  connectedConnectors.add(provider);
  if (chatState.agent) drawActiveChat();
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
        ><strong>Connected ${name}</strong><small>Authorized — its tools work here now</small></span
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

function assistantContent(message: AssistantMessage, isStreaming = false, hasWork = false): TemplateResult[] {
  const parts: TemplateResult[] = [];
  for (const chunk of message.content) {
    if (chunk.type === "text" && chunk.text.trim()) {
      const links = connectorLinksIn(chunk.text, location.origin);
      const body = links.length ? stripConnectorLinks(chunk.text) : chunk.text;
      if (body.trim())
        parts.push(
          html`<div class="streaming-text ${isStreaming ? "live-stream" : ""}">
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
  if (parts.length === 0 && message.stopReason !== "error" && message.stopReason !== "aborted" && !hasWork)
    parts.push(typingRow());
  return parts;
}

function assistantFileList(files: DeliveredFile[] | undefined): TemplateResult | typeof nothing {
  if (!files?.length) return nothing;
  return html`<div class="message-files">${files.map((f) => deliveredFileBadge(f))}</div>`;
}

function markdown(text: string): TemplateResult {
  return html`<markdown-block .content=${escapeLoneDollars(text)}></markdown-block>`;
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
      escapedSegs[i] = escapeLoneDollars(seg);
    }
  }
  escapedSrc.length = segments.length;
  escapedSegs.length = segments.length;
  return html`${escapedSegs.map((seg) => html`<markdown-block .content=${seg}></markdown-block>`)}<markdown-block
      class="stream-tail"
      .content=${escapeLoneDollars(tail)}
    ></markdown-block>`;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextContent => Boolean(c) && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

function typingRow(): TemplateResult {
  return html`<div class="thinking-placeholder">${sheenLabel("Thinking", true)}</div>`;
}

function syncWorkTicker(): void {
  const active = chatState.liveWork?.status === "working" && !chatState.liveWork.stale;
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

function shouldShowApprovalWork(message: AssistantMessage, work: WorkBlock | null | undefined, text: string): boolean {
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

export function requestBackgroundPanel(sessionId: string | null, threadRef: string | null): void {
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
    bgPanel.detail = { jobs: [], watches: [] };
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
    if (row && ((row.backgroundJobs ?? 0) !== d.jobs.length || (row.watches ?? 0) !== d.watches.length)) {
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
    bgPanel.open && bgPanel.detail ? backgroundLabel(bgPanel.detail.jobs.length, bgPanel.detail.watches.length) : null;
  const label = (live ?? row)?.label;
  if (!label && !bgPanel.open) return nothing;
  return html`
    <section class="bg-activity ${bgPanel.open ? "expanded" : ""}">
      <button
        type="button"
        class="bg-activity-strip"
        aria-expanded=${String(bgPanel.open)}
        title=${bgPanel.open ? "Hide background activity" : "Work continuing on the agent's computer — click to inspect"}
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
  const empty = d && d.jobs.length === 0 && d.watches.length === 0;
  return html`<div class="bg-panel" role="region" aria-label="Background activity">
    ${bgPanel.error ? html`<div class="bg-panel-note">${bgPanel.error}</div>` : nothing}
    ${!d && bgPanel.loading ? html`<div class="bg-panel-note">Loading…</div>` : nothing}
    ${empty && !bgPanel.error ? html`<div class="bg-panel-note">Nothing running here anymore.</div>` : nothing}
    ${d ? d.jobs.map((j) => backgroundJobRow(j)) : nothing} ${d ? d.watches.map((w) => backgroundWatchRow(w)) : nothing}
  </div>`;
}

function backgroundJobRow(j: SessionBackgroundView["jobs"][number]): TemplateResult {
  const open = bgPanel.openJob === j.processId;
  const out = bgPanel.output.get(j.processId);
  const status =
    out?.state === "exited" ? `exited${out.exitCode !== undefined ? ` (${out.exitCode})` : ""}` : timeLeft(j.expiresAt);
  return html`
    <div class="bg-row ${open ? "open" : ""}">
      <button
        type="button"
        class="bg-row-head"
        aria-expanded=${String(open)}
        title=${open ? "Hide output" : "Show live output"}
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

function backgroundWatchRow(w: SessionBackgroundView["watches"][number]): TemplateResult {
  const what = w.pattern ? `output matching /${w.pattern}/` : "any new output";
  const note = w.instructions?.trim();
  return html`
    <div class="bg-row watch">
      <div class="bg-row-head static">
        ${icon(Radar, 13)}
        <span class="bg-row-cmd">Watch — wakes on ${what}${note ? ` · “${note}”` : ""}</span>
        <span class="bg-row-meta"
          >armed ${relTime(w.createdAt)}${w.lastFiredAt ? ` · last fired ${relTime(w.lastFiredAt)}` : ""} ·
          ${timeLeft(w.expiresAt)}</span
        >
      </div>
    </div>
  `;
}

function liveWorkDock(agent: Agent): TemplateResult | typeof nothing {
  if (!agent.state.isStreaming && chatState.resolvingApprovals.size === 0) return nothing;
  const work = chatState.liveWork ?? { status: "thinking", activity: [] };
  if (work.status !== "thinking" && work.status !== "working") return nothing;
  const summary = liveWorkSummary(work);
  const expandable = Boolean(summary?.detail);
  const expanded = expandable && liveWorkExpanded;
  let title = "";
  if (expandable) title = liveWorkExpanded ? "Show less" : "Show more";
  return html`
    <section class="live-work-dock ${expanded ? "expanded" : ""}" aria-live="polite">
      <button
        type="button"
        class="live-work-line ${expandable ? "" : "static"}"
        ?disabled=${!expandable}
        aria-expanded=${expandable ? String(liveWorkExpanded) : nothing}
        title=${title}
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
      label: verb ? `${verb} interrupted — resuming…` : "Interrupted — resuming…",
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

function workSeconds(work: WorkBlock): number {
  if (work.startedAt == null) return 0;
  const end = work.finishedAt ?? Date.now();
  return Math.max(0, Math.round((end - work.startedAt) / 1000));
}

function usedToolsSuffix(work: WorkBlock): string {
  const n = work.activity.filter((a) => a.type === "tool_call").length;
  return n > 0 ? ` (used ${n} tool${n === 1 ? "" : "s"})` : "";
}

function workLabel(work: WorkBlock): string {
  if (work.stale && (work.status === "thinking" || work.status === "working")) return "Interrupted — resuming…";
  if (work.status === "thinking") return "Thinking";
  const secs = workSeconds(work);
  return work.status === "working" ? `Working for ${secs}s` : `Worked for ${secs}s`;
}

function workBlock(work: WorkBlock, isStreaming: boolean): TemplateResult {
  if (work.status === "thinking" && !work.activity.length) {
    return html`<div class="work work-thinking">
      <div class="work-head">${sheenLabel(workLabel(work), isStreaming)}</div>
    </div>`;
  }
  const timeline = buildTimeline(work);
  const rows = timeline.length
    ? html`<div class="work-rows">
        ${timeline.map((it) => renderTimelineItem(it, work.status, work.stale === true))}
      </div>`
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
        <div class="work-rows">${items.map((it) => renderTimelineItem(it, work.status, work.stale === true))}</div>
      </details>`,
    );
  };
  for (const it of timeline) {
    const demoted = it.kind === "text" && (it.activity.payload as { demoted?: boolean } | null)?.demoted === true;
    if (it.kind === "text" && !demoted) {
      flushSeg();
      const text = ((it.activity.payload as { text?: string } | null)?.text ?? "").trim();
      if (text) parts.push(html`<div class="work-said">${markdown(text)}</div>`);
    } else {
      seg.push(it);
    }
  }
  flushSeg();
  return html`<div class="work work-${work.status}">${parts}</div>`;
}

function segmentSummaryLabel(items: TimelineItem[], work: WorkBlock): string {
  const tools = items.filter((it) => it.kind === "tool").length;
  if (tools > 0) return `${tools} tool call${tools === 1 ? "" : "s"}`;
  const secs = workSeconds(work);
  return work.status === "failed" ? `Failed after ${secs}s` : `Worked for ${secs}s`;
}

export function approvalSummaryView(a: PendingApproval, expanded = false): TemplateResult {
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
        : html`<code class="approval-summary" title=${a.command}>${summary}</code>`
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

function renderTimelineItem(item: TimelineItem, status: WorkBlock["status"], stale = false): TemplateResult {
  if (item.kind === "thinking") return thinkingRow(item.activity);
  if (item.kind === "text") return messageRow(item.activity);
  if (item.kind === "approval") return approvalMarker(item.approval);
  return toolRow(item.row, status, stale);
}

function thinkingRow(activity: ToolActivity): TemplateResult {
  const text = (activity.payload as { thinking?: string } | null)?.thinking ?? "";
  return html`<div class="thinking">${markdown(text)}</div>`;
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

function firstLine(s: string, max = 72): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolDetail(tool: string, call: ToolPayload, result: ToolPayload): string {
  switch (tool) {
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
      return "";
  }
}

function toolRow(row: ToolRowModel, status: WorkBlock["status"], stale = false): TemplateResult {
  if (row.approval) {
    const p = (row.approval.payload ?? {}) as ToolPayload;
    return html`<div class="tool-row tool-approval">
      <span class="tool-icon">${icon(Wrench, 15)}</span>
      <span class="tool-label"
        >Approval needed${p.reason ? html` <span class="tool-detail">${firstLine(p.reason, 90)}</span>` : nothing}</span
      >
    </div>`;
  }
  const call = (row.call?.payload ?? {}) as ToolPayload;
  const result = (row.result?.payload ?? {}) as ToolPayload;
  const tool = call.tool ?? result.tool ?? "unknown";
  const meta = TOOL_META[tool] ?? UNKNOWN_TOOL;
  const kind = toolRowKind(row, status);
  let label = meta.attempted;
  if (kind === "approval") label = "Approval needed";
  else if (kind === "running") label = stale ? `${meta.active} — interrupted` : meta.active;
  else if (kind === "ok") label = meta.done;
  let why = "";
  if (kind === "approval") why = firstLine(result.reason ?? "", 90);
  else if (kind === "failed") why = firstLine(result.error ?? result.reason ?? "", 90);
  const base = kind === "approval" ? "" : toolDetail(tool, call, result);
  const attempts = row.attempts && row.attempts > 1 ? `${row.attempts} attempts` : "";
  const detail = [base, why, attempts].filter(Boolean).join(" · ");
  const classes = ["tool-row", `tool-${kind}`].join(" ");
  const head = html`<span class="tool-icon">${icon(meta.icon, 15)}</span>
    <span class="tool-label">${label}${detail ? html` <span class="tool-detail">${detail}</span>` : nothing}</span>`;
  if (tool === "execute" && row.result && (result.stdout || result.stderr)) {
    return html`<details class="${classes} tool-expandable">
      <summary class="tool-summary">${head}${icon(ChevronRight, 14)}</summary>
      ${execOutputCard(result)}
    </details>`;
  }
  return html`<div class="${classes}">${head}</div>`;
}

function execOutputCard(result: ToolPayload): TemplateResult {
  const out = [result.stdout ?? "", result.stderr ? `[stderr]\n${result.stderr}` : ""].filter(Boolean).join("\n");
  return html`<div class="code-card">
    <div class="code-card-head"><span class="code-card-lang">bash</span></div>
    <pre class="code-card-body">${out}</pre>
    <div class="code-card-foot">exit ${result.code ?? 0}${result.timedOut ? " · timed out" : ""}</div>
  </div>`;
}

function chipBadge(glyph: IconNode, name: string, size?: number, href?: string, download = false): TemplateResult {
  const inner = html`${icon(glyph, 14)}<span>${name}</span>${typeof size === "number" ? html`<small>${formatBytes(size)}</small>` : nothing}`;
  if (!href) return html`<span class="file-chip">${inner}</span>`;
  return download
    ? html`<a class="file-chip" href=${href} download=${name}>${inner}</a>`
    : html`<a class="file-chip" href=${href} target="_blank" rel="noreferrer">${inner}</a>`;
}

function fileChip(name: string, size?: number, href?: string): TemplateResult {
  return chipBadge(Paperclip, name, size, href);
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

function userAttachmentBadge(a: UserAttachmentView): TemplateResult {
  const artifactHref = a.artifactId ? withBase(`/api/files/${encodeURIComponent(a.artifactId)}/content`) : undefined;
  if (a.mimeType?.startsWith("image/")) {
    let src = artifactHref;
    if (!src && a.content) {
      src = a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`;
    }
    if (src && !browserRenderableImage(a.mimeType)) return imageChip(a.fileName, a.size, src);
    if (src) {
      const img = html`<img src=${src} alt=${a.fileName} loading="lazy" />`;
      return artifactHref
        ? html`<a class="file-image" href=${artifactHref} target="_blank" rel="noreferrer" title=${a.fileName}
            >${img}</a
          >`
        : html`<span class="file-image" title=${a.fileName}>${img}</span>`;
    }
  }
  return fileChip(a.fileName, a.size, artifactHref);
}

function deliveredFileBadge(file: DeliveredFile): TemplateResult {
  if (!file.artifactId) return fileChip(file.name, file.sizeBytes);
  const href = withBase(`/api/files/${encodeURIComponent(file.artifactId)}/content`);
  if (file.mimetype?.startsWith("image/")) {
    if (!browserRenderableImage(file.mimetype)) return imageChip(file.name, file.sizeBytes, href);
    return html`<a class="file-image" href=${href} target="_blank" rel="noreferrer" title=${file.name}
      ><img src=${href} alt=${file.name} loading="lazy"
    /></a>`;
  }
  return fileChip(file.name, file.sizeBytes, href);
}

let stickToBottom = true;

function onTranscriptScroll(e: Event): void {
  const s = e.currentTarget as HTMLElement;
  stickToBottom = s.scrollHeight - s.scrollTop - s.clientHeight <= 120;
}

function scrollTranscript(force = false): void {
  const scroller = chatState.host?.querySelector<HTMLElement>(".chat-scroll");
  if (!scroller) return;
  if (!force && !stickToBottom) return;
  requestAnimationFrame(() => {
    if (force) {
      const prev = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = "auto";
      scroller.scrollTop = scroller.scrollHeight;
      requestAnimationFrame(() => {
        scroller.style.scrollBehavior = prev;
      });
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  });
}
