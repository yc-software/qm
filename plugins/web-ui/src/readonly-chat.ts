import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { html, nothing, render, type TemplateResult } from "lit";
import "./slack-reply";
import type { SlackReply } from "./slack-reply";
import { SlackOutbox } from "./slack-outbox";
import { openInSurface, slackTitle } from "./slack-thread-view";
import {
  TAIL_TURNS,
  currentEarlierCount,
  fetchSessionApprovals,
  fetchTranscript,
  inheritedTranscript,
  itemsToMessages,
  makeCoreStreamFn,
  runApprovalTurn,
  unresolvedApprovals,
  type ApprovalDecision,
  type CoreSession,
  type PendingApproval,
  type SessionPin,
  type TranscriptPage,
  type TurnOptions,
  type WorkBlock,
  type createRunSlot,
} from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { reportHandledError } from "./browser-errors.ts";
import { transcriptModel } from "./model-options";
import { chatSurfaceOf, repliesAsViewer } from "./session-list";
import { defaultSessionTitle, groupDmTitle, sessionSlackUrl } from "./sessions";
import { appState } from "./shell";
import { decorateTextCodeBlocks } from "./text-code";
import { preserveTranscriptScroll, type createTranscriptViewport } from "./transcript-viewport";

export type ReadOnlyChatState = {
  host: HTMLElement | null;
  agent: Agent | null;
  threadRef: string | null;
  sessionId: string | null;
  scopeId: string | null;
  forkSession: CoreSession | null;
  transcriptAnchorSeq: number | null;
  earlierCount: number;
  loadingEarlier: boolean;
  inheritedMessages: AgentMessage[];
  inheritedLoaded: boolean;
  inheritedExpanded: boolean;
  pins: SessionPin[];
  goal: unknown;
  turnRuntime: unknown;
  normalStreamFn: Agent["streamFn"] | null;
  onWork: ((work: WorkBlock) => void) | null;
  resolvingApprovals: Set<string>;
};

export type ReadOnlyChatDeps = {
  chatState: ReadOnlyChatState;
  claimContainer: () => HTMLElement | null;
  ensureDeliveryStream: () => void;
  resetComposer: () => void;
  composerApprovalPanel: (approvals: PendingApproval[]) => TemplateResult;
  composerError: { get: () => string; set: (value: string) => void };
  preserveOutgoingWorkingDot: (threadRef: string | null) => void;
  dropAbandonedNewChat: (threadRef: string) => void;
  detachActiveChat: () => void;
  clearLiveWork: () => void;
  resetForkOrigin: () => void;
  syncLocation: () => void;
  resetBackgroundPanel: () => void;
  consumeBackgroundPanelRequest: () => void;
  openThinking: Set<string>;
  observeLiveWork: (agent: Agent) => (work: WorkBlock) => void;
  currentTurnOptions: () => TurnOptions;
  runSlot: ReturnType<typeof createRunSlot>;
  slackOutbox: SlackOutbox;
  onDelivery: (threadRef: string) => void;
  visibleMessages: (agent: Agent) => AgentMessage[];
  prepareMessageRows: (messages: AgentMessage[]) => void;
  goalStrip: (agent: Agent, opts?: { readOnly?: boolean }) => TemplateResult | typeof nothing;
  chatHeader: (
    title: string | TemplateResult,
    subtitle: string | null,
    messages: AgentMessage[],
    people: { shown: number; named: boolean },
    action?: TemplateResult | typeof nothing,
  ) => TemplateResult;
  swarmStrip: (sessionId: string) => TemplateResult | typeof nothing;
  backgroundActivityStrip: () => TemplateResult | typeof nothing;
  pinnedStrip: () => TemplateResult | typeof nothing;
  inheritedHeader: () => TemplateResult | typeof nothing;
  settledChatMessage: (message: AgentMessage, index: number, isStreaming: boolean) => TemplateResult | typeof nothing;
  liveWorkStatus: (agent: Agent) => TemplateResult | typeof nothing;
  scrollBottomButton: () => TemplateResult;
  scrollToBottom: () => void;
  transcriptViewport: ReturnType<typeof createTranscriptViewport>;
  bindAgentLifecycle: (
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    hooks?: { afterRefresh?: () => void },
  ) => void;
  resumeTrackedRun: (
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    runningSince?: number,
  ) => Promise<void>;
  setPins: (pins: SessionPin[]) => void;
};

export type ReadOnlyChatController = {
  active: () => boolean;
  clear: () => void;
  redraw: () => void;
  approve: (decision: ApprovalDecision) => Promise<void> | null;
  mount: (
    s: CoreSession,
    messages: ReturnType<typeof itemsToMessages>,
    earlierCount?: number,
    anchorSeq?: number | null,
    inheritedMessages?: ReturnType<typeof itemsToMessages>,
  ) => void;
  mountPage: (s: CoreSession, page: TranscriptPage) => void;
};

export function createReadOnlyChat(deps: ReadOnlyChatDeps): ReadOnlyChatController {
  const { chatState } = deps;
  let sessionId: string | null = null;
  let redrawFn: (() => void) | null = null;
  let approveFn: ((decision: ApprovalDecision) => Promise<void>) | null = null;
  let followSend = false;

  function clear(): void {
    sessionId = null;
    redrawFn = null;
    approveFn = null;
  }

  function mount(
    s: CoreSession,
    messages: ReturnType<typeof itemsToMessages>,
    earlierCount = 0,
    anchorSeq: number | null = null,
    inheritedMessages: ReturnType<typeof itemsToMessages> = [],
  ): void {
    const container = deps.claimContainer();
    if (!container) return;
    const sameSession = sessionId === s.id;
    deps.preserveOutgoingWorkingDot(s.threadRef);
    deps.dropAbandonedNewChat(s.threadRef);
    deps.detachActiveChat();
    deps.clearLiveWork();
    chatState.host = null;
    deps.resetComposer();
    if (!sameSession) deps.resetForkOrigin();
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
    deps.syncLocation();

    deps.resetBackgroundPanel();
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: transcriptModel(),
        messages,
        tools: [],
      },
      convertToLlm: () => [],
    });
    chatState.agent = agent;
    chatState.resolvingApprovals.clear();
    deps.openThinking.clear();
    const onWork = deps.observeLiveWork(agent);
    const normalStreamFn = makeCoreStreamFn(s.threadRef, agent, deps.currentTurnOptions, onWork, deps.runSlot);
    agent.streamFn = normalStreamFn;
    chatState.normalStreamFn = normalStreamFn;
    chatState.onWork = onWork;

    const priorHost = sameSession ? container.querySelector<HTMLElement>(":scope > .readonly-chat") : null;
    const restoreScroll = priorHost ? preserveTranscriptScroll(priorHost) : null;
    const host = priorHost ?? document.createElement("div");
    host.className = `custom-chat readonly-chat ${s.surface === "slack" ? "slack-thread-chat" : ""}`;
    chatState.host = host;
    const chatSurface = chatSurfaceOf(s);
    const priorReply = sameSession ? container.querySelector<SlackReply>("qm-slack-reply") : null;
    const slackReply = repliesAsViewer(s)
      ? (priorReply ?? (document.createElement("qm-slack-reply") as SlackReply))
      : null;
    if (slackReply) {
      slackReply.sessionId = s.id;
      slackReply.user = appState.me?.user ?? "";
      if (!priorReply) {
        deps.slackOutbox.listen(slackReply, {
          queued: () => {
            redrawFn?.();
            deps.scrollToBottom();
          },
          sent: () => {
            followSend = true;
            deps.onDelivery(s.threadRef);
          },
          dropped: () => redrawFn?.(),
        });
      }
    }
    deps.slackOutbox.confirm(s.id, messages);
    let approvals: PendingApproval[] = [];
    const draw = () => {
      if (agent !== chatState.agent) return;
      approvals = unresolvedApprovals(approvals);
      const currentMessages = deps.visibleMessages(agent);
      deps.slackOutbox.confirm(s.id, currentMessages);
      const inheritedOffset = chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0;
      const shownMessages = [
        ...(chatState.inheritedExpanded ? chatState.inheritedMessages : []),
        ...currentMessages,
        ...deps.slackOutbox.pending(s.id),
      ];
      deps.prepareMessageRows(shownMessages);
      const goalBar = deps.goalStrip(agent, { readOnly: true });
      deps.transcriptViewport.beforeRender();
      render(
        html`
          <div class="custom-chat-shell">
            ${
              s.surface === "slack"
                ? deps.chatHeader(
                    s.type === "channel" ? slackTitle(defaultSessionTitle(s), s.title?.trim()) : groupDmTitle(s),
                    null,
                    shownMessages,
                    { shown: 3, named: true },
                    openInSurface(sessionSlackUrl(s), chatSurface?.label),
                  )
                : deps.chatHeader(groupDmTitle(s), chatSurface ? chatSurface.label : "Read-only", shownMessages, {
                    shown: 5,
                    named: false,
                  })
            }
            ${
              slackReply
                ? nothing
                : html`<div class="readonly-banner">
                    This conversation is read-only here.${chatSurface ? ` Reply in ${chatSurface.label}.` : ""}
                  </div>`
            }
            ${deps.swarmStrip(s.id)} ${deps.backgroundActivityStrip()}
            ${approvals.length ? deps.composerApprovalPanel(approvals) : nothing}
            <section class="chat-scroll readonly-scroll" tabindex="0" aria-label="Conversation">
              ${deps.pinnedStrip()}
              <div class="message-stack">
                ${deps.inheritedHeader()}
                ${
                  chatState.earlierCount > 0
                    ? html`<div class="earlier-messages">
                        <button
                          class="earlier-messages-btn"
                          @click=${async (e: Event) => {
                            const btn = e.currentTarget as HTMLButtonElement;
                            btn.disabled = true;
                            btn.textContent = "Loading earlier messages\u2026";
                            chatState.loadingEarlier = true;
                            try {
                              const currentAnchor = chatState.transcriptAnchorSeq;
                              const page = await fetchTranscript(
                                s.id,
                                currentAnchor !== null
                                  ? { beforeSeq: currentAnchor, tailTurns: TAIL_TURNS }
                                  : undefined,
                              );
                              if (chatState.sessionId !== s.id || agent !== chatState.agent) return;
                              const rawRemaining = page.earlierItems ?? 0;
                              const remaining = currentEarlierCount(s, rawRemaining);
                              const split = inheritedTranscript(s, page.items);
                              const nextAnchor = rawRemaining > 0 ? (page.items?.[0]?.seq ?? null) : null;
                              agent.state.messages = [
                                ...itemsToMessages(split.current, transcriptModel()),
                                ...agent.state.messages,
                              ];
                              chatState.earlierCount = remaining;
                              chatState.transcriptAnchorSeq = nextAnchor;
                              chatState.inheritedMessages = [
                                ...itemsToMessages(split.inherited, transcriptModel()),
                                ...chatState.inheritedMessages,
                              ];
                              draw();
                            } catch (error) {
                              reportHandledError("web:earlier_messages", error);
                              btn.disabled = false;
                              btn.textContent = "Show earlier messages";
                            } finally {
                              chatState.loadingEarlier = false;
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
                    ? shownMessages.map((m, i) =>
                        deps.settledChatMessage(
                          m,
                          i - inheritedOffset,
                          agent.state.isStreaming && m === agent.state.streamingMessage,
                        ),
                      )
                    : nothing
                }
                ${
                  !shownMessages.length && !agent.state.isStreaming
                    ? html`<div class="empty compact">No readable messages in this conversation.</div>`
                    : nothing
                }
                ${deps.liveWorkStatus(agent)}
                ${deps.composerError.get() ? html`<div class="composer-error inline">${deps.composerError.get()}</div>` : nothing}
              </div>
            </section>
            <div class="chat-bottom-dock">${goalBar} ${slackReply ?? nothing} ${deps.scrollBottomButton()}</div>
          </div>
        `,
        host,
      );
      deps.transcriptViewport.afterRender();
      requestAnimationFrame(() => {
        decorateTextCodeBlocks(host);
        if (host.isConnected) deps.transcriptViewport.sync(host.querySelector<HTMLElement>(".chat-scroll"));
      });
    };
    const current = (): boolean => redrawFn === draw;
    const refreshApprovals = async (): Promise<void> => {
      const result = await fetchSessionApprovals(s.id);
      if (!current()) return;
      approvals = result?.approvals ?? [];
      draw();
    };
    approveFn = async (decision) => {
      if (!current() || chatState.resolvingApprovals.size || !approvals.some((a) => a.requestId === decision.requestId))
        return;
      chatState.resolvingApprovals.add(decision.requestId);
      deps.composerError.set("");
      draw();
      let completed = false;
      try {
        await runApprovalTurn(new Agent({ initialState: { model: transcriptModel() } }), decision, undefined);
        completed = true;
      } catch (error) {
        if (current()) deps.composerError.set(errMessage(error, "Could not send the approval."));
      } finally {
        if (current()) {
          chatState.resolvingApprovals.delete(decision.requestId);
          await refreshApprovals();
          if (completed && current()) deps.onDelivery(s.threadRef);
        }
      }
    };

    deps.bindAgentLifecycle(agent, s.threadRef, normalStreamFn, onWork, {
      afterRefresh: () => void refreshApprovals(),
    });

    redrawFn = draw;
    sessionId = s.id;
    void refreshApprovals();
    draw();
    if (!priorHost) container.replaceChildren(host);
    if (!restoreScroll || followSend) deps.scrollToBottom();
    else restoreScroll();
    followSend = false;
    deps.ensureDeliveryStream();
    const runningSince = s.working ? s.workingSince : undefined;
    void deps.resumeTrackedRun(agent, s.threadRef, normalStreamFn, onWork, runningSince);
    deps.consumeBackgroundPanelRequest();
  }

  function mountPage(s: CoreSession, page: TranscriptPage): void {
    const split = inheritedTranscript(s, page.items);
    mount(
      s,
      itemsToMessages(split.current, transcriptModel()),
      currentEarlierCount(s, page.earlierItems ?? 0),
      page.items?.[0]?.seq ?? null,
      itemsToMessages(split.inherited, transcriptModel()),
    );
    deps.setPins(page.pins ?? []);
  }

  return {
    active: () => sessionId !== null,
    clear,
    redraw: () => redrawFn?.(),
    approve: (decision) => (approveFn ? approveFn(decision) : null),
    mount,
    mountPage,
  };
}
