import { html, nothing, type TemplateResult } from "lit";
import { Users, ChevronRight } from "lucide";
import { api } from "./core-bridge.ts";
import { icon, relTime } from "./ui.ts";

export interface SwarmPeer {
  id: string;
  parentId?: string;
  sessionId?: string;
  sessionUrl?: string;
  sandboxId?: string;
  context: unknown;
  state: "reserved" | "ready" | "failed";
  control?: "paused" | "stopped";
  error?: string;
  depth: number;
}

export interface SwarmView {
  id: string;
  self: SwarmPeer;
  peers: SwarmPeer[];
  board?: { sandboxId: string };
  model?: string;
  expiresAt: number;
}

export interface SwarmBoardMessage {
  id: string;
  seq: number;
  senderId: string;
  author: "agent" | "human";
  text: string;
  audience: string[];
  broadcast?: true;
  replyTo?: string;
  createdAt: number;
}

type Control = "active" | "paused" | "stopped";
type Status = Control | "starting" | "failed";

const PAGE = 20;
const REFRESH_MS = 4_000;
const BOARD_PAGES = 16;
const BULK: Record<Control, { label: string; from: (peer: SwarmPeer) => boolean }> = {
  paused: { label: "Pause all", from: (peer) => !peer.control },
  active: { label: "Resume all", from: (peer) => peer.control === "paused" },
  stopped: { label: "Stop all", from: (peer) => peer.control !== "stopped" },
};

function short(id: string): string {
  return id.slice(0, 8);
}

function detail(peer: SwarmPeer): string {
  return [
    `session: ${peer.sessionId ?? "not started"}`,
    `computer: ${peer.sandboxId ?? "none"}`,
    ...(peer.state === "failed" && peer.error ? [`why it failed: ${peer.error}`] : []),
    `context: ${JSON.stringify(peer.context, null, 2)}`,
  ].join("\n");
}

function windowNote(expiresAt: number): string {
  const when = new Date(expiresAt).toLocaleString();
  return Date.now() >= expiresAt ? `Work window expired ${when}` : `Work window ends ${when}`;
}

function peerLabel(id: string, view: SwarmView): string {
  return id === view.id ? "root" : short(id);
}

function audienceOf(message: SwarmBoardMessage, view: SwarmView): string {
  if (!message.audience.length) return "nobody";
  if (message.broadcast) return "all";
  return message.audience.map((id) => peerLabel(id, view)).join(", ");
}

function boardRows(messages: SwarmBoardMessage[], view: SwarmView): TemplateResult[] {
  const seqById = new Map(messages.map((message) => [message.id, message.seq]));
  return messages.map((message) => {
    const target = message.replyTo === undefined ? undefined : (seqById.get(message.replyTo) ?? short(message.replyTo));
    const reply = target === undefined ? "" : ` · reply to ${typeof target === "number" ? `#${target}` : target}`;
    return html`<div class="bg-row" style="padding-left:${message.replyTo ? 12 : 0}px">
      <div class="bg-row-head static">
        <span class="bg-row-cmd">#${message.seq} ${message.author} ${peerLabel(message.senderId, view)}${reply}</span>
        <span class="bg-row-meta" title=${new Date(message.createdAt).toLocaleString()}>
          to ${audienceOf(message, view)} · ${relTime(message.createdAt)}
        </span>
      </div>
      <div class="bg-row-output">${message.text}</div>
    </div>`;
  });
}

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
    board: [] as SwarmBoardMessage[],
    boardNote: "",
    generation: 0,
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
  const loadBoard = async (sessionId: string): Promise<void> => {
    const generation = ui.generation;
    for (let page = 0; page < BOARD_PAGES; page++) {
      const read = await api<{ messages?: SwarmBoardMessage[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/swarm?read=1&after=${ui.board.at(-1)?.seq ?? 0}`,
      ).catch((error: unknown) => (error instanceof Error ? error : new Error("the request did not complete")));
      if (ui.generation !== generation) return;
      if (read instanceof Error) {
        ui.boardNote = `Could not read the board: ${read.message}`;
        return redraw();
      }
      if (!Array.isArray(read.messages)) {
        ui.boardNote = "Could not read the board: the reply carried no messages.";
        return redraw();
      }
      const after = ui.board.at(-1)?.seq ?? 0;
      const fresh = read.messages.filter((message) => message.seq > after);
      ui.board = [...ui.board, ...fresh];
      ui.boardNote = ui.board.length ? "" : "No messages yet.";
      redraw();
      if (!fresh.length) return;
    }
    ui.boardNote = "More messages remain; reopen the panel to keep loading.";
    redraw();
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
    if (ui.open) await loadBoard(sessionId);
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
    const name = peer.depth === 0 ? "Root session" : `Worker ${short(peer.id)}`;
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
      <div class="bg-row-output">${detail(peer)}</div>
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
        Object.assign(ui, {
          sessionId,
          view: null,
          board: [],
          boardNote: "Reading the board…",
          generation: ui.generation + 1,
          open: false,
          error: "",
          shown: new Map(),
          timer: undefined,
        });
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
            ? html`<div class="bg-panel" role="region" aria-label="Swarm workers and board">
                ${ui.error ? html`<div class="bg-panel-note">${ui.error}</div>` : nothing}
                <div class="bg-panel-note">${windowNote(view.expiresAt)}</div>
                <div class="bg-panel-note">Workers run ${view.model ?? "the scope default"}</div>
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
                <div class="bg-panel-note">Board · ${ui.board.length} message${ui.board.length === 1 ? "" : "s"}</div>
                ${ui.board.length ? boardRows(ui.board, view) : nothing}
                ${ui.boardNote ? html`<div class="bg-panel-note">${ui.boardNote}</div>` : nothing}
              </div>`
            : nothing
        }
      </section>`;
    },
  };
}
