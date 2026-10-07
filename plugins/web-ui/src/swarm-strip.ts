import { html, nothing, type TemplateResult } from "lit";
import { Users, ChevronRight } from "lucide";
import { api } from "./core-bridge.ts";
import { icon } from "./ui.ts";

interface SwarmPeer {
  id: string;
  parentId?: string;
  sessionId?: string;
  sessionUrl?: string;
  state: "reserved" | "ready" | "failed";
  control?: "paused" | "stopped";
  depth: number;
}

interface SwarmView {
  id: string;
  self: SwarmPeer;
  peers: SwarmPeer[];
  board?: { sandboxId: string };
  expiresAt: number;
}

type Control = "active" | "paused" | "stopped";
type Status = Control | "starting" | "failed";

const PAGE = 20;
const REFRESH_MS = 4_000;
const BULK: Record<Control, { label: string; from: (peer: SwarmPeer) => boolean }> = {
  paused: { label: "Pause all", from: (peer) => !peer.control },
  active: { label: "Resume all", from: (peer) => peer.control === "paused" },
  stopped: { label: "Stop all", from: (peer) => peer.control !== "stopped" },
};

function effective(peer: SwarmPeer, inherited: Status): Status {
  if (peer.control === "stopped" || inherited === "stopped") return "stopped";
  if (peer.state === "failed") return "failed";
  if (peer.control === "paused" || inherited === "paused") return "paused";
  return peer.state === "reserved" ? "starting" : "active";
}

function statuses(view: SwarmView): Map<string, Status> {
  const byId = new Map(view.peers.map((peer) => [peer.id, peer]));
  const result = new Map<string, Status>();
  const resolve = (peer: SwarmPeer, seen = new Set<string>()): Status => {
    const known = result.get(peer.id);
    if (known) return known;
    const parent = peer.parentId && !seen.has(peer.parentId) ? byId.get(peer.parentId) : undefined;
    const inherited = parent ? resolve(parent, seen.add(peer.id)) : "active";
    const status = effective(peer, inherited);
    result.set(peer.id, status);
    return status;
  };
  for (const peer of view.peers) resolve(peer);
  return result;
}

export function createSwarmStrip(redraw: () => void) {
  const ui = {
    sessionId: "",
    view: null as SwarmView | null,
    open: false,
    busy: "",
    error: "",
    shown: new Map<string, number>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const schedule = (sessionId: string, active: boolean): void => {
    clearTimeout(ui.timer);
    ui.timer = undefined;
    if (!active || ui.sessionId !== sessionId) return;
    ui.timer = setTimeout(() => {
      if (!document.hidden) return void load(sessionId);
      document.addEventListener("visibilitychange", () => void load(sessionId), { once: true });
    }, REFRESH_MS);
  };
  const load = async (sessionId: string): Promise<void> => {
    const view = await api<SwarmView>(`/api/sessions/${encodeURIComponent(sessionId)}/swarm`).catch(() => null);
    if (ui.sessionId !== sessionId) return;
    ui.view = Array.isArray(view?.peers) ? view : null;
    const status = ui.view ? statuses(ui.view) : new Map();
    schedule(
      sessionId,
      [...status.entries()].some(([id, s]) => id !== ui.view?.id && (s === "active" || s === "starting")),
    );
    redraw();
  };
  const post = (sessionId: string, memberId: string, state: Control) =>
    api(`/api/sessions/${encodeURIComponent(sessionId)}/swarm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "control", memberId, state }),
    });
  const control = async (key: string, memberIds: string[], state: Control): Promise<void> => {
    const sessionId = ui.sessionId;
    Object.assign(ui, { busy: key, error: "" });
    redraw();
    const results = await Promise.allSettled(memberIds.map((id) => post(sessionId, id, state)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) ui.error = `Could not update ${failed} of ${memberIds.length} workers.`;
    ui.busy = "";
    await load(sessionId);
  };
  const bulk = (view: SwarmView, state: Control): void => {
    const targets = view.peers.filter((peer) => peer.parentId === view.id && BULK[state].from(peer)).map((p) => p.id);
    if (!targets.length) return;
    if (state === "stopped" && !confirm(`Stop all ${targets.length} worker groups? Stopped workers cannot be resumed.`))
      return;
    void control("bulk", targets, state);
  };
  const row = (peer: SwarmPeer, status: Status, view: SwarmView): TemplateResult => {
    const controllable = peer.depth > 0 && status !== "stopped" && peer.id !== view.self.id;
    const busy = ui.busy !== "";
    const name = peer.depth === 0 ? "Root session" : `Worker ${peer.id.slice(0, 8)}`;
    const label = peer.sessionUrl ? html`<a href=${peer.sessionUrl}>${name}</a>` : name;
    const next: Control = peer.control === "paused" ? "active" : "paused";
    return html`<div class="bg-row swarm-peer" style="padding-left:${Math.min(peer.depth, 6) * 12}px">
      <div class="bg-row-head static">
        <span class="bg-row-cmd">${label}</span>
        <span class="bg-row-meta">${status}</span>
        ${
          controllable
            ? html`${
                  peer.control === "paused" || !peer.control
                    ? html`<button
                        type="button"
                        ?disabled=${busy}
                        @click=${() => void control(peer.id, [peer.id], next)}
                      >
                        ${next === "active" ? "Resume" : "Pause"}
                      </button>`
                    : nothing
                }
                <button type="button" ?disabled=${busy} @click=${() => void control(peer.id, [peer.id], "stopped")}>
                  Stop
                </button>`
            : nothing
        }
      </div>
    </div>`;
  };
  const tree = (view: SwarmView, status: Map<string, Status>): TemplateResult[] => {
    const children = new Map<string, SwarmPeer[]>();
    for (const peer of view.peers) {
      if (!peer.parentId) continue;
      children.set(peer.parentId, [...(children.get(peer.parentId) ?? []), peer]);
    }
    const out: TemplateResult[] = [];
    const walk = (peer: SwarmPeer, seen: Set<string>): void => {
      if (seen.has(peer.id)) return;
      seen.add(peer.id);
      out.push(row(peer, status.get(peer.id) ?? "active", view));
      const kids = children.get(peer.id) ?? [];
      const limit = ui.shown.get(peer.id) ?? PAGE;
      for (const kid of kids.slice(0, limit)) walk(kid, seen);
      if (kids.length > limit)
        out.push(
          html`<button
            type="button"
            class="bg-panel-note swarm-more"
            style="padding-left:${Math.min(peer.depth + 1, 6) * 12}px"
            @click=${() => {
              ui.shown.set(peer.id, limit + PAGE);
              redraw();
            }}
          >
            Show ${Math.min(PAGE, kids.length - limit)} more of ${kids.length - limit} remaining
          </button>`,
        );
    };
    const root = view.peers.find((peer) => peer.id === view.id) ?? view.peers[0]!;
    walk(root, new Set());
    return out;
  };
  return {
    strip(sessionId: string | null): TemplateResult | typeof nothing {
      if (!sessionId) return nothing;
      if (sessionId !== ui.sessionId) {
        clearTimeout(ui.timer);
        Object.assign(ui, { sessionId, view: null, open: false, error: "", shown: new Map(), timer: undefined });
        void load(sessionId);
      }
      const view = ui.view;
      if (!view || view.peers.length < 2) return nothing;
      const status = statuses(view);
      const counts: Record<Status, number> = { active: 0, starting: 0, paused: 0, stopped: 0, failed: 0 };
      for (const peer of view.peers) if (peer.depth > 0) counts[status.get(peer.id) ?? "active"]++;
      const summary = (["active", "starting", "paused", "stopped", "failed"] as const)
        .filter((key) => key === "active" || counts[key])
        .map((key) => `${counts[key]} ${key}`)
        .join(" · ");
      const canBulk = view.self.depth === 0;
      return html`<section class="bg-activity swarm-activity ${ui.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(ui.open)}
          @click=${() => {
            ui.open = !ui.open;
            if (ui.open) void load(sessionId);
            redraw();
          }}
        >
          ${icon(Users, 13)}<span class="bg-activity-label">Swarm · ${summary}</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${
          ui.open
            ? html`<div class="bg-panel" role="region" aria-label="Swarm workers">
                ${ui.error ? html`<div class="bg-panel-note">${ui.error}</div>` : nothing}
                ${
                  view.board
                    ? html`<div class="bg-panel-note">Shared board computer: ${view.board.sandboxId}</div>`
                    : nothing
                }
                ${
                  canBulk
                    ? html`<div class="bg-panel-note swarm-bulk">
                        ${(["paused", "active", "stopped"] as const).map(
                          (state) =>
                            html`<button type="button" ?disabled=${ui.busy !== ""} @click=${() => bulk(view, state)}>
                              ${BULK[state].label}
                            </button>`,
                        )}
                      </div>`
                    : nothing
                }
                ${tree(view, status)}
              </div>`
            : nothing
        }
      </section>`;
    },
  };
}
