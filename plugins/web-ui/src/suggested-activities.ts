import { html, nothing, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { repeat } from "lit/directives/repeat.js";
import { X } from "lucide";
import { icon } from "./icons";
import type { SuggestedActivity } from "../../chassis/src/suggested-activities.ts";

const icons: Record<string, string> = {
  schedule: "⏰",
  app: "🛠️",
  deck: "📊",
  people: "👥",
  calendar: "📅",
  book: "📚",
};

const VISIBLE_COUNT = 3;
const MOTION_MS = 220;

type Motion = "" | "is-entering" | "is-leaving";

class SuggestionRows extends Directive {
  private shown: SuggestedActivity[] | null = null;
  private readonly leaving = new Map<string, { activity: SuggestedActivity; index: number }>();
  private readonly entering = new Set<string>();

  render(
    visible: SuggestedActivity[],
    row: (activity: SuggestedActivity, motion: Motion) => TemplateResult,
    redraw: () => void,
  ) {
    const ids = new Set(visible.map((activity) => activity.id));
    for (const id of this.leaving.keys()) if (ids.has(id)) this.leaving.delete(id);
    if (this.shown) {
      const previous = new Set(this.shown.map((activity) => activity.id));
      this.shown.forEach((activity, index) => {
        if (ids.has(activity.id) || this.leaving.has(activity.id)) return;
        this.entering.delete(activity.id);
        this.leaving.set(activity.id, { activity, index });
        setTimeout(() => {
          if (this.leaving.get(activity.id)?.activity !== activity) return;
          this.leaving.delete(activity.id);
          redraw();
        }, MOTION_MS);
      });
      for (const id of ids) if (!previous.has(id)) this.entering.add(id);
    }
    this.shown = visible;
    const rows = [...visible];
    for (const { activity, index } of [...this.leaving.values()].sort((a, b) => a.index - b.index)) {
      rows.splice(Math.min(index, rows.length), 0, activity);
    }
    return repeat(
      rows,
      (activity) => activity.id,
      (activity) => row(activity, this.motion(activity.id)),
    );
  }

  private motion(id: string): Motion {
    if (this.leaving.has(id)) return "is-leaving";
    return this.entering.has(id) ? "is-entering" : "";
  }
}

const suggestionRows = directive(SuggestionRows);

export function suggestedActivities(
  activities: SuggestedActivity[] | undefined,
  {
    onSelect,
    onDismiss,
    redraw,
    collapsed = false,
  }: {
    onSelect: (activity: SuggestedActivity) => void;
    onDismiss?: (activity: SuggestedActivity) => void;
    redraw: () => void;
    collapsed?: boolean;
  },
): TemplateResult | typeof nothing {
  if (!activities || (!activities.length && !onDismiss)) return nothing;
  const empty = !activities.length;
  return html`<section
    class="suggested-activities ${collapsed ? "is-collapsed" : ""} ${empty ? "is-empty" : ""}"
    aria-label="Suggested activities"
    aria-hidden=${collapsed || empty ? "true" : "false"}
    ?inert=${collapsed}
  >
    <div class="suggested-activities-list">
      ${suggestionRows(
        activities.slice(0, VISIBLE_COUNT),
        (activity, motion) =>
          html`<div class="suggested-activity-row ${motion}" ?inert=${motion === "is-leaving"}>
            <div class="suggested-activity-row-inner">
              <button
                type="button"
                class="suggested-activity"
                ?disabled=${collapsed}
                @click=${() => onSelect(activity)}
              >
                <span class="suggested-activity-icon" data-icon=${activity.icon} aria-hidden="true"
                  >${activity.icon === "yc" ? html`<span class="suggested-activity-yc">Y</span>` : (icons[activity.icon] ?? activity.icon)}</span
                >
                <span class="suggested-activity-title">${activity.title}</span>
              </button>
              ${
                onDismiss
                  ? html`<button
                      type="button"
                      class="suggested-activity-dismiss"
                      aria-label="Dismiss suggestion: ${activity.title}"
                      title="Dismiss"
                      ?disabled=${collapsed}
                      @click=${() => onDismiss(activity)}
                    >
                      ${icon(X, 14)}
                    </button>`
                  : nothing
              }
            </div>
          </div>`,
        redraw,
      )}
    </div>
  </section>`;
}
