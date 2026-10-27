import { approvalMarker } from "./tool-rows";
import { liveWorkSummary, timelineKey, usedToolsSuffix, workLabel } from "./work-summary";
import { activityGroupSummary, activityGroups, thinkingPresentation } from "./activity-presentation";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { markdown } from "./message-markdown";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { guard } from "lit/directives/guard.js";
import { Ban, BookOpen, Brain, ChevronRight, SquareTerminal as Terminal, Wrench } from "lucide";
import type { WorkBlock } from "./core-bridge";
import {
  messageWorkTimeline,
  workTimelineSegments,
  streamedAnswer,
  currentTextPhase,
  postSpeechText,
  type TimelineItem,
  type ToolRowModel,
} from "./timeline";
import { sheenLabel } from "./ui";
import { icon } from "./icons";
import { sessionsState } from "./sessions";
import { goalElapsedLabel } from "./goal-strip";
import { tip } from "./tooltip";
import { workSeconds } from "./work-duration";
import type { ConvCtx } from "./conv-types";
import type { ChatState } from "./chat-state";
import type { RunSlot } from "./run-stream";

export function shouldShowWork(work: WorkBlock | null | undefined, finalText: string): work is WorkBlock {
  return Boolean(work && (messageWorkTimeline(work, finalText).length || work.pendingApprovals?.length));
}

interface LiveWorkDeps {
  ctx: ConvCtx;
  chatState: ChatState;
  runSlot: RunSlot;
  drawActiveChat: () => void;
  chatMessage: (
    message: AgentMessage,
    index: number,
    isStreaming?: boolean,
    inline?: boolean,
  ) => TemplateResult | typeof nothing;
  inlineSteers: ReadonlyMap<number, { message: AgentMessage; index: number }>;
  toolRow: (row: ToolRowModel, work: WorkBlock, status: WorkBlock["status"], stale?: boolean) => TemplateResult;
}

class LiveWork {
  private liveWorkExpanded = false;
  private readonly openThinking = new Set<string>();
  private readonly deps: LiveWorkDeps;

  constructor(deps: LiveWorkDeps) {
    this.deps = deps;
  }

  readonly liveWorkStatus = (agent: Agent): TemplateResult | typeof nothing => {
    if (!agent.state.isStreaming && this.deps.chatState.resolvingApprovals.size === 0) return nothing;
    if (this.deps.runSlot.stopGeneration === this.deps.runSlot.generation)
      return html`<div class="stopped-head" role="status">${icon(Ban, 13)}<span>Stop requested</span></div>`;
    const work = this.deps.chatState.liveWork ?? { status: "thinking", activity: [] };
    if (work.status !== "thinking" && work.status !== "working") return nothing;
    if (currentTextPhase(work)?.phase === "final_answer" || shouldShowWork(work, "")) return nothing;
    const summary = liveWorkSummary(work);
    const expandable = Boolean(summary?.detail);
    const expanded = expandable && this.liveWorkExpanded;
    let title = "";
    if (expandable) title = this.liveWorkExpanded ? "Show less" : "Show more";
    return html`
      <section class="live-work-status ${expanded ? "expanded" : ""}" aria-live="polite">
        <button
          type="button"
          class="live-work-line ${expandable ? "" : "static"}"
          ?disabled=${!expandable}
          aria-expanded=${expandable ? String(this.liveWorkExpanded) : nothing}
          ${tip(title)}
          @click=${() => {
            this.liveWorkExpanded = !this.liveWorkExpanded;
            this.deps.drawActiveChat();
          }}
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
  };

  readonly workBlock = (
    work: WorkBlock,
    isStreaming: boolean,
    text: string,
    baseline: string,
    stopped = false,
  ): TemplateResult => {
    const active =
      isStreaming &&
      currentTextPhase(work)?.phase !== "final_answer" &&
      (work.status === "working" || work.status === "thinking");
    const segments = workTimelineSegments(messageWorkTimeline(work, active ? "" : text));
    return html`${segments.map((segment, index) => {
      const steer = segment[0];
      if (steer?.kind === "steer") return this.renderTimelineItem(steer, work);
      const last = index === segments.length - 1;
      const replies: string[] = [];
      const timeline = segment.filter((item) => {
        const speech = item.kind === "tool" ? postSpeechText(item.row) : null;
        if (speech === null) return true;
        replies.push(speech);
        return false;
      });
      const tail = active && last ? streamedAnswer(text, work) : "";
      const stopping = isStreaming && this.deps.runSlot.stopGeneration === this.deps.runSlot.generation;
      const animating = active && last && !stopping;
      let label = last ? workLabel(work) : "Worked";
      if (stopping && last) label = "Stop requested";
      if (stopped && last) label = `You stopped after ${goalElapsedLabel(0, workSeconds(work) * 1000)}`;
      if (
        timeline.length === 1 &&
        !tail.trim() &&
        !(last && (stopped || stopping || work.stale || work.pendingApprovals?.length))
      )
        return html`${this.renderTimelineItem(timeline[0]!, work)}${replies.map((reply) => html`<div class="streaming-text" dir="auto">${markdown(reply)}</div>`)}`;
      let fold =
        timeline.length || tail.trim() || (last && (active || work.pendingApprovals?.length))
          ? html`<details
              class=${stopped && last ? "stopped-work" : `work work-fold work-${work.status}`}
              ?open=${last && (active || !!work.pendingApprovals?.length)}
            >
              <summary class=${stopped && last ? "stopped-head" : "work-head"}>
                ${sheenLabel(label, animating)}<span class="activity-chevron">${icon(ChevronRight, 14)}</span>
              </summary>
              ${stopped && last ? nothing : html`<div class="work-divider"></div>`}
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
                  ],
                  () =>
                    repeat(
                      activityGroups(timeline),
                      (items) => timelineKey(items[0]!),
                      (items) => {
                        if (items.length === 1 || items[0]?.kind === "text")
                          return this.renderTimelineItem(items[0]!, work);
                        const summary = activityGroupSummary(items, work.status);
                        const groupIcon = { read: BookOpen, execute: Terminal, other: Wrench }[summary.category];
                        return html`<details
                          class="activity-group work-fold"
                          ?open=${(active && last) || summary.attention}
                        >
                          <summary class="work-head">
                            ${icon(groupIcon, 15)}<span>${summary.label}</span
                            ><span class="activity-chevron">${icon(ChevronRight, 14)}</span>
                          </summary>
                          <div class="work-rows">
                            ${repeat(items, timelineKey, (item) => this.renderTimelineItem(item, work))}
                          </div>
                        </details>`;
                      },
                    ),
                )}
                ${tail.trim() ? html`<div class="work-said streaming-text ${animating ? "live-stream" : ""}">${markdown(tail, animating, streamedAnswer(baseline, work))}</div>` : nothing}
              </div>
            </details>`
          : nothing;
      if (stopped && last && fold === nothing) fold = html`<div class="stopped-head">${label}</div>`;
      return html`${fold}${replies.map((reply) => html`<div class="streaming-text" dir="auto">${markdown(reply)}</div>`)}`;
    })}`;
  };

  readonly waitingSteerRows = (agent: Agent): TemplateResult[] => {
    return this.deps.ctx.composer.waitingSteers(agent).map(
      (q) =>
        html`<div class="inline-steer waiting-steer" aria-busy="true">
          ${this.deps.chatMessage(
            {
              role: "user",
              content: q.text || (q.hasAttachments ? "(files)" : ""),
              steered: true,
            } as unknown as AgentMessage,
            -1,
            false,
            true,
          )}
        </div>`,
    );
  };

  readonly renderTimelineItem = (item: TimelineItem, work: WorkBlock): TemplateResult => {
    const status = work.status;
    const stale = work.stale === true;
    if (item.kind === "steer") {
      const steer = this.deps.inlineSteers.get(item.item.seq);
      return html`<div class="inline-steer">
        ${steer ? this.deps.chatMessage(steer.message, steer.index, false, true) : nothing}
      </div>`;
    }
    if (item.kind === "thinking") {
      const thought = thinkingPresentation(item.text);
      const key = timelineKey(item);
      return html`<details
        class="thinking-row"
        ?open=${this.openThinking.has(key)}
        @toggle=${(event: Event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) this.openThinking.add(key);
          else this.openThinking.delete(key);
        }}
      >
        <summary class="thinking-summary">
          <span class="tool-icon">${icon(Brain, 15)}</span><span class="thinking-title">${thought.title}</span>
          <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
        </summary>
        <div class="thinking-body">${markdown(thought.body)}</div>
      </details>`;
    }
    if (item.kind === "text") return html`<div class="work-message">${markdown(item.item.text ?? "")}</div>`;
    if (item.kind === "approval") return approvalMarker(item.approval);
    return this.deps.toolRow(item.row, work, status, stale);
  };

  readonly resetThinking = () => this.openThinking.clear();
}

export function createLiveWork(deps: LiveWorkDeps) {
  const w = new LiveWork(deps);
  return {
    liveWorkStatus: w.liveWorkStatus,
    workBlock: w.workBlock,
    waitingSteerRows: w.waitingSteerRows,
    renderTimelineItem: w.renderTimelineItem,
    resetThinking: w.resetThinking,
  };
}
