import { html, nothing, type TemplateResult } from "lit";
import { Check, Circle, CircleAlert, TriangleAlert } from "lucide";
import { connectorLogo } from "./connector-logo";
import { icon } from "./icons";
import type { ConnectionService } from "./connection-picker";

export interface ConnectionStanding {
  outcome: "" | "checking" | "success" | "cancelled" | "failed" | "expired";
  checked: boolean;
  connected: boolean;
  stale: boolean;
  working: string;
  problem: string;
  connect: () => void;
  disconnect?: () => void;
  recheck: () => void;
}

const MARKS = { idle: Circle, check: Check, alert: TriangleAlert, error: CircleAlert };
const ghost = html`<span class="connection-card-ghost"></span>`;

function status(at: ConnectionStanding): { text: string; tone: string; mark: keyof typeof MARKS | "spinner" } {
  const healthy = at.connected && !at.stale;
  if (at.outcome === "checking") return { text: "Confirming access…", tone: "muted", mark: "spinner" };
  if (at.working) return { text: at.working, tone: "muted", mark: "spinner" };
  if (at.problem) return { text: at.problem, tone: "error", mark: "error" };
  if (!at.checked) return { text: "", tone: "muted", mark: "idle" };
  if (at.outcome === "failed" && !healthy)
    return { text: "Couldn’t confirm the connection", tone: "error", mark: "error" };
  if (healthy) return { text: "Connected", tone: "success", mark: "check" };
  if (at.stale) return { text: "Needs new permissions", tone: "warning", mark: "alert" };
  if (at.outcome === "cancelled") return { text: "Sign-in cancelled", tone: "muted", mark: "idle" };
  if (at.outcome === "expired") return { text: "That sign-in expired", tone: "muted", mark: "idle" };
  return { text: "Not connected", tone: "muted", mark: "idle" };
}

export function connectionCard(
  service: Pick<ConnectionService, "id" | "logoUrl"> & { name?: string },
  at?: ConnectionStanding,
): TemplateResult {
  if (!service.name || !at)
    return html`<div class="connection-card" aria-busy="true">
      ${connectorLogo(service.id, service.logoUrl)}
      <span class="connection-card-text">${ghost}${ghost}</span>
    </div>`;
  const { text, tone, mark } = status(at);
  const settled = at.checked && at.outcome !== "checking";
  const button = (label: string, name: string, run: () => void, style = "btn") =>
    html`<button type="button" class=${style} aria-label=${name} ?disabled=${Boolean(at.working)} @click=${run}>
      ${label}
    </button>`;
  let next: TemplateResult | typeof nothing = nothing;
  if (settled && at.stale) next = button("Reconnect", `Reconnect ${service.name}`, at.connect, "btn primary");
  else if (settled && !at.connected && at.outcome === "failed")
    next = button("Try again", `Try connecting ${service.name} again`, at.connect, "btn primary");
  else if (settled && !at.connected) next = button("Connect", `Connect ${service.name}`, at.connect, "btn primary");
  return html`<div
    class=${mark === "check" && at.outcome === "success" ? "connection-card fresh" : "connection-card"}
    data-tone=${tone}
    role="group"
    aria-label=${service.name}
  >
    ${connectorLogo(service.id, service.logoUrl)}
    <span class="connection-card-text">
      <strong>${service.name}</strong>
      <span class="connection-card-status" role="status"
        >${
          text
            ? html`${mark === "spinner" ? html`<span class="mc-spinner"></span>` : icon(MARKS[mark], 13)}${text}`
            : ghost
        }</span
      >
    </span>
    <span class="connection-card-actions"
      >${settled && at.disconnect ? button("Disconnect", `Disconnect ${service.name}`, at.disconnect) : nothing}${
        !at.checked && at.problem ? button("Check again", `Check ${service.name} again`, at.recheck) : nothing
      }${next}</span
    >
  </div>`;
}
