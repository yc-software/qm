import { html, nothing, render, type TemplateResult } from "lit";
import { CornerDownLeft, Search } from "lucide";
import { api, userSendMessage, type CoreSession } from "./core-bridge";
import { startNewChat } from "./sessions";
import { recencyGroup } from "./session-list";
import { searchGroup } from "./search-group";
import { slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { openSession, refreshSessions, sessionsState, sessionTitle } from "./sessions";
import { destinations } from "./browse";
import { UI_BASE } from "./deep-link";
import { resourceResults, matchResources, type ResourceHit, type ResourceSearchResponse } from "./search-resources";
import { icon } from "./ui";
import { matchesPrimaryShortcut } from "./shortcut";

interface ChatSearchHit {
  sessionId: string;
  title: string | null;
  scopeId: string;
  channelName?: string;
  surface?: string;
  seq: number;
  entryType: string;
  author?: string;
  snippet: string;
  createdAt: number;
  archived?: boolean;
}

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 150;
export const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);

const searchState = {
  open: false,
  query: "",
  hits: [] as ChatSearchHit[],
  resources: [] as ResourceHit[],
  resourceFailures: [] as string[],
  resourcesLoading: false,
  resourcesLimited: false,
  failed: false,
  loading: false,
  sel: 0,
  selectionMoved: false,
};

let host: HTMLDivElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let fetchSeq = 0;

export function registerChatSearchHotkey(): void {
  document.addEventListener("keydown", (e) => {
    if (matchesPrimaryShortcut(e, "k", isMac)) {
      e.preventDefault();
      if (searchState.open) closeChatSearch();
      else openChatSearch();
    }
  });
}

export function openChatSearch(): void {
  if (searchState.open) return;
  searchState.open = true;
  searchState.query = "";
  searchState.hits = [];
  searchState.loading = false;
  searchState.failed = false;
  searchState.sel = 0;
  searchState.selectionMoved = false;
  searchState.resources = [];
  searchState.resourceFailures = [];
  searchState.resourcesLimited = false;
  searchState.resourcesLoading = false;
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLInputElement>(".chat-search-input")?.focus());
}

function closeChatSearch(): void {
  if (!searchState.open) return;
  searchState.open = false;
  fetchSeq++;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  inflight?.abort();
  inflight = null;
  draw();
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "chat-search-host";
    document.body.appendChild(host);
  }
  return host;
}

function draw(): void {
  render(searchState.open ? paletteTpl() : nothing, ensureHost());
}

function resourceHits(): ResourceHit[] {
  const shortcuts = destinations().map((d) => ({ title: d.label, description: d.blurb, group: "Go to", href: d.href }));
  return [...matchResources(shortcuts, searchState.query), ...searchState.resources];
}

function openResource(hit: ResourceHit): void {
  closeChatSearch();
  location.assign(hit.href);
}

function rowCount(): number {
  return resourceHits().length + searchState.hits.length + (askRowShown() ? 1 : 0);
}

function askRowShown(): boolean {
  return searchState.query.trim().length > 0;
}

function clampSel(): void {
  searchState.sel = Math.max(0, Math.min(searchState.sel, rowCount() - 1));
}

function onQueryInput(e: InputEvent): void {
  searchState.query = (e.currentTarget as HTMLInputElement).value;
  searchState.sel = 0;
  searchState.selectionMoved = false;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  fetchSeq++;
  inflight?.abort();
  inflight = null;
  searchState.hits = [];
  searchState.resources = [];
  searchState.resourceFailures = [];
  searchState.resourcesLimited = false;
  searchState.resourcesLoading = false;
  searchState.failed = false;
  const q = searchState.query.trim();
  if (q.length < MIN_QUERY_LEN) {
    searchState.loading = false;
    draw();
    return;
  }
  searchState.loading = true;
  searchState.resourcesLoading = true;
  draw();
  debounceTimer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
}

async function runSearch(q: string): Promise<void> {
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  const seq = ++fetchSeq;
  void runResourceSearch(q, ctl, seq);
  try {
    const r = await api<{ hits: ChatSearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
    if (seq !== fetchSeq || !searchState.open) return;
    const hits = groupHitsBySession(r.hits ?? []);
    if (searchState.selectionMoved && searchState.sel === resourceHits().length + searchState.hits.length) {
      searchState.sel += hits.length - searchState.hits.length;
    }
    searchState.hits = hits;
    searchState.failed = false;
  } catch {
    if (seq !== fetchSeq || ctl.signal.aborted) return;
    searchState.hits = [];
    searchState.failed = true;
  }
  searchState.loading = false;
  clampSel();
  draw();
}

async function runResourceSearch(q: string, ctl: AbortController, seq: number): Promise<void> {
  try {
    const response = await api<ResourceSearchResponse>(`/api/resources/search?q=${encodeURIComponent(q)}`, {
      signal: ctl.signal,
    });
    if (seq !== fetchSeq || !searchState.open) return;
    const result = resourceResults(response, UI_BASE);
    const resourceCount = resourceHits().length;
    if (
      searchState.sel >= resourceCount &&
      (searchState.selectionMoved || searchState.sel < resourceCount + searchState.hits.length)
    ) {
      searchState.sel += result.hits.length - searchState.resources.length;
    }
    searchState.resources = result.hits;
    searchState.resourcesLimited = Boolean(response.limited?.length);
    searchState.resourceFailures = result.failed;
  } catch {
    if (seq !== fetchSeq || ctl.signal.aborted) return;
    searchState.resourceFailures = ["resources"];
  }
  searchState.resourcesLoading = false;
  clampSel();
  draw();
}

function groupHitsBySession(hits: ChatSearchHit[]): ChatSearchHit[] {
  const order: string[] = [];
  const bySession = new Map<string, ChatSearchHit[]>();
  for (const hit of hits) {
    const list = bySession.get(hit.sessionId);
    if (list) list.push(hit);
    else {
      order.push(hit.sessionId);
      bySession.set(hit.sessionId, [hit]);
    }
  }
  const live = order.filter((id) => !bySession.get(id)![0]!.archived);
  const archived = order.filter((id) => bySession.get(id)![0]!.archived);
  return [...live, ...archived].flatMap((id) => bySession.get(id)!);
}

function onPaletteKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeChatSearch();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const count = rowCount();
    if (!count) return;
    searchState.selectionMoved = true;
    searchState.sel = (searchState.sel + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
    draw();
    scrollSelectedIntoView();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) return void askQm();
    const resources = resourceHits();
    const resource = resources[searchState.sel];
    if (resource) return openResource(resource);
    if (searchState.loading) return;
    const hit = searchState.hits[searchState.sel - resources.length];
    if (hit) return void openHit(hit);
    if (
      !searchState.resourcesLoading &&
      askRowShown() &&
      searchState.sel === resources.length + searchState.hits.length
    )
      return void askQm();
  }
}

function scrollSelectedIntoView(): void {
  host?.querySelector(".chat-search-row.selected")?.scrollIntoView({ block: "nearest" });
}

async function openHit(hit: ChatSearchHit): Promise<void> {
  const find = (): CoreSession | undefined => sessionsState.list.find((s) => s.id === hit.sessionId);
  let session = find();
  if (!session) {
    await refreshSessions({ silent: true });
    session = find();
  }
  if (!session) return;
  closeChatSearch();
  await openSession(session);
}

function askQm(): void {
  const q = searchState.query.trim();
  if (!q) return;
  closeChatSearch();
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Find the chat, skill, cron, app, or other resource matching this search query and give me a link: ${q}`,
    ),
  );
}

function highlight(text: string): TemplateResult {
  const terms = searchState.query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!terms.length) return html`${text}`;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const parts = text.split(re);
  return html`${parts.map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : html`${part}`))}`;
}

function hitSnippet(hit: ChatSearchHit): string {
  return hit.surface === "slack" ? slackWireToPlain(stripSlackDirectives(hit.snippet)) : hit.snippet;
}

function hitTitle(hit: ChatSearchHit): string {
  if (hit.title?.trim()) return hit.title;
  const session = sessionsState.list.find((s) => s.id === hit.sessionId);
  return session ? sessionTitle(session) : (hit.channelName ?? "Untitled chat");
}

function resultRows(): TemplateResult[] {
  const rows: TemplateResult[] = [];
  let lastSession: string | null = null;
  searchState.hits.forEach((hit, index) => {
    const i = resourceHits().length + index;
    if (hit.sessionId !== lastSession) {
      lastSession = hit.sessionId;
      rows.push(searchGroup(hitTitle(hit), Boolean(hit.archived), recencyGroup(hit.createdAt)));
    }
    rows.push(html`
      <button
        type="button"
        class="chat-search-row ${i === searchState.sel ? "selected" : ""} ${hit.archived ? "archived" : ""}"
        @click=${() => void openHit(hit)}
        @pointermove=${() => {
          if (searchState.sel !== i) {
            searchState.selectionMoved = true;
            searchState.sel = i;
            draw();
          }
        }}
      >
        <span class="chat-search-who ${hit.entryType === "user" ? "user" : "agent"}" dir="auto"
          >${(hit.entryType === "user" ? (hit.author ?? "You") : "QM").slice(0, 1).toUpperCase()}</span
        >
        <span class="chat-search-text">
          <span class="chat-search-snippet" dir="auto">${highlight(hitSnippet(hit))}</span>
          <span class="chat-search-meta"
            ><bdi>${hit.entryType === "user" ? (hit.author ?? "you") : "agent"}</bdi> ·
            ${new Date(hit.createdAt).toLocaleDateString()}</span
          >
        </span>
      </button>
    `);
  });
  return rows;
}

function resourceRows(): TemplateResult[] {
  let group = "";
  return resourceHits().flatMap((hit, i) => {
    const heading = group !== hit.group ? [searchGroup(hit.group, false, "")] : [];
    group = hit.group;
    return [
      ...heading,
      html`<button
        type="button"
        class="chat-search-row ${i === searchState.sel ? "selected" : ""}"
        @click=${() => openResource(hit)}
        @pointermove=${() => {
          if (searchState.sel !== i) {
            searchState.selectionMoved = true;
            searchState.sel = i;
            draw();
          }
        }}
      >
        <span class="chat-search-who">${icon(Search, 14)}</span>
        <span class="chat-search-text"
          ><span class="chat-search-snippet">${highlight(hit.title)}</span>
          <span class="chat-search-meta chat-search-snippet">${highlight(hit.description)}</span></span
        >
      </button>`,
    ];
  });
}

function askRow(): TemplateResult {
  const i = resourceHits().length + searchState.hits.length;
  return html`
    <button
      type="button"
      class="chat-search-row chat-search-ask ${searchState.sel === i ? "selected" : ""}"
      @click=${() => askQm()}
      @pointermove=${() => {
        if (searchState.sel !== i) {
          searchState.selectionMoved = true;
          searchState.sel = i;
          draw();
        }
      }}
    >
      <span class="chat-search-who ask">+</span>
      <span class="chat-search-text">
        <span class="chat-search-snippet">Ask QM to find it: <b dir="auto">“${searchState.query.trim()}”</b></span>
        <span class="chat-search-meta">starts a new chat where QM finds the matching resource and links it</span>
      </span>
      <span class="chat-search-kbd">${isMac ? "⌘" : "Ctrl"}${icon(CornerDownLeft, 11)}</span>
    </button>
  `;
}

function paletteTpl(): TemplateResult {
  const q = searchState.query.trim();
  let body: TemplateResult | typeof nothing;
  if (q.length < MIN_QUERY_LEN) {
    body = nothing;
  } else if (searchState.loading && !searchState.hits.length) {
    body = html`<div class="chat-search-empty">Searching…</div>`;
  } else if (searchState.failed) {
    body = html`<div class="chat-search-empty chat-search-failed">Search failed. Try again.</div>`;
  } else if (resourceHits().length || searchState.resourcesLoading) {
    body = html`${resultRows()}`;
  } else if (!searchState.hits.length) {
    body = html`<div class="chat-search-empty">No results match “${q}”.</div>`;
  } else {
    body = html`${resultRows()}`;
  }
  return html`
    <div
      class="chat-search-overlay"
      @pointerdown=${(e: PointerEvent) => {
        if (e.target === e.currentTarget) closeChatSearch();
      }}
    >
      <div class="chat-search-palette" role="dialog" aria-label="Search QM" @keydown=${onPaletteKeydown}>
        <div class="chat-search-inputrow">
          ${icon(Search, 16)}
          <input
            class="chat-search-input"
            type="text"
            placeholder="Search chats, skills, crons, apps…"
            autocomplete="off"
            spellcheck="false"
            .value=${searchState.query}
            @input=${onQueryInput}
          />
          <span class="chat-search-kbd">esc</span>
          <button class="chat-search-cancel" type="button" @click=${closeChatSearch}>Cancel</button>
        </div>
        <div class="chat-search-results">
          ${resourceRows()}
          ${searchState.resourcesLoading ? html`<div class="chat-search-empty">Loading resources…</div>` : nothing}
          ${searchState.resourceFailures.length ? html`<div class="chat-search-empty chat-search-failed">Could not search: ${searchState.resourceFailures.join(", ")}. Try searching again.</div>` : nothing}
          ${searchState.resourcesLimited ? html`<div class="chat-search-empty">Refine your search to see more resource matches.</div>` : nothing}
          ${body}
        </div>
        ${askRowShown() ? html`<div class="chat-search-askbar">${askRow()}</div>` : nothing}
        <div class="chat-search-foot">
          <span><span class="chat-search-kbd">↑↓</span> navigate</span>
          <span><span class="chat-search-kbd">↵</span> open</span>
          <span><span class="chat-search-kbd">${isMac ? "⌘↵" : "Ctrl+↵"}</span> ask QM in a new chat</span>
        </div>
      </div>
    </div>
  `;
}
