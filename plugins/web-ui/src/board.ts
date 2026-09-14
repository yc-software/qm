import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { api } from "./core-bridge";
import { fieldSelect } from "./ui";
import { appState } from "./shell-state";
import { sessionsState, sessionTitle } from "./sessions";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import type {
  SwarmBoardPage,
  SwarmBoardQuery,
  SwarmBoardMessage,
  SwarmBoardMember,
  SwarmPublicIdentity,
} from "../../../src/swarms/swarm-board-view";
import "./board.css";

let host: HTMLElement | null = null;
let owner: string | null = null;
let sessionId = "";
let query: SwarmBoardQuery = { visibility: "org" };
let page: SwarmBoardPage | null = null;
let pageKey = "";
let composeContext = "";
let peers: SwarmPublicIdentity[] = [];
let peerAfter: string | undefined;
let peerSearch = "";
let selected = new Set<string>();
let preview: SwarmPublicIdentity[] | null = null;
let text = "";
let notify = true;
let notice = "";
let loading = false;
let busy = false;
let generation = 0;
let draft: { signature: string; requestId: string } | null = null;

export function resetBoardState(): void {
  generation++;
  owner = null;
  sessionId = "";
  page = null;
  pageKey = "";
  composeContext = "";
  peers = [];
  peerAfter = undefined;
  peerSearch = "";
  notify = true;
  busy = false;
  loading = false;
  query = { visibility: "org" };
  selected = new Set();
  preview = null;
  text = "";
  draft = null;
  notice = "";
}

export function boardPath(): string {
  const params = new URLSearchParams();
  if (query.visibility === "private") {
    params.set("visibility", "private");
    if (sessionId) params.set("session", sessionId);
  }
  for (const key of ["search", "sender", "recipient", "replyTo", "after"] as const)
    if (query[key]) params.set(key, query[key]!);
  const path = deepLinkPath(UI_BASE, "board", null, null, query.id);
  return path + (params.size ? `?${params}` : "");
}

export function routeBoardHistory(id: string | null): void {
  const params = new URLSearchParams(location.search);
  query = { visibility: params.get("visibility") === "private" ? "private" : "org" };
  if (id) query.id = id;
  for (const key of ["search", "sender", "recipient", "replyTo", "after"] as const)
    if (params.get(key)) query[key] = params.get(key)!;
  if (params.get("session")) sessionId = params.get("session")!;
  if (appState.currentView === "board") void load();
}

const endpoint = () => `/api/sessions/${encodeURIComponent(sessionId)}/swarm`;
const sessionHref = (id: string) => deepLinkPath(UI_BASE, "chats", id);
const date = (at: number) => new Date(at).toLocaleString();
const json = (value: unknown) => JSON.stringify(value, null, 2);

function navigate(patch: Partial<SwarmBoardQuery>): void {
  query = { visibility: query.visibility, ...patch };
  history.pushState(null, "", boardPath());
  void load();
}

async function loadPeers(after?: string): Promise<void> {
  if (!sessionId || query.visibility !== "org") return;
  const version = generation;
  const params = new URLSearchParams({ discover: "1" });
  if (peerSearch) params.set("search", peerSearch);
  if (after) params.set("after", after);
  const found = await api<{ peers: SwarmPublicIdentity[]; nextAfter?: string }>(endpoint() + `?${params}`);
  if (version !== generation) return;
  peers = after ? [...peers, ...found.peers] : found.peers;
  peerAfter = found.nextAfter;
}

async function load(): Promise<void> {
  if (!sessionId) {
    paint();
    return;
  }
  const version = ++generation;
  busy = false;
  const context = JSON.stringify([sessionId, query.visibility, query.id]);
  if (context !== composeContext) {
    composeContext = context;
    text = "";
    selected.clear();
    draft = null;
  }
  loading = true;
  const key = JSON.stringify([sessionId, query]);
  if (key !== pageKey) page = null;
  notice = "";
  preview = null;
  paint();
  const params = new URLSearchParams({ board: "1", visibility: query.visibility });
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  try {
    const result = await api<SwarmBoardPage>(endpoint() + `?${params}`);
    if (version !== generation) return;
    page = result;
    pageKey = key;
    await loadPeers();
  } catch (e) {
    if (version === generation) {
      notice = errMessage(e);
      page = null;
    }
  } finally {
    if (version === generation) {
      loading = false;
      paint();
    }
  }
}

async function mutate(operation: () => Promise<unknown>, refresh = true): Promise<void> {
  if (busy) return;
  const version = generation;
  busy = true;
  notice = "";
  paint();
  try {
    await operation();
    if (version === generation && refresh) await load();
  } catch (e) {
    if (version === generation) notice = errMessage(e);
  } finally {
    if (version === generation) {
      busy = false;
      paint();
    }
  }
}

async function post(body: unknown): Promise<unknown> {
  return api(endpoint(), { method: "POST", body: JSON.stringify(body) });
}

function choose(id: string, checked: boolean): void {
  if (checked) selected.add(id);
  else selected.delete(id);
  preview = null;
  draft = null;
  paint();
}

async function previewAudience(): Promise<void> {
  if (busy) return;
  const version = generation;
  busy = true;
  notice = "";
  paint();
  try {
    const audience = [...selected];
    const result = (await post({ action: "preview", visibility: "org", audience })) as {
      audience: SwarmPublicIdentity[];
    };
    if (version === generation && audience.length === selected.size && audience.every((id) => selected.has(id)))
      preview = result.audience;
  } catch (e) {
    if (version === generation) notice = errMessage(e);
  } finally {
    if (version === generation) {
      busy = false;
      paint();
    }
  }
}

async function send(): Promise<void> {
  const payload = {
    action: "send",
    text,
    audience: [...selected],
    notify,
    ...(query.id ? { replyTo: query.id } : {}),
    ...(query.visibility === "org"
      ? { visibility: "org", versions: Object.fromEntries((preview ?? []).map((p) => [p.id, p.version])) }
      : {}),
  };
  if (query.visibility === "org" && !preview) return;
  const signature = json(payload);
  if (draft?.signature !== signature) draft = { signature, requestId: crypto.randomUUID() };
  const version = generation;
  await mutate(async () => {
    await post({ ...payload, requestId: draft!.requestId });
    if (version !== generation) return;
    text = "";
    draft = null;
    selected.clear();
    preview = null;
  });
}

function messageRow(message: SwarmBoardMessage): TemplateResult {
  return html`<li class="board-message">
    <div class="board-meta">
      <strong>${message.sender.name}</strong
      >${message.sender.version ? html`<span>v${message.sender.version}</span>` : nothing}<span
        >${date(message.createdAt)}</span
      ><span>${message.visibility === "org" ? "Organization-public" : "Private swarm"}</span>
    </div>
    <p class="board-text">${message.text}</p>
    <div class="board-meta">
      To
      ${message.audience.map((p) => p.name).join(", ") || "no recipients"}${message.replyTo ? html`<span>· reply</span>` : nothing}
    </div>
    <div class="board-actions">
      <button class="btn" @click=${() => navigate({ id: message.id })}>Inspect message</button>
      ${message.replyTo ? html`<button class="btn" @click=${() => navigate({ id: message.replyTo })}>Parent message</button>` : nothing}
    </div>
  </li>`;
}

function memberRow(member: SwarmBoardMember): TemplateResult {
  const disabled = busy || !page?.canManage;
  const control = (command: "pause" | "resume" | "stop", subtree: boolean) => {
    if (command === "stop" && !confirm("Permanently stop this agent and its descendant work? It cannot be resumed."))
      return;
    void mutate(() =>
      post({ action: "control", memberId: member.id, command, subtree, version: member.controlVersion }),
    );
  };
  return html`<details class="board-member">
    <summary>${member.name} <span>${member.effectiveState} · ${member.state}</span></summary>
    <p class="board-meta">
      Depth ${member.depth} · ${member.descendants}/${member.descendantLimit} descendants · ${member.attempts}
      provisioning attempts${member.cleanupPending ? " · cleanup pending" : ""}
    </p>
    ${member.parentId ? html`<p class="board-meta">Parent: ${page?.members.find((m) => m.id === member.parentId)?.name ?? "unavailable"}</p>` : nothing}
    ${
      member.publicIdentity
        ? html`<p class="board-meta">Public character v${member.publicIdentity.version}</p>
            <pre>${json(member.publicIdentity.character)}</pre>`
        : html`<p class="board-meta">Not published to the organization</p>`
    }
    ${member.sessionId ? html`<a href=${sessionHref(member.sessionId)}>Open conversation</a>` : nothing}
    ${
      page?.canManage
        ? html`<div class="board-actions">
            <button
              class="btn"
              ?disabled=${disabled || member.effectiveState === "stopped"}
              @click=${() => control(member.control === "paused" ? "resume" : "pause", false)}
            >
              ${member.control === "paused" ? "Resume agent" : "Pause agent"}
            </button>
            <button
              class="btn"
              ?disabled=${disabled || member.effectiveState === "stopped"}
              @click=${() => control(member.control === "paused" ? "resume" : "pause", true)}
            >
              ${member.control === "paused" ? "Resume subtree" : "Pause subtree"}
            </button>
            <button
              class="btn"
              ?disabled=${disabled || member.effectiveState === "stopped"}
              @click=${() => control("stop", true)}
            >
              Stop permanently
            </button>
          </div>`
        : nothing
    }
    ${
      member.id === page?.selfId && page.canManage && member.effectiveState === "active"
        ? html` <form
              class="board-form"
              @submit=${(e: SubmitEvent) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget as HTMLFormElement);
                void mutate(() =>
                  post({
                    action: "character",
                    version: member.publicIdentity?.version ?? 0,
                    name: String(f.get("name")),
                    character: JSON.parse(String(f.get("character"))),
                  }),
                );
              }}
            >
              <label
                >Public name<input
                  name="name"
                  required
                  maxlength="120"
                  value=${member.publicIdentity?.name ?? member.name}
              /></label>
              <label
                >Public character (JSON)<textarea name="character" rows="4" required>
${json(member.publicIdentity?.character ?? {})}</textarea>
              </label>
              <p class="board-meta">
                Visible organization-wide. Descriptive metadata only; do not include private information.
              </p>
              <button class="btn" ?disabled=${busy}>Save public character</button>
            </form>
            <form
              class="board-form"
              @submit=${(e: SubmitEvent) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget as HTMLFormElement);
                void mutate(() => post({ action: "limit", descendants: Number(f.get("limit")) }));
              }}
            >
              <label
                >Lower descendant limit<input
                  name="limit"
                  type="number"
                  min="0"
                  max=${member.descendantLimit}
                  value=${member.descendantLimit} /></label
              ><button class="btn" ?disabled=${busy}>Lower limit</button>
            </form>`
        : nothing
    }
  </details>`;
}

function detail(): TemplateResult {
  const message = page!.messages[0];
  if (!message) return html`<p class="empty">Message not found or no longer visible.</p>`;
  return html`<button class="context-back" @click=${() => navigate({})}>← Timeline</button>
    <section class="board-detail">
      <div class="board-meta">
        ${message.visibility === "org" ? "Organization-public" : "Private swarm"} · ${date(message.createdAt)}
      </div>
      <h2>${message.sender.name}${message.sender.version ? ` · v${message.sender.version}` : ""}</h2>
      <p class="board-text">${message.text}</p>
      <div class="board-actions">
        <a href=${boardPath()}>Permalink</a
        >${message.replyTo ? html`<button class="btn" @click=${() => navigate({ id: message.replyTo })}>Parent message</button>` : nothing}
      </div>
      <details>
        <summary>Frozen sender and audience evidence</summary>
        <pre>${json({ sender: message.sender, audience: message.audience })}</pre>
      </details>
      <h3>Delivery and execution</h3>
      <p class="board-meta">
        Dispatch is not execution. A completed run does not prove an answer; only explicit replies do. Run details are
        shown only where you have conversation access.
      </p>
      <ul class="board-deliveries">
        ${page!.deliveries?.map((d) => html`<li><strong>${message.audience.find((p) => p.id === d.recipientId)?.name ?? d.recipientId}</strong><span>Dispatch: ${d.dispatch}</span><span>Execution: ${d.execution?.replaceAll("_", " ") ?? "not visible"}</span><span>${d.answered ? "Explicit reply visible" : "No reply on this page"}</span>${d.sessionId ? html`<a href=${sessionHref(d.sessionId)}>Open conversation</a>` : nothing}</li>`)}
      </ul>
      <h3>Replies</h3>
      <ul class="board-timeline">
        ${page!.replies?.map(messageRow)}
      </ul>
      ${!page!.replies?.length ? html`<p class="board-meta">No visible replies.</p>` : nothing}
      ${page!.repliesNextAfter ? html`<button class="btn" @click=${() => navigate({ replyTo: message.id })}>Browse all replies</button>` : nothing}
    </section>`;
}

function compose(): TemplateResult {
  if (!page?.writable)
    return html`<p class="board-meta">
      Read-only. Work may be paused, stopped or expired, or this agent has not published a public identity.
    </p>`;
  return html`<details class="board-compose">
    <summary>${query.id ? "Reply to this message" : "Write a message"}</summary>
    <p class="board-meta">
      ${query.visibility === "org" ? "Organization-public: every internal participant can read this text. Select explicit public recipients below." : "Private: only this swarm can read this message."}
    </p>
    <fieldset>
      <legend>Recipients</legend>
      ${(query.visibility === "org" ? peers : page.members).map((p) => html`<label class="board-choice"><input type="checkbox" .checked=${selected.has(p.id)} @change=${(e: Event) => choose(p.id, (e.currentTarget as HTMLInputElement).checked)} />${p.name}</label>`)}
    </fieldset>
    <label class="board-form"
      >Message<textarea
        rows="4"
        .value=${live(text)}
        @input=${(e: Event) => {
          text = (e.currentTarget as HTMLTextAreaElement).value;
          draft = null;
        }}
      ></textarea>
    </label>
    <label class="board-choice"
      ><input
        type="checkbox"
        .checked=${notify}
        @change=${(e: Event) => {
          notify = (e.currentTarget as HTMLInputElement).checked;
          draft = null;
          paint();
        }}
      />Notify selected agents (queues work)</label
    >
    ${
      preview
        ? html`<details open>
            <summary>Current audience preview (${preview.length})</summary>
            <pre>${json(preview)}</pre>
          </details>`
        : nothing
    }
    <div class="board-actions">
      ${query.visibility === "org" ? html`<button class="btn" ?disabled=${busy} @click=${() => void previewAudience()}>Preview audience</button>` : nothing}
      <button
        class="btn primary"
        ?disabled=${busy || (query.visibility === "org" && !preview)}
        @click=${() => void send()}
      >
        ${query.visibility === "org" ? "Publish publicly" : "Send privately"}${notify ? ` and notify ${selected.size}` : " without notifying"}
      </button>
    </div>
  </details>`;
}

function paint(): void {
  if (!host || appState.currentView !== "board") return;
  render(
    html`<header class="list-page-head">
        <div>
          <h1 class="pane-title">Agent board</h1>
          <p class="pane-subtitle">Explicit coordination, with private work kept separate.</p>
        </div>
      </header>
      <div class="board-filters">
        <label
          >Acting
          session${fieldSelect({
            value: sessionId,
            ariaLabel: "Acting session",
            options: sessionsState.list.map(
              (s) => html`<option value=${s.id} ?selected=${s.id === sessionId}>${sessionTitle(s)}</option>`,
            ),
            onChange: (value) => {
              sessionId = value;
              selected.clear();
              navigate({});
            },
          })}</label
        >
        <label
          >Visibility${fieldSelect({
            value: query.visibility,
            ariaLabel: "Visibility",
            options: html`<option value="org" ?selected=${query.visibility === "org"}>Organization-public</option>
              <option value="private" ?selected=${query.visibility === "private"}>Private swarm</option>`,
            onChange: (value) => {
              selected.clear();
              text = "";
              navigate({ visibility: value as SwarmBoardQuery["visibility"] });
            },
          })}</label
        >
      </div>
      <form
        class="board-filters"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          navigate({
            search: String(f.get("search") || "") || undefined,
            sender: String(f.get("sender") || "") || undefined,
            recipient: String(f.get("recipient") || "") || undefined,
          });
        }}
      >
        <label>Search messages<input name="search" type="search" .value=${live(query.search ?? "")} /></label
        ><label>Sender ID<input name="sender" .value=${live(query.sender ?? "")} /></label
        ><label>Recipient ID<input name="recipient" .value=${live(query.recipient ?? "")} /></label
        ><button class="btn" ?disabled=${busy}>Filter</button
        ><button class="btn" type="button" @click=${() => navigate({})}>Clear</button>
      </form>
      ${notice ? html`<p class="board-notice" role="alert">${notice}</p>` : nothing}
      ${!sessionId ? html`<p class="empty">Open a conversation first to inspect coordination.</p>` : nothing}
      ${loading ? html`<p role="status">Loading…</p>` : nothing}
      ${
        page
          ? html`<div class="board-columns">
              <section class="board-content">
                ${
                  query.id
                    ? detail()
                    : html`<p class="board-meta">
                          ${page.messages.length} visible messages on this
                          page${query.replyTo ? " · thread filter" : ""}
                        </p>
                        <ul class="board-timeline">
                          ${page.messages.map(messageRow)}
                        </ul>
                        ${!page.messages.length ? html`<p class="empty">No visible messages match.</p>` : nothing}${page.nextAfter ? html`<button class="btn" @click=${() => navigate({ ...query, after: page!.nextAfter })}>Older messages</button>` : nothing}`
                }${compose()}
              </section>
              <aside class="board-inspector">
                <h2>Your swarm</h2>
                ${page.expiresAt ? html`<p class="board-meta">Work deadline ${date(page.expiresAt)}</p>` : nothing}${page.members.map(memberRow)}
                ${
                  query.visibility === "org"
                    ? html`<h2>Public agents</h2>
                        <form
                          class="board-form"
                          @submit=${(e: SubmitEvent) => {
                            e.preventDefault();
                            void mutate(() => loadPeers(), false);
                          }}
                        >
                          <label
                            >Find public agents<input
                              type="search"
                              .value=${live(peerSearch)}
                              @input=${(e: Event) => {
                                peerSearch = (e.currentTarget as HTMLInputElement).value;
                              }} /></label
                          ><button class="btn">Search agents</button>
                        </form>
                        ${peers.map(
                          (p) =>
                            html`<details class="board-member">
                              <summary>${p.name} <span>v${p.version}</span></summary>
                              <p class="board-id">${p.id}</p>
                              <pre>${json(p.character)}</pre>
                              <button class="btn" @click=${() => navigate({ sender: p.id })}>
                                Messages from this agent
                              </button>
                            </details>`,
                        )}${peerAfter ? html`<button class="btn" @click=${() => void mutate(() => loadPeers(peerAfter), false)}>More public agents</button>` : nothing}`
                    : nothing
                }
              </aside>
            </div>`
          : nothing
      }`,
    host,
  );
}

export async function renderBoardPage(): Promise<void> {
  if (!appState.mainEl) return;
  const actor = appState.me?.user ?? null;
  if (owner && owner !== actor) resetBoardState();
  owner = actor;
  if (!sessionId) sessionId = sessionsState.list[0]?.id ?? "";
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane board-page";
    appState.mainEl.replaceChildren(host);
  }
  await load();
}
