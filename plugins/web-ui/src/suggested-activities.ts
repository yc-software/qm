import { html, nothing, type TemplateResult } from "lit";
import type { SuggestedActivity } from "../../chassis/src/suggested-activities.ts";

const icons: Record<string, string> = {
  schedule: "⏰",
  app: "🛠️",
  deck: "📊",
  people: "👥",
  calendar: "📅",
  book: "📚",
};

export function suggestedActivities(
  activities: SuggestedActivity[] | undefined,
  onSelect: (activity: SuggestedActivity) => void,
  collapsed = false,
): TemplateResult | typeof nothing {
  if (!activities?.length) return nothing;
  return html`<section
    class="suggested-activities ${collapsed ? "is-collapsed" : ""}"
    aria-label="Suggested activities"
    aria-hidden=${collapsed ? "true" : "false"}
    ?inert=${collapsed}
  >
    <div class="suggested-activities-list">
      ${activities.slice(0, 3).map(
        (activity) =>
          html`<button
            type="button"
            class="suggested-activity"
            ?disabled=${collapsed}
            @click=${() => onSelect(activity)}
          >
            <span class="suggested-activity-icon" data-icon=${activity.icon} aria-hidden="true"
              >${activity.icon === "yc" ? html`<span class="suggested-activity-yc">Y</span>` : (icons[activity.icon] ?? activity.icon)}</span
            >
            <span class="suggested-activity-title">${activity.title}</span>
          </button>`,
      )}
    </div>
  </section>`;
}
