import { html, nothing, type TemplateResult } from "lit";
import { AppWindow, BookOpen, Calendar, CalendarClock, PanelsTopLeft, Users } from "lucide";
import type { SuggestedActivity } from "../suggested-activities.ts";
import { icon } from "./ui";

const icons = {
  schedule: CalendarClock,
  app: AppWindow,
  deck: PanelsTopLeft,
  people: Users,
  calendar: Calendar,
  book: BookOpen,
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
              >${icon(icons[activity.icon], 20)}</span
            >
            <span class="suggested-activity-title">${activity.title}</span>
          </button>`,
      )}
    </div>
  </section>`;
}
