import { html, nothing, type TemplateResult } from "lit";
import { Check, Circle, CircleAlert, TriangleAlert, type IconNode } from "lucide";
import { connectorLogo } from "./connector-logo";
import { icon } from "./icons";
import type { ConnectionService } from "./connection-picker";

export interface ConnectionStanding {
  outcome: "" | "checking" | "success" | "cancelled" | "failed" | "expired";
  notice: string;
  checked: boolean;
  connected: boolean;
  stale: boolean;
  working: string;
  problem: string;
  connect: () => void;
  disconnect?: () => void;
  fix?: { label: string; name: string; run: () => void };
}

type Status = { text: string; tone: string; mark?: IconNode };
const WAITING: Status = { text: "Checking…", tone: "muted" };

function status(at: ConnectionStanding): Status {
  if (at.outcome === "checking") return { text: at.notice, tone: "muted" };
  if (at.working) return { text: at.working, tone: "muted" };
  if (at.problem) return { text: at.problem, tone: "error", mark: CircleAlert };
  if (!at.checked) return WAITING;
  if (at.connected && !at.stale) return { text: "Connected", tone: "success", mark: Check };
  if (at.outcome === "failed") return { text: at.notice, tone: "error", mark: CircleAlert };
  if (at.outcome === "cancelled" || at.outcome === "expired") return { text: at.notice, tone: "muted", mark: Circle };
  if (at.stale) return { text: "Needs new permissions", tone: "warning", mark: TriangleAlert };
  return { text: "Not connected", tone: "muted", mark: Circle };
}

export function connectionCard(
  service: Pick<ConnectionService, "id" | "logoUrl"> & { name?: string },
  at?: ConnectionStanding,
): TemplateResult {
  const { text, tone, mark } = at ? status(at) : WAITING;
  const button = (label: string, name: string, run: () => void, style = "btn") =>
    html`<button type="button" class=${style} aria-label=${name} ?disabled=${Boolean(at?.working)} @click=${run}>
      ${label}
    </button>`;
  const settled = at?.checked && at.outcome !== "checking";
  let next: TemplateResult | typeof nothing = nothing;
  if (settled && at.stale) next = button("Reconnect", `Reconnect ${service.name}`, at.connect, "btn primary");
  else if (settled && !at.connected && at.outcome === "failed")
    next = button("Try again", `Try connecting ${service.name} again`, at.connect, "btn primary");
  else if (settled && !at.connected) next = button("Connect", `Connect ${service.name}`, at.connect, "btn primary");
  const looks = ["connector-widget", "connection-card"];
  if (next === nothing && !at?.fix && tone !== "error") looks.push("compact");
  if (tone === "success") looks.push("connected");
  return html`<div class=${looks.join(" ")} data-tone=${tone} role="group" aria-label=${service.name ?? nothing}>
    ${connectorLogo(service.id, service.logoUrl)}
    <span class="connector-widget-text">
      ${service.name ? html`<strong>${service.name}</strong>` : nothing}
      <small class="connection-card-status" role="status"
        >${mark ? icon(mark, 12) : html`<span class="mc-spinner"></span>`}${text}</small
      >
    </span>
    <span class="connection-card-actions"
      >${settled && at.disconnect ? button("Disconnect", `Disconnect ${service.name}`, at.disconnect, "kc-text-action danger") : nothing}${
        at?.fix ? button(at.fix.label, at.fix.name, at.fix.run) : nothing
      }${next}</span
    >
  </div>`;
}
