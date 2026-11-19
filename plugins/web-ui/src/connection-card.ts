import { html, nothing, type TemplateResult } from "lit";
import { Check, Circle, CircleAlert, TriangleAlert } from "lucide";
import { connectorLogo } from "./connector-logo";
import { icon } from "./icons";
import type { ConnectionService } from "./connection-picker";

interface CardAction {
  label: string;
  /** The accessible name, which also names the app: "Connect Dropbox". */
  name: string;
  run: () => void;
}

/** What one app's card says and offers. An empty status means the connection is still being looked up. */
export interface ConnectionCardView {
  status: string;
  tone: "muted" | "success" | "warning" | "error";
  mark: "idle" | "check" | "alert" | "error" | "spinner";
  /** Connected a moment ago, so the check arrives instead of just being there. */
  fresh?: boolean;
  primary?: CardAction;
  quiet?: CardAction;
  busy?: boolean;
}

const ghost = html`<span class="connection-card-ghost"></span>`;

/**
 * One app, one row: its logo and name, a single line saying where the connection stands, and the one thing to do
 * about it. Every state has the same footprint, so the card never jumps as it loads or changes. Without a view the
 * app is still being looked up, and only its logo shows.
 */
export function connectionCard(
  service: Pick<ConnectionService, "id" | "logoUrl"> & { name?: string },
  view?: ConnectionCardView,
): TemplateResult {
  if (!service.name || !view)
    return html`<div class="connection-card" aria-busy="true">
      ${connectorLogo(service.id, service.logoUrl)}
      <span class="connection-card-text">${ghost}${ghost}</span>
    </div>`;
  const marks = { idle: Circle, check: Check, alert: TriangleAlert, error: CircleAlert };
  const mark = view.mark === "spinner" ? html`<span class="mc-spinner"></span>` : icon(marks[view.mark], 13);
  const button = (action: CardAction | undefined, style: string) =>
    action
      ? html`<button
          type="button"
          class=${style}
          aria-label=${action.name}
          ?disabled=${Boolean(view.busy)}
          @click=${action.run}
        >
          ${action.label}
        </button>`
      : nothing;
  return html`<div
    class=${view.fresh ? "connection-card fresh" : "connection-card"}
    data-tone=${view.tone}
    role="group"
    aria-label=${service.name}
  >
    ${connectorLogo(service.id, service.logoUrl)}
    <span class="connection-card-text">
      <strong>${service.name}</strong>
      <span class="connection-card-status" role="status">${view.status ? html`${mark}${view.status}` : ghost}</span>
    </span>
    <span class="connection-card-actions">${button(view.quiet, "btn")}${button(view.primary, "btn primary")}</span>
  </div>`;
}
