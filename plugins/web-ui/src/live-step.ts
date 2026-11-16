import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { activityDescription, activityLabel, sessionPresentation, thinkingPresentation } from "./activity-presentation";
import type { WorkBlock } from "./core-bridge";
import { BookOpen, Bot, Brain, ChevronRight, MessageSquare, RefreshCw, RotateCcw, Search, type IconNode } from "lucide";
import { icon } from "./icons";
import { proddedReason, retractedReason } from "./items";
import { messageWorkTimeline, postSpeechText, rowArgs, rowTool, type TimelineItem, type ToolPayload } from "./timeline";
import { sheenLabel } from "./ui";

export interface LiveStep {
  icon: IconNode;
  label: string;
}

const STEP_FADE_MS = 420;

export function preStepWork(work: WorkBlock | null | undefined): work is WorkBlock {
  return Boolean(
    work &&
    (work.status === "thinking" || work.status === "working") &&
    !work.stale &&
    !work.pendingApprovals?.length &&
    messageWorkTimeline(work, "").length === 0,
  );
}

export function checkedReplyStep(item: TimelineItem | undefined): LiveStep | null {
  if (item?.kind !== "text") return null;
  const retracted = retractedReason(item.item);
  if (retracted) return { icon: RotateCcw, label: `Retrying: ${retracted}` };
  const prodded = proddedReason(item.item);
  return prodded ? { icon: RefreshCw, label: `Continuing: ${prodded}` } : null;
}

export function currentStep(
  timeline: TimelineItem[],
  work: WorkBlock,
  toolMeta: (tool: string | null, payload: ToolPayload) => { icon: IconNode; active: string },
): LiveStep | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "thinking") {
      const title = thinkingPresentation(item.text, true).title;
      return { icon: Brain, label: title };
    }
    if (item.kind !== "tool") continue;
    const meta = toolMeta(rowTool(item.row), rowArgs(item.row));
    const posting = postSpeechText(item.row, true);
    if (posting) return { icon: MessageSquare, label: "Posting message" };
    const session = sessionPresentation(item.row, work.status);
    if (session) return { icon: Bot, label: [session.label, session.target].filter(Boolean).join(" ") };
    const category = activityDescription(item.row).category;
    const stepIcon = { search: Search, read: BookOpen, execute: meta.icon, other: meta.icon }[category];
    const inFlight = item.row.result ? { ...item.row, result: null } : item.row;
    return { icon: stepIcon, label: activityLabel(inFlight, work.status) ?? meta.active };
  }
  return null;
}

export interface LiveStepLine {
  track(step: LiveStep | null): void;
  reset(): void;
  line(step: LiveStep | null, label: string, animating: boolean, elapsed: string | DirectiveResult): TemplateResult;
}

export function createLiveStepLine(redraw: () => void): LiveStepLine {
  let liveStep: LiveStep | null = null;
  let fadingStep: LiveStep | null = null;
  let iconEntry: "fade" | "roll" | "still" = "fade";
  let fadingTimer: ReturnType<typeof setTimeout> | null = null;
  let measuredWidth = 0;
  let measuredLabel: string | null = null;

  function reset(): void {
    liveStep = null;
    fadingStep = null;
    iconEntry = "fade";
    measuredWidth = 0;
    measuredLabel = null;
    if (fadingTimer) clearTimeout(fadingTimer);
    fadingTimer = null;
  }

  function track(step: LiveStep | null): void {
    if (!step) {
      reset();
      return;
    }
    if (liveStep && liveStep.label !== step.label) {
      fadingStep = liveStep;
      iconEntry = liveStep.icon === step.icon ? "still" : "roll";
      if (fadingTimer) clearTimeout(fadingTimer);
      fadingTimer = setTimeout(() => {
        fadingStep = null;
        fadingTimer = null;
        redraw();
      }, STEP_FADE_MS);
    }
    liveStep = step;
  }

  const easeWidth = (el?: Element, deferred = false): void => {
    if (!(el instanceof HTMLElement)) return;
    if (!el.isConnected) {
      if (!deferred) queueMicrotask(() => easeWidth(el, true));
      return;
    }
    if (!el.parentElement) return;
    const width = el.getBoundingClientRect().width;
    const label = el.dataset.step ?? "";
    const from = measuredWidth;
    const fromLabel = measuredLabel;
    measuredWidth = width;
    measuredLabel = label;
    if (fromLabel === null || fromLabel === label) return;
    if (!from || !width || Math.abs(from - width) < 0.5) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.parentElement.animate?.([{ width: `${from}px` }, { width: `${width}px` }], {
      duration: STEP_FADE_MS,
      easing: "ease-out",
    });
  };

  function line(
    step: LiveStep | null,
    label: string,
    animating: boolean,
    elapsed: string | DirectiveResult,
  ): TemplateResult {
    const out = step && fadingStep ? fadingStep : null;
    const outIcon = out && iconEntry === "roll" ? out : null;
    return html`<span class="work-step-slot"
        >${keyed(
          label,
          html`<span
            class="work-step ${step ? `work-step-enter-${iconEntry}` : ""}"
            data-step=${label}
            ${ref(step ? easeWidth : undefined)}
            >${
              step
                ? html`<span class="work-step-icon"
                    >${
                      outIcon
                        ? html`<span class="tool-icon work-step-out" aria-hidden="true"
                            >${icon(outIcon.icon, 15)}</span
                          >`
                        : nothing
                    }<span class="tool-icon">${icon(step.icon, 15)}</span></span
                  >`
                : nothing
            }<span class="work-step-label"
              >${
                out ? html`<span class="work-step-out" aria-hidden="true">${out.label}</span>` : nothing
              }${sheenLabel(label, animating)}</span
            ></span
          >`,
        )}</span
      >${elapsed ? html`<span class="work-elapsed">${elapsed}</span>` : nothing}<span class="activity-chevron"
        >${icon(ChevronRight, 14)}</span
      >`;
  }

  return { track, reset, line };
}
