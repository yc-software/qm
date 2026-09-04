/** Chat search — a ⌘K palette over every conversation the viewer can see.
 *
 * Results come from the core's Postgres full-text index and are grouped by
 * session, newest first. Enter opens the selected conversation; ⌘/Ctrl+Enter
 * (or the pinned bottom row) pipes the query to QM as the prompt of a new
 * chat, so a fruitless search becomes a question.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import { CornerDownLeft, Search } from "lucide";
import { api, type CoreSession } from "./core-bridge";
import { mainConversation } from "./conversations";
import { recencyGroup } from "./session-list";
import { openSession, refreshSessions, sessionsState, sessionTitle } from "./sessions";
import { icon } from "./ui";

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
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
export const SEARCH_HOTKEY_LABEL = isMac ? "⌘K" : "Ctrl+K";

const searchState = {
  open: false,
  query: "",
  hits: [] as ChatSearchHit[],
  failed: false,
  loading: false,
  /** Selection over hits (0..hits.length-1) plus the trailing ask-QM row. */
  sel: 0,
};

let host: HTMLDivElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let fetchSeq = 0;

export function registerChatSearchHotkey(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "k" && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
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
  searchState.sel = 0;
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLInputElement>(".chat-search-input")?.focus());
}

function closeChatSearch(): void {
  if (!searchState.open) return;
  searchState.open = false;
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

function rowCount(): number {
  return searchState.hits.length + (askRowShown() ? 1 : 0);
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
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = searchState.query.trim();
  if (q.length < MIN_QUERY_LEN) {
    inflight?.abort();
    inflight = null;
    searchState.hits = [];
    searchState.failed = false;
    searchState.loading = false;
    draw();
    return;
  }
  searchState.loading = true;
  draw();
  debounceTimer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
}

async function runSearch(q: string): Promise<void> {
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  const seq = ++fetchSeq;
  try {
    const r = await api<{ hits: ChatSearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
    if (seq !== fetchSeq || !searchState.open) return;
    searchState.hits = groupHitsBySession(r.hits ?? []);
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

/** Cluster hits by session (sessions ordered by their newest hit) so a
 * conversation never fragments into repeated group headers. */
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
    searchState.sel = (searchState.sel + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
    draw();
    scrollSelectedIntoView();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) return void askQm();
    const hit = searchState.hits[searchState.sel];
    if (hit) return void openHit(hit);
    if (askRowShown() && searchState.sel === searchState.hits.length) return void askQm();
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
  const conv = mainConversation();
  conv.newChat();
  void conv.state.agent?.prompt(
    `Find my previous session based on the following search query, give me a link when you've identified it: ${q}`,
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

function hitTitle(hit: ChatSearchHit): string {
  if (hit.title?.trim()) return hit.title;
  const session = sessionsState.list.find((s) => s.id === hit.sessionId);
  return session ? sessionTitle(session) : (hit.channelName ?? "Untitled chat");
}

function resultRows(): TemplateResult[] {
  const rows: TemplateResult[] = [];
  let lastSession: string | null = null;
  searchState.hits.forEach((hit, i) => {
    if (hit.sessionId !== lastSession) {
      lastSession = hit.sessionId;
      rows.push(
        html`<div class="chat-search-group ${hit.archived ? "archived" : ""}">
          <b>${hitTitle(hit)}</b
          >${hit.archived ? html`<em class="chat-search-archived-tag">Archived</em>` : nothing}<span
            >${recencyGroup(hit.createdAt)}</span
          >
        </div>`,
      );
    }
    rows.push(html`
      <button
        type="button"
        class="chat-search-row ${i === searchState.sel ? "selected" : ""} ${hit.archived ? "archived" : ""}"
        @click=${() => void openHit(hit)}
        @pointermove=${() => {
          if (searchState.sel !== i) {
            searchState.sel = i;
            draw();
          }
        }}
      >
        <span class="chat-search-who ${hit.entryType === "user" ? "user" : "agent"}"
          >${(hit.entryType === "user" ? (hit.author ?? "You") : "QM").slice(0, 1).toUpperCase()}</span
        >
        <span class="chat-search-text">
          <span class="chat-search-snippet">${highlight(hit.snippet)}</span>
          <span class="chat-search-meta"
            >${hit.entryType === "user" ? (hit.author ?? "you") : "agent"} ·
            ${new Date(hit.createdAt).toLocaleDateString()}</span
          >
        </span>
      </button>
    `);
  });
  return rows;
}

function askRow(): TemplateResult {
  const i = searchState.hits.length;
  return html`
    <button
      type="button"
      class="chat-search-row chat-search-ask ${searchState.sel === i ? "selected" : ""}"
      @click=${() => askQm()}
      @pointermove=${() => {
        if (searchState.sel !== i) {
          searchState.sel = i;
          draw();
        }
      }}
    >
      <span class="chat-search-who ask">+</span>
      <span class="chat-search-text">
        <span class="chat-search-snippet">Ask QM to find it: <b>“${searchState.query.trim()}”</b></span>
        <span class="chat-search-meta">starts a new chat where QM hunts down the matching session and links it</span>
      </span>
      <span class="chat-search-kbd">${isMac ? "⌘" : "Ctrl"}${icon(CornerDownLeft, 11)}</span>
    </button>
  `;
}

function paletteTpl(): TemplateResult {
  const q = searchState.query.trim();
  let body: TemplateResult;
  if (q.length < MIN_QUERY_LEN) {
    body = html`<div class="chat-search-empty">Search every chat you can see — messages, not just titles.</div>`;
  } else if (searchState.loading && !searchState.hits.length) {
    body = html`<div class="chat-search-empty">Searching…</div>`;
  } else if (searchState.failed) {
    body = html`<div class="chat-search-empty chat-search-failed">
      Search failed — check the connection and try again.
    </div>`;
  } else if (!searchState.hits.length) {
    body = html`<div class="chat-search-empty">No messages match “${q}”.</div>`;
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
      <div class="chat-search-palette" role="dialog" aria-label="Search your chats" @keydown=${onPaletteKeydown}>
        <div class="chat-search-inputrow">
          ${icon(Search, 16)}
          <input
            class="chat-search-input"
            type="text"
            placeholder="Search your chats…"
            autocomplete="off"
            spellcheck="false"
            .value=${searchState.query}
            @input=${onQueryInput}
          />
          <span class="chat-search-kbd">esc</span>
        </div>
        <div class="chat-search-results">${body}</div>
        ${askRowShown() ? html`<div class="chat-search-askbar">${askRow()}</div>` : nothing}
        <div class="chat-search-foot">
          <span><span class="chat-search-kbd">↑↓</span> navigate</span>
          <span><span class="chat-search-kbd">↵</span> open chat</span>
          <span><span class="chat-search-kbd">${isMac ? "⌘↵" : "Ctrl+↵"}</span> ask QM in a new chat</span>
        </div>
      </div>
    </div>
  `;
}
