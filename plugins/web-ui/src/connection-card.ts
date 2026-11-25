import { html, nothing, type TemplateResult } from "lit";
import { Check, Circle, CircleAlert, TriangleAlert, type IconNode } from "lucide";
import { connectorLogo } from "./connector-logo";
import { icon } from "./icons";
import type { ConnectionService } from "./connection-picker";

export type ConnectionOutcome = "" | "checking" | "success" | "cancelled" | "failed" | "expired";

export interface ConnectionStanding {
  outcome: ConnectionOutcome;
  notice: string;
  checked: boolean;
  connected: boolean;
  stale: boolean;
  working: string;
  problem: string;
  connect: () => void;
  reconnect?: () => void;
  disconnect?: () => void;
  recheck?: () => void;
}

type Status = { text: string; tone: string; mark?: IconNode };

function waiting(at: ConnectionStanding | undefined): boolean {
  return !at || at.outcome === "checking" || (!at.checked && !at.working && !at.problem);
}

const unknown: ConnectionStanding = {
  outcome: "",
  notice: "",
  checked: true,
  connected: false,
  stale: false,
  working: "",
  problem: "",
  connect: () => {},
};

function status(at: ConnectionStanding): Status {
  if (at.working) return { text: at.working, tone: "muted" };
  if (at.problem) return { text: at.problem, tone: "error", mark: CircleAlert };
  if (at.outcome === "failed") return { text: at.notice, tone: "error", mark: CircleAlert };
  if (at.connected && !at.stale) return { text: "Connected", tone: "success", mark: Check };
  if (at.outcome === "cancelled" || at.outcome === "expired") return { text: at.notice, tone: "muted", mark: Circle };
  if (at.stale) return { text: "Needs new permissions", tone: "warning", mark: TriangleAlert };
  return { text: "Not connected", tone: "muted", mark: Circle };
}

export function connectionActions(
  name: string | undefined,
  busy: boolean,
  reconnect?: () => void,
  disconnect?: () => void,
): TemplateResult {
  const action = (label: string, run: () => void, style: string) =>
    html`<button type="button" class=${style} aria-label=${`${label} ${name}`} ?disabled=${busy} @click=${run}>
      ${label}
    </button>`;
  return html`${reconnect ? action("Reconnect", reconnect, "kc-text-action") : nothing}${
    disconnect ? action("Disconnect", disconnect, "kc-text-action danger") : nothing
  }`;
}

export function connectionCard(
  service: Pick<ConnectionService, "id" | "logoUrl"> & { name?: string },
  known?: ConnectionStanding,
): TemplateResult {
  const name = service.name ?? nothing;
  const pending = waiting(known);
  const lastSeen = `qm-connection-card:${service.id}`;
  const at = pending ? { ...unknown, connected: localStorage.getItem(lastSeen) === "connected" } : known!;
  const { text, tone, mark } = status(at);
  const busy = pending || Boolean(at.working);
  const button = (label: string, name: string, run: () => void, style = "btn") =>
    html`<button type="button" class=${style} aria-label=${name} ?disabled=${busy} @click=${run}>${label}</button>`;
  const settled = at.checked;
  let next: TemplateResult | typeof nothing = nothing;
  if (settled && at.stale && at.reconnect)
    next = button("Reconnect", `Reconnect ${service.name}`, at.reconnect, "btn primary");
  else if (settled && !at.connected && at.outcome === "failed")
    next = button("Try again", `Try connecting ${service.name} again`, at.connect, "btn primary");
  else if (settled && !at.connected) next = button("Connect", `Connect ${service.name}`, at.connect, "btn primary");
  const looks = ["connector-widget", "connection-card"];
  if (next === nothing && !at.recheck && tone !== "error") looks.push("compact");
  if (!pending) {
    if (looks.includes("compact")) localStorage.setItem(lastSeen, "connected");
    else localStorage.removeItem(lastSeen);
  }
  if (tone === "success") looks.push("connected");
  if (pending) looks.push("pending");
  return html`<div
    class=${looks.join(" ")}
    data-tone=${tone}
    aria-busy=${pending ? "true" : nothing}
    role="group"
    aria-label=${name}
  >
    ${connectorLogo(service.id, service.logoUrl)}
    <span class="connector-widget-text">
      <strong>${service.name ?? "\u00a0"}</strong>
      <small class="connection-card-status" role="status">${mark ? icon(mark, 12) : nothing}${text}</small>
    </span>
    <span class="connection-card-actions"
      >${settled ? connectionActions(service.name, busy, at.stale ? undefined : at.reconnect, at.disconnect) : nothing}${at.recheck ? button("Check again", `Check ${service.name} again`, at.recheck) : nothing}${next}</span
    >
  </div>`;
}
