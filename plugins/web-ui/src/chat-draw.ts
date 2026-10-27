import { pinnedStrip } from "./pinned-strip";
import { shouldShowWork } from "./live-work";
import { type MessageFields } from "./message-rows";
import { type UserAttachmentView } from "./chat-attachments";
import { SUBAGENT_MAIL_NOTES } from "./tool-rows";
import { liveWorkSummary } from "./work-summary";
import { assistantSidebar, messageRow, userBubble } from "./assistant-sidebar";
import { formatMessageTime } from "./message-time.ts";
import { messageEntrySeqs } from "./message-link.ts";
import { appEditSlug } from "./app-edit";
import { dismissGeneratedActivity } from "./generated-activities";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { markdown } from "./message-markdown";
import { html, nothing, render, type TemplateResult } from "lit";
import { Check, Copy, Files, GitFork, Link2, Maximize2, Pause, RefreshCw, Target, X, type IconNode } from "lucide";
import {
  messagesWithStreaming,
  forkOriginDetails,
  forkCutSeq,
  inheritedTranscript,
  type AssistantWork,
  type HistorySystemNote,
  type HistoryApprovalDecision,
} from "./transcript-messages";
import { type SessionPin, api, forkSession, unresolvedApprovals, type TurnRuntime } from "./core-bridge";
import { messageWorkTimeline, currentTextPhase } from "./timeline";
import { activityItems, type Item } from "./items";
import { sessionLink, UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { attachmentGallery, brandMark, browserRenderableImage, copyText, waveLoader } from "./ui";
import { icon } from "./icons";
import { appState, switchView } from "./shell";
import { contextsState, scopeTitle } from "./contexts";
import { openProjectPage, scopeToolCount, sessionTopbarTpl, setScopedSession } from "./session-scope";
import { addPendingSession, dropPendingSession, replacePendingSession, renderList, sessionsState } from "./sessions";
import { goalObjectiveLabel, goalWorkedLabel, type GoalStripState } from "./goal-strip";
import { forkOriginView } from "./fork-origin";
import { tip } from "./tooltip";
import { goalWorked } from "./work-duration";
import { decorateTextCodeBlocks } from "./text-code";
import { suggestedActivities } from "./suggested-activities";
import { reportHandledError } from "./browser-errors.ts";
import { uiCanvasPanel } from "./ui-canvas";
import { type ChatCore, toMessages } from "./chat-core";
import {
  openSessionById,
  setChat,
  mountContinuable,
  adoptActiveSessionFromList,
  postCurrentPaneState,
  loadEarlierMessages,
} from "./chat-mount";
import { activePendingApprovals, cancelGoal } from "./chat-runs";

const CHAT_CTAS = [
  "What can I help with?",
  "Ahoy, what are we after?",
  "What are we charting today?",
  "Where shall we set sail?",
  "What's the heading, captain?",
];

const CTA_INDEX_KEY = "web-ui:chat-cta";

const APPROVED_LABELS: Record<string, string> = {
  once: "Approved once",
  session: "Approved for this session",
  always: "Approved always",
};

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

const settledRowCache = new WeakMap<object, { key: unknown[]; tpl: TemplateResult | typeof nothing }>();

export function drawActiveChat(c: ChatCore, agent = c.state.agent, opts: { forceScroll?: boolean } = {}): void {
  if (!agent || agent !== c.state.agent || !c.state.host || (!c.ctx.inbox && appState.currentView !== "chats")) return;
  for (const message of agent.state.messages) {
    const work = (message as AssistantWork).work;
    if (work?.pendingApprovals) work.pendingApprovals = unresolvedApprovals(work.pendingApprovals);
  }
  adoptActiveSessionFromList(c, agent);
  if (!c.ctx.visible()) {
    postCurrentPaneState(c);
    return;
  }
  c.transcriptViewport.beforeRender();
  const currentMessages = messagesWithStreaming(agent.state.messages, agent.state.streamingMessage);
  if (c.preserveConnectionScroll) {
    c.connectionReturnMessageCount ??= currentMessages.length;
    if (c.connectionReturnMessageCount !== currentMessages.length) c.preserveConnectionScroll = false;
  }
  const messages = c.state.inheritedExpanded ? [...c.state.inheritedMessages, ...currentMessages] : currentMessages;
  c.prepareMessageRows(messages);
  const isNewUser = sessionsState.list.filter((s) => s.id).length === 0;
  const editingApp = appEditSlug(c.state.threadRef, appState.me?.user);
  const inheritedOffset = c.state.inheritedExpanded ? c.state.inheritedMessages.length : 0;
  const messageContent = messages.map((m, i) =>
    settledChatMessage(c, m, i - inheritedOffset, agent.state.isStreaming && m === agent.state.streamingMessage),
  );
  const tier = c.ctx.density();
  const glanceTier = tier === "card" || tier === "strip" ? tier : null;
  const emptyChat = !messages.length && !c.state.forkSession;
  const showSuggestions =
    !c.ctx.inbox &&
    emptyChat &&
    !editingApp &&
    !glanceTier &&
    (!c.ctx.pane || tier === "full") &&
    !c.state.sessionId &&
    (c.state.scopeId === null || c.state.scopeId === `personal:${appState.me?.user}`) &&
    !agent.state.isStreaming;
  const me = appState.me;
  const redrawSuggestions = () => {
    if (appState.me === me && !c.state.sessionId) drawActiveChat(c);
  };
  const suggestions = showSuggestions
    ? suggestedActivities(me?.suggestedActivities, {
        onSelect: (activity) => c.ctx.composer.fillSuggestedPrompt(activity.prompt, agent),
        ...(me?.suggestedActivitiesGeneration
          ? { onDismiss: (activity) => dismissGeneratedActivity(me, activity, redrawSuggestions) }
          : {}),
        redraw: redrawSuggestions,
        collapsed: Boolean(
          c.ctx.composer.state.draft || c.ctx.composer.state.attachments.length || c.ctx.composer.state.processingFiles,
        ),
      })
    : nothing;
  const dropOverlay = c.ctx.composer.state.dragging
    ? html`<div class="drop-overlay">
        <div class="drop-overlay-card">${icon(Files, 30)}<span>Drop files or folders to attach</span></div>
      </div>`
    : nothing;
  let content: TemplateResult;
  if (c.ctx.inbox) {
    content = assistantSidebar({
      context: c.ctx.inbox.context(),
      messages: html`${pinnedStrip(c.state.pins, c.state.pinsExpanded, (e: Event) => togglePins(c, e))}
      ${inheritedHeader(c)} ${c.state.earlierCount > 0 ? earlierNotice(c) : nothing} ${messageContent}
      ${c.waitingSteerRows(agent)}
      ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}`,
      status: c.liveWorkStatus(agent),
      busy: agent.state.isStreaming,
      showPrompts: !messages.length,
      toolbar: html`${goalStrip(c, agent)} ${c.ctx.composer.queuedStrip(agent)} ${c.subagentStrip()}
      ${c.backgroundActivityStrip()}`,
      composer: c.ctx.composer.composerForm(agent),
      onPrompt: (prompt) => c.ctx.composer.fillSuggestedPrompt(prompt, agent),
      onDragEnter: (event) => c.ctx.composer.onDragEnter(event),
      onDragOver: (event) => c.ctx.composer.onDragOver(event),
      onDragLeave: (event) => c.ctx.composer.onDragLeave(event),
      onDrop: (event) => void c.ctx.composer.onDrop(event, agent),
      overlay: dropOverlay,
    });
  } else {
    content = html`
      <div
        class="custom-chat-shell ${editingApp ? "app-edit-chat" : ""} ${c.ctx.pane ? "in-pane" : ""} ${c.ctx.composer.state.dragging ? "dragging" : ""} ${
          emptyChat && !glanceTier && !editingApp ? "empty-chat" : ""
        }"
        @dragenter=${(e: DragEvent) => c.ctx.composer.onDragEnter(e)}
        @dragover=${(e: DragEvent) => c.ctx.composer.onDragOver(e)}
        @dragleave=${(e: DragEvent) => c.ctx.composer.onDragLeave(e)}
        @drop=${(e: DragEvent) => void c.ctx.composer.onDrop(e, agent)}
      >
        ${dropOverlay} ${uiCanvasPanel(c.ctx)} ${glanceTier || c.ctx.pane || editingApp ? nothing : sessionTopbar(c)}
        ${glanceTier ? paneGlance(c, agent, messages, glanceTier) : nothing}
        <section class="chat-scroll" tabindex="0" aria-label="Conversation">
          ${pinnedStrip(c.state.pins, c.state.pinsExpanded, (e: Event) => togglePins(c, e))}
          <div class="message-stack ${emptyChat ? "empty-stack" : ""}">
            ${inheritedHeader(c)} ${c.state.earlierCount > 0 ? earlierNotice(c) : nothing} ${messageContent}
            ${c.waitingSteerRows(agent)} ${glanceTier ? nothing : c.liveWorkStatus(agent)}
            ${emptyChat && !isNewUser && !editingApp ? html`<h1 class="chat-cta">${chatCta(c)}</h1>` : nothing}
            ${c.ctx.pane ? suggestions : nothing}
            ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}
          </div>
        </section>
        <div class="chat-bottom-dock">
          ${goalStrip(c, agent)} ${c.ctx.composer.queuedStrip(agent)} ${c.subagentStrip()}
          ${c.backgroundActivityStrip()} ${c.ctx.composer.composerForm(agent)} ${c.ctx.pane ? nothing : suggestions}
        </div>
      </div>
    `;
  }
  render(content, c.state.host);
  c.transcriptViewport.afterRender();
  const host = c.state.host;
  requestAnimationFrame(() => {
    if (c.state.host !== host || c.state.agent !== agent || !host.isConnected) return;
    decorateTextCodeBlocks(host);
    c.ctx.composer.resizeComposer();
    scrollTranscript(c, opts.forceScroll);
  });
  postCurrentPaneState(c);
}

function paneGlance(c: ChatCore, agent: Agent, messages: AgentMessage[], tier: "card" | "strip"): TemplateResult {
  const now = paneNowLine(c, agent);
  const last = [...messages].reverse().find((m) => m.role === "assistant" && messageText(m).trim());
  const snippet = last ? messageText(last).trim() : "";
  if (tier === "strip") {
    return html`
      <button type="button" class="pane-strip" ${tip("Expand this pane")} @click=${() => c.ctx.onExpand?.()}>
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

function paneNowLine(c: ChatCore, agent: Agent): string | null {
  if (activePendingApprovals(c).length) return "Needs your approval";
  if (agent.state.isStreaming || c.state.resolvingApprovals.size > 0) {
    const work = c.state.liveWork ?? { status: "thinking", activity: [] };
    if (c.runSlot.stopGeneration === c.runSlot.generation) return "Stop requested";
    if (currentTextPhase(work)?.phase === "final_answer") return "Responding…";
    const summary = liveWorkSummary(work);
    if (!summary) return "Thinking…";
    return summary.detail ? `${summary.label}: ${summary.detail}` : summary.label;
  }
  return null;
}

function sessionTopbar(c: ChatCore): TemplateResult {
  const scope = c.state.scopeId;
  const session = sessionsState.list.find((s) =>
    c.state.sessionId ? s.id === c.state.sessionId : Boolean(c.state.threadRef) && s.threadRef === c.state.threadRef,
  );
  const currentSession = session ?? c.state.forkSession;
  const parentId = currentSession?.parentSessionId;
  const parent = parentId ? sessionsState.list.find((row) => row.id === parentId) : undefined;
  const title = currentSession?.title?.trim() ?? "";
  const crumb = scope && !scope.startsWith("personal:") ? scopeTitle(scope, c.state.contextName) : null;
  const forkedFrom =
    c.state.forkSession && c.state.sessionId === c.state.forkSession.id ? c.state.forkSession.forkedFrom : undefined;
  return sessionTopbarTpl({
    sessionId: c.state.sessionId ?? session?.id,
    crumb,
    title,
    parent: parentId
      ? { title: parent?.title?.trim() || "Parent session", onClick: () => void openSessionById(c, parentId) }
      : null,
    fork: forkedFrom
      ? {
          title: forkedFrom.title?.trim() || "another conversation",
          onClick: () => void c.forkOriginController.navigate(),
        }
      : null,
    onCrumb: crumb && scope ? () => openProjectPage(scope) : null,
    toolCount: scope ? (t) => scopeToolCount(t, scope, () => drawActiveChat(c)) : null,
    onTool: (tool) => {
      setScopedSession({
        scopeId: scope ?? "",
        sessionId: c.state.sessionId,
        threadRef: c.state.threadRef,
        title: title || "New chat",
        crumb,
      });
      if (scope && (tool === "crons" || tool === "files" || tool === "apps")) contextsState.selected = scope;
      switchView(tool === "apps" ? "deploys" : tool);
    },
  });
}

function goalStrip(c: ChatCore, agent: Agent): TemplateResult | typeof nothing {
  const messages = messagesWithStreaming(agent.state.messages, agent.state.streamingMessage);
  const goal = currentGoal(c);
  if (!goal) return nothing;
  const cancel = c.goalCancels.get(`${c.state.sessionId}:${goal.createdAt}`);
  if (cancel === "done") return nothing;
  const { workedMs, paused: stopped } = goalWorked(messages, goal);
  const paused = goal.status === "paused" || (goal.status === "active" && stopped);
  if (goal.status !== "active" && !paused) return nothing;
  let title = "Goal";
  if (paused) title = "Goal paused";
  else if (agent.state.isStreaming) title = "Pursuing goal";
  return html`
    <section class="goal-strip ${paused ? "paused" : ""}" aria-live="polite" title=${goal.objective}>
      <span class="goal-strip-icon">${icon(paused ? Pause : Target, 13)}</span>
      <span class="goal-strip-title">${title}</span>
      <span class="goal-strip-objective" dir="auto">${goalObjectiveLabel(goal.objective)}</span>
      <span class="goal-strip-meta">${goalWorkedLabel(workedMs, goal.floor)}</span>
      <button
        type="button"
        class="chip-x"
        aria-label="Cancel goal"
        ${tip("Cancel goal")}
        ?disabled=${cancel === "pending"}
        @click=${() => void cancelGoal(c, agent, goal)}
      >
        ${icon(X, 13)}
      </button>
    </section>
  `;
}

function chatCta(c: ChatCore): string {
  if (c.state.threadRef !== c.ctaThreadRef) {
    c.ctaThreadRef = c.state.threadRef;
    c.ctaText = nextChatCta();
  }
  return c.ctaText;
}

export function earlierNotice(c: ChatCore, load: () => Promise<void> = () => loadEarlierMessages(c)): TemplateResult {
  return html`<div class="earlier-messages">
    <button class="earlier-messages-btn" ?disabled=${c.state.loadingEarlier} @click=${() => void load()}>
      ${c.state.loadingEarlier ? "Loading earlier messages…" : "Show earlier messages"}
    </button>
  </div>`;
}

export function inheritedHeader(c: ChatCore): TemplateResult | typeof nothing {
  const origin = c.state.forkSession
    ? forkOriginDetails(c.state.forkSession, c.state.inheritedLoaded ? c.state.inheritedMessages.length : 0)
    : null;
  return forkOriginView(
    origin
      ? {
          title: origin.title,
          messageCount: origin.messageCount,
          expanded: c.state.inheritedExpanded,
          icon: icon(GitFork, 14),
          navigate: () => void c.forkOriginController.navigate(),
          toggle: () =>
            void c.forkOriginController
              .toggle()
              .catch((error: unknown) => reportHandledError("web:fork_origin", error)),
        }
      : null,
  );
}

export function scheduleStreamDraw(c: ChatCore, agent: Agent): void {
  const scheduled = c.streamDrawAgent !== null;
  c.streamDrawAgent = agent;
  if (scheduled) return;
  requestAnimationFrame(() => {
    const target = c.streamDrawAgent;
    c.streamDrawAgent = null;
    if (target) drawActiveChat(c, target);
  });
}

export function syncWorkTicker(c: ChatCore): void {
  const goalTicking = Boolean(c.state.agent?.state.isStreaming && currentGoal(c)?.status === "active");
  const active =
    (c.state.liveWork?.status === "working" && !c.state.liveWork.stale) || goalTicking || c.subagentsTicking();
  if (active && !c.workTicker) {
    c.workTicker = setInterval(() => drawActiveChat(c), 1000);
  } else if (!active && c.workTicker) {
    clearInterval(c.workTicker);
    c.workTicker = null;
  }
}

function currentGoal(c: ChatCore): GoalStripState | null {
  return c.state.liveWork?.goal ?? c.state.goal;
}

export function redrawTranscript(c: ChatCore): void {
  if (c.readonlyRedraw) c.readonlyRedraw();
  else drawActiveChat(c);
}

export function scrollTranscript(c: ChatCore, force = false): void {
  if (c.preserveConnectionScroll) {
    c.transcriptViewport.sync(null);
    return;
  }
  c.transcriptViewport.sync(c.ctx.container()?.querySelector<HTMLElement>(".chat-scroll") ?? null);
  c.transcriptViewport.follow(force);
}

export function togglePins(c: ChatCore, e: Event): void {
  if ((e.target as Element | null)?.closest("a")) return;
  c.state.pinsExpanded = !c.state.pinsExpanded;
  redrawTranscript(c);
}

export function setTurnRuntime(c: ChatCore, turnRuntime: TurnRuntime | null): void {
  setChat(c, { turnRuntime });
  drawActiveChat(c);
}

export function setGoal(c: ChatCore, goal: GoalStripState | null): void {
  setChat(c, { goal });
  drawActiveChat(c);
}

export function setPins(c: ChatCore, pins: SessionPin[]): void {
  setChat(c, { pins });
  redrawTranscript(c);
}

function settledChatMessage(
  c: ChatCore,
  message: AgentMessage,
  index: number,
  isStreaming: boolean,
): TemplateResult | typeof nothing {
  const msg = message as AssistantWork & MessageFields;
  if (msg.steered) return nothing;
  const work = msg.work;
  const cacheable =
    !isStreaming &&
    !msg.subagentMail &&
    !activityItems(work?.activity ?? []).some(
      (item) => item.kind === "SteeringMessage" || ["session", "sessions", "subagents"].includes(item.tool ?? ""),
    ) &&
    (!work || ((work.status === "complete" || work.status === "failed") && !work.pendingApprovals?.length));
  if (!cacheable) return chatMessage(c, message, index, isStreaming);
  const forkable = Boolean(c.state.threadRef && c.state.sessionId && c.state.agent);
  const forking = c.pendingFork !== null;
  const speaker = c.speakerLabelFor(message);
  const speakerLabel =
    message.role === "assistant" && c.state.labelSpeakers
      ? c.state.assistantSpeakerLabel
      : speaker && `${speaker}\n${c.speakerMember(message)?.avatarUrl ?? ""}`;
  const key = [
    new Date().toDateString(),
    index,
    work?.activity,
    work?.status,
    work?.stale,
    msg.deliveredFiles,
    msg.stopReason,
    msg.errorMessage,
    msg.sendFailure,
    forkable,
    forking,
    speakerLabel,
    Boolean(msg.edited),
    Boolean(msg.deleted),
  ];
  const hit = settledRowCache.get(message as object);
  if (hit?.key.every((value, i) => value === key[i])) return hit.tpl;
  const tpl = chatMessage(c, message, index, isStreaming);
  settledRowCache.set(message as object, { key, tpl });
  return tpl;
}

export function chatMessage(
  c: ChatCore,
  message: AgentMessage,
  index: number,
  isStreaming = false,
  inline = false,
): TemplateResult | typeof nothing {
  const m = message as MessageFields;
  if (m.opener || m.resumeAnchor || (!inline && m.steered)) return nothing;
  const seqs = messageEntrySeqs(message);
  if (m.role === "user" || m.role === "user-with-attachments") {
    const mail = m.subagentMail;
    if (mail)
      return messageRow(
        "subagent-mail-row",
        index,
        seqs,
        html`${c.subagentChip(mail.title, mail.sessionId)}
          <span class="subagent-mail-note">${SUBAGENT_MAIL_NOTES[mail.kind] ?? mail.kind.replace(/_/g, " ")}</span>`,
      );
    const text = messageText(message);
    const speaker = c.speakerLabelFor(message);
    let revision = m.edited ? "edited" : "";
    if (m.deleted) revision = "deleted";
    const attachments = ((message as UserMessageWithAttachments).attachments ?? []) as UserAttachmentView[];
    const before = html`${c.speakerLabelTpl(speaker, message)}${attachmentGallery(attachments, (attachment) => browserRenderableImage(attachment.mimeType), c.userAttachmentBadge)}`;
    const failure = m.sendFailure
      ? html`<div class="send-failure">
          <span>${m.sendFailure}</span>
          <button class="btn compact" type="button" @click=${() => void retryFailedSend(c, message, index)}>
            ${icon(RefreshCw, 12)} Retry
          </button>
        </div>`
      : nothing;
    return messageRow(
      `user-row ${speaker ? "named-user-row" : ""} ${m.steered ? "steered-row" : ""}`,
      index,
      seqs,
      html`${before}
      ${userBubble(c.isReadOnlySlackView() ? c.slackWireBubble(text) : markdown(text), {
        hidden: !text.trim() && !revision,
        deleted: m.deleted,
        revision,
      })}
      ${failure} ${messageMeta(c, message, index)}`,
    );
  }
  if (m.role === "approval-decision") {
    const decision = message as unknown as HistoryApprovalDecision;
    const label = decision.approved ? (APPROVED_LABELS[decision.scope ?? "once"] ?? "Approved") : "Approval denied";
    return messageRow(
      "system-note-row",
      index,
      seqs,
      html`<div class="system-note approval-decision">
        ${label}<code class="approval-cmd approval-cmd-full">${decision.command}</code>
      </div>`,
    );
  }
  if (m.role === "system-note") {
    const note = message as unknown as HistorySystemNote;
    let body = html`Goal cancelled: <span class="system-note-text">${goalObjectiveLabel(note.content)}</span>`;
    if (note.note !== "goal_cancelled")
      body =
        note.action === "deleted"
          ? html`${note.speaker ?? "The user"} deleted their message`
          : html`${note.speaker ?? "The user"} edited their message:
              <span class="system-note-text">${note.content}</span>`;
    return messageRow("system-note-row", index, seqs, html`<div class="system-note">${body}</div>`);
  }
  if (m.role !== "assistant") return nothing;
  const msg = message as AssistantWork;
  if (msg.retryableSend) return nothing;
  const work = msg.work;
  const stoppedEarly = msg.stopReason === "error" || msg.stopReason === "aborted";
  const text = c.assistantDisplayText(messageText(msg), msg.stopReason).trim();
  const showWork = shouldShowWork(work, isStreaming || stoppedEarly ? "" : text);
  const steeringOnly = !showWork && work ? messageWorkTimeline(work, text).filter((item) => item.kind === "steer") : [];
  let workView: TemplateResult | typeof nothing =
    work && steeringOnly.length ? html`${steeringOnly.map((item) => c.renderTimelineItem(item, work))}` : nothing;
  if (showWork) {
    const workText = isStreaming ? messageText(msg) : text;
    workView = c.workBlock(work, isStreaming, stoppedEarly ? "" : workText, msg.streamingBaseline ?? "");
  }
  if (msg.stopReason === "aborted")
    workView = work ? c.workBlock(work, false, "", "", true) : html`<div class="stopped-head">You stopped</div>`;
  const hasVisibleContent =
    showWork ||
    steeringOnly.length > 0 ||
    Boolean(text) ||
    Boolean(msg.deliveredFiles?.length) ||
    msg.content.some((chunk) => chunk.type === "thinking" && chunk.thinking.trim());
  if (!hasVisibleContent && !stoppedEarly) return nothing;
  const shownSeqs = seqs.filter((seq) => !c.inlineSteers.has(seq));
  const body = html`${workView} ${c.assistantContent(msg, isStreaming, showWork)}
  ${c.assistantFileList(msg.deliveredFiles)}
  ${msg.stopReason === "error" && msg.errorMessage ? html`<div class="composer-error inline">${msg.errorMessage}</div>` : nothing}`;
  const meta = isStreaming ? nothing : messageMeta(c, msg, index);
  return messageRow(
    `assistant-row ${c.state.labelSpeakers ? "named-assistant-row" : ""} ${isStreaming ? "streaming" : ""}`,
    index,
    shownSeqs,
    html`${
        c.state.labelSpeakers
          ? html`<div class="speaker-label">${brandMark()}<span>${c.state.assistantSpeakerLabel}</span></div>`
          : nothing
      }
      <div class="assistant-body">${body} ${meta}</div>`,
  );
}

function copyableText(c: ChatCore, message: AgentMessage): string {
  const raw =
    message.role === "assistant"
      ? c.assistantDisplayText(messageText(message), (message as AssistantMessage).stopReason)
      : messageText(message);
  if (!c.isReadOnlySlackView()) return raw;
  const role = (message as MessageFields).role;
  return role === "user" || role === "user-with-attachments" ? slackWireToPlain(raw) : stripSlackDirectives(raw);
}

function messageMeta(c: ChatCore, message: AgentMessage, index: number): TemplateResult | typeof nothing {
  const text = copyableText(c, message).trim();
  const ts = (message as MessageFields).timestamp;
  if (!text && ts === undefined) return nothing;
  const forkable = Boolean(index >= 0 && c.state.threadRef && c.state.sessionId && c.state.agent);
  const seqs = messageEntrySeqs(message);
  return html`
    <div class="message-meta">
      ${ts !== undefined ? html`<span class="message-time">${formatMessageTime(ts)}</span>` : nothing}
      ${text ? copyButton("Copy", "Copy message", Copy, () => text) : nothing}
      ${
        c.state.sessionId && seqs.length
          ? copyButton("Copy message link", "Copy message link", Link2, () =>
              sessionLink(location.origin, UI_BASE, c.state.sessionId!, seqs[0]),
            )
          : nothing
      }
      ${
        forkable
          ? html`<button
              class="msg-copy msg-fork"
              type="button"
              ${tip(c.pendingFork ? "Forking..." : "Fork conversation from here")}
              aria-label=${c.pendingFork?.index === index ? "Forking conversation…" : "Fork conversation from here"}
              ?disabled=${c.pendingFork !== null}
              aria-busy=${c.pendingFork?.index === index ? "true" : "false"}
              @click=${() => void forkFromMessage(c, index)}
            >
              ${c.pendingFork?.index === index ? waveLoader({ width: 13, height: 13, label: "Forking" }) : icon(GitFork, 13)}
            </button>`
          : nothing
      }
    </div>
  `;
}

function copyButton(tipText: string, label: string, glyph: IconNode, text: () => string): TemplateResult {
  return html`<button
    class="msg-copy"
    type="button"
    ${tip(tipText)}
    aria-label=${label}
    @click=${(e: Event) => void copyText(text(), e.currentTarget as HTMLButtonElement)}
  >
    ${icon(glyph, 13)}${icon(Check, 13)}
  </button>`;
}

async function forkFromMessage(c: ChatCore, index: number): Promise<void> {
  const agent = c.state.agent;
  const sessionId = c.state.sessionId;
  const sourceThreadRef = c.state.threadRef;
  if (!agent || !sessionId || c.pendingFork) return;
  const messages = agent.state.messages;
  if (!messages[index]) return;
  const floorSeq = Math.max(c.state.forkSession?.forkBoundarySeq ?? -1, (c.state.transcriptAnchorSeq ?? 0) - 1);
  const pendingRef = `web:fork:${crypto.randomUUID()}`;
  c.pendingFork = { index };
  c.ctx.composer.state.error = "";
  addPendingSession(pendingRef, c.state.scopeId, c.state.contextName, true);
  if (c.state.scopeId) sessionsState.collapsedProjectScopes.delete(c.state.scopeId);
  renderList();
  drawActiveChat(c);
  try {
    const { items } = await api<{ items: Item[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const upToSeq = forkCutSeq(items ?? [], messages, index, floorSeq);
    if (upToSeq === undefined) throw new Error("That message is still saving. Try forking again in a moment.");
    const forked = await forkSession(sessionId, upToSeq);
    replacePendingSession(pendingRef, forked.session);
    if (c.state.agent !== agent || c.state.sessionId !== sessionId) return;
    const split = inheritedTranscript(forked.session, forked.items ?? []);
    c.ctx.composer.carryModelPick(sourceThreadRef, forked.session.threadRef);
    mountContinuable(
      c,
      forked.session.threadRef,
      forked.session.id,
      forked.session.scopeId,
      toMessages(split.current),
      forked.session.channelName ?? null,
      forked.session,
      toMessages(split.inherited),
    );
    renderList();
  } catch (err) {
    c.ctx.composer.state.error = errMessage(err, "Could not fork the conversation.");
  } finally {
    c.pendingFork = null;
    dropPendingSession(pendingRef);
    drawActiveChat(c);
  }
}

export function messageText(message: AgentMessage): string {
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

async function retryFailedSend(c: ChatCore, message: AgentMessage, index: number): Promise<void> {
  const agent = c.state.agent;
  if (!agent || agent.state.isStreaming || agent.state.messages[index] !== message) return;
  const failed = message as MessageFields;
  const error = agent.state.messages[index + 1] as AssistantWork | undefined;
  if (!failed.sendFailure || !error?.retryableSend) return;
  delete failed.sendFailure;
  agent.state.messages = agent.state.messages.filter((_, current) => current !== index + 1);
  c.ctx.composer.state.error = "";
  drawActiveChat(c, agent);
  try {
    await agent.continue();
  } catch (err) {
    if (agent === c.state.agent) c.ctx.composer.state.error = errMessage(err, "Could not retry the message.");
  }
}
