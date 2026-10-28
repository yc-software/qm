import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { activityDescription, activityLabel, sessionPresentation, thinkingPresentation } from "./activity-presentation";
import type { WorkBlock } from "./core-bridge";
import { BookOpen, Bot, Brain, ChevronRight, MessageSquare, Search, type IconNode } from "lucide";
import { icon } from "./icons";
import { messageWorkTimeline, postSpeechText, type TimelineItem, type ToolPayload } from "./timeline";
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

export function currentStep(
  timeline: TimelineItem[],
  work: WorkBlock,
  toolMeta: (payload: ToolPayload) => { icon: IconNode; active: string },
): LiveStep | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "thinking") {
      const title = thinkingPresentation((item.activity.payload as { thinking?: string }).thinking ?? "").title;
      return { icon: Brain, label: title };
    }
    if (item.kind !== "tool") continue;
    const call = (item.row.call?.payload ?? {}) as ToolPayload;
    const result = (item.row.result?.payload ?? {}) as ToolPayload;
    const meta = toolMeta({ ...result, ...call });
    const posting = postSpeechText(item.row, true);
    if (posting) return { icon: MessageSquare, label: "Posting message" };
    const session = sessionPresentation(item.row, work.status);
    if (session) return { icon: Bot, label: [session.label, session.target].filter(Boolean).join(" ") };
    const category = activityDescription(call, result).category;
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
  let fadingTimer: ReturnType<typeof setTimeout> | null = null;
  let measuredWidth = 0;
  let measuredLabel: string | null = null;

  function reset(): void {
    liveStep = null;
    fadingStep = null;
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
    return html`<span class="work-step-slot"
        >${
          step && fadingStep
            ? html`<span class="work-step work-step-out" aria-hidden="true"
                ><span class="tool-icon">${icon(fadingStep.icon, 15)}</span>${fadingStep.label}</span
              >`
            : nothing
        }${keyed(
          label,
          html`<span class="work-step" data-step=${label} ${ref(step ? easeWidth : undefined)}
            >${step ? html`<span class="tool-icon">${icon(step.icon, 15)}</span>` : nothing}${sheenLabel(
              label,
              animating && !step,
            )}</span
          >`,
        )}</span
      >${elapsed ? html`<span class="work-elapsed">${elapsed}</span>` : nothing}<span class="activity-chevron"
        >${icon(ChevronRight, 14)}</span
      >`;
  }

  return { track, reset, line };
}
