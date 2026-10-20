import { html, nothing, render, type TemplateResult } from "lit";
import { CornerDownLeft, MessageSquare, Search } from "lucide";
import { api, userSendMessage, type CoreSession } from "./core-bridge";
import { startNewChat } from "./sessions";
import { recencyGroup } from "./session-list";
import { searchGroup } from "./search-group";
import { slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { openSession, refreshSessions, sessionsState, sessionTitle } from "./sessions";
import { destinations } from "./browse";
import { UI_BASE } from "./deep-link";
import { resourceResults, matchResources, type ResourceHit, type ResourceSearchResponse } from "./search-resources";
import { matchSessionTitles } from "./search-titles";
import { icon } from "./icons";

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

/** One selectable row, in display order. Selection follows the row's key, so
 * results that arrive late never move the highlight out from under the user. */
type Row =
  | { kind: "title"; key: string; session: CoreSession }
  | { kind: "hit"; key: string; hit: ChatSearchHit }
  | { kind: "resource"; key: string; hit: ResourceHit }
  | { kind: "ask"; key: "ask" };

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 150;
const TITLE_MATCH_LIMIT = 6;
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);

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
  /** Key of the row the user explicitly moved to; null means "the first row". */
  selKey: null as string | null,
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
  searchState.failed = false;
  searchState.selKey = null;
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

function queryReady(): boolean {
  return searchState.query.trim().length >= MIN_QUERY_LEN;
}

/** Chats whose title matches, straight from the sidebar list — no network. */
function titleSessions(): CoreSession[] {
  if (!queryReady()) return [];
  // Only names someone chose (or a channel's name) — generic labels like
  // "Web chat" would match half the sidebar.
  return matchSessionTitles(sessionsState.list, searchState.query, (s) => s.title?.trim() ?? "", TITLE_MATCH_LIMIT);
}

function resourceHits(): ResourceHit[] {
  const shortcuts = destinations().map((d) => ({ title: d.label, description: d.blurb, group: "Go to", href: d.href }));
  return [...matchResources(shortcuts, searchState.query), ...searchState.resources];
}

/** Display order: chats first (instant title matches, then message hits), then
 * everything else. Chats are what people search for most. */
function rows(): Row[] {
  return [
    ...titleSessions().map((session): Row => ({ kind: "title", key: `t:${session.id}`, session })),
    ...searchState.hits.map((hit): Row => ({ kind: "hit", key: `h:${hit.sessionId}:${hit.seq}`, hit })),
    ...resourceHits().map((hit): Row => ({ kind: "resource", key: `r:${hit.group}:${hit.href}`, hit })),
    ...(askRowShown() ? [{ kind: "ask", key: "ask" } as const] : []),
  ];
}

function selectedIndex(list: Row[] = rows()): number {
  if (searchState.selKey === null) return 0;
  const i = list.findIndex((row) => row.key === searchState.selKey);
  return i < 0 ? 0 : i;
}

function select(key: string): void {
  if (searchState.selKey === key) return;
  searchState.selKey = key;
  draw();
}

function openResource(hit: ResourceHit): void {
  closeChatSearch();
  location.assign(hit.href);
}

function askRowShown(): boolean {
  return searchState.query.trim().length > 0;
}

function onQueryInput(e: InputEvent): void {
  searchState.query = (e.currentTarget as HTMLInputElement).value;
  searchState.selKey = null;
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
    searchState.hits = groupHitsBySession(r.hits ?? []);
    searchState.failed = false;
  } catch {
    if (seq !== fetchSeq || ctl.signal.aborted) return;
    searchState.hits = [];
    searchState.failed = true;
  }
  searchState.loading = false;
  draw();
}

async function runResourceSearch(q: string, ctl: AbortController, seq: number): Promise<void> {
  try {
    const response = await api<ResourceSearchResponse>(`/api/resources/search?q=${encodeURIComponent(q)}`, {
      signal: ctl.signal,
    });
    if (seq !== fetchSeq || !searchState.open) return;
    const result = resourceResults(response, UI_BASE);
    searchState.resources = result.hits;
    searchState.resourcesLimited = Boolean(response.limited?.length);
    searchState.resourceFailures = result.failed;
  } catch {
    if (seq !== fetchSeq || ctl.signal.aborted) return;
    searchState.resourceFailures = ["resources"];
  }
  searchState.resourcesLoading = false;
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
    const list = rows();
    if (!list.length) return;
    const next = (selectedIndex(list) + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
    select(list[next]!.key);
    scrollSelectedIntoView();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) return void askQm();
    const list = rows();
    const row = list[selectedIndex(list)];
    if (!row) return;
    if (row.kind === "title") return void openSessionById(row.session.id);
    if (row.kind === "hit") return void openSessionById(row.hit.sessionId);
    if (row.kind === "resource") return openResource(row.hit);
    // The ask row is first only because nothing else has arrived yet; don't
    // start a new chat from a bare Enter until the searches have finished.
    if (searchState.selKey === "ask" || (!searchState.loading && !searchState.resourcesLoading)) askQm();
  }
}

function scrollSelectedIntoView(): void {
  host?.querySelector(".chat-search-row.selected")?.scrollIntoView({ block: "nearest" });
}

async function openSessionById(sessionId: string): Promise<void> {
  const find = (): CoreSession | undefined => sessionsState.list.find((s) => s.id === sessionId);
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

function rowButton(
  row: Row,
  index: number,
  selected: number,
  onOpen: () => void,
  body: TemplateResult,
): TemplateResult {
  const archived =
    (row.kind === "hit" && row.hit.archived) || (row.kind === "title" && row.session.archived) ? "archived" : "";
  return html`<button
    type="button"
    class="chat-search-row ${row.kind === "ask" ? "chat-search-ask" : ""} ${index === selected ? "selected" : ""} ${archived}"
    @click=${onOpen}
    @pointermove=${() => select(row.key)}
  >
    ${body}
  </button>`;
}

function titleRowTpl(row: Extract<Row, { kind: "title" }>, index: number, selected: number): TemplateResult {
  const s = row.session;
  const when = s.lastActivityAt ?? s.createdAt;
  const meta = Number.isFinite(when) ? [recencyGroup(when), new Date(when).toLocaleDateString()] : [];
  if (s.archived) meta.push("archived");
  return rowButton(
    row,
    index,
    selected,
    () => void openSessionById(s.id),
    html`<span class="chat-search-who title">${icon(MessageSquare, 13)}</span>
      <span class="chat-search-text">
        <span class="chat-search-snippet" dir="auto">${highlight(sessionTitle(s))}</span>
        <span class="chat-search-meta">${meta.join(" · ")}</span>
      </span>`,
  );
}

function hitRowTpl(row: Extract<Row, { kind: "hit" }>, index: number, selected: number): TemplateResult {
  const hit = row.hit;
  return rowButton(
    row,
    index,
    selected,
    () => void openSessionById(hit.sessionId),
    html`<span class="chat-search-who ${hit.entryType === "user" ? "user" : "agent"}" dir="auto"
        >${(hit.entryType === "user" ? (hit.author ?? "You") : "QM").slice(0, 1).toUpperCase()}</span
      >
      <span class="chat-search-text">
        <span class="chat-search-snippet" dir="auto">${highlight(hitSnippet(hit))}</span>
        <span class="chat-search-meta"
          ><bdi>${hit.entryType === "user" ? (hit.author ?? "you") : "agent"}</bdi> ·
          ${new Date(hit.createdAt).toLocaleDateString()}</span
        >
      </span>`,
  );
}

function resourceRowTpl(row: Extract<Row, { kind: "resource" }>, index: number, selected: number): TemplateResult {
  return rowButton(
    row,
    index,
    selected,
    () => openResource(row.hit),
    html`<span class="chat-search-who">${icon(Search, 14)}</span>
      <span class="chat-search-text"
        ><span class="chat-search-snippet">${highlight(row.hit.title)}</span>
        <span class="chat-search-meta chat-search-snippet">${highlight(row.hit.description)}</span></span
      >`,
  );
}

function askRowTpl(row: Extract<Row, { kind: "ask" }>, index: number, selected: number): TemplateResult {
  return rowButton(
    row,
    index,
    selected,
    () => askQm(),
    html`<span class="chat-search-who ask">+</span>
      <span class="chat-search-text">
        <span class="chat-search-snippet">Ask QM to find it: <b dir="auto">“${searchState.query.trim()}”</b></span>
        <span class="chat-search-meta">starts a new chat where QM finds the matching resource and links it</span>
      </span>
      <span class="chat-search-kbd">${isMac ? "⌘" : "Ctrl"}${icon(CornerDownLeft, 11)}</span>`,
  );
}

function status(text: string, failed = false): TemplateResult {
  return html`<div class="chat-search-status ${failed ? "chat-search-failed" : ""}">${text}</div>`;
}

function resultsTpl(list: Row[], selected: number): TemplateResult | typeof nothing {
  if (!queryReady()) return nothing;
  const out: TemplateResult[] = [];
  const titles = list.flatMap((row, i) => (row.kind === "title" ? [[row, i] as const] : []));
  const hits = list.flatMap((row, i) => (row.kind === "hit" ? [[row, i] as const] : []));
  const resources = list.flatMap((row, i) => (row.kind === "resource" ? [[row, i] as const] : []));

  if (titles.length) {
    out.push(searchGroup("Chats", false, ""));
    for (const [row, i] of titles) out.push(titleRowTpl(row, i, selected));
  }

  let lastSession: string | null = null;
  for (const [row, i] of hits) {
    if (row.hit.sessionId !== lastSession) {
      lastSession = row.hit.sessionId;
      out.push(searchGroup(hitTitle(row.hit), Boolean(row.hit.archived), recencyGroup(row.hit.createdAt)));
    }
    out.push(hitRowTpl(row, i, selected));
  }
  if (searchState.loading) out.push(status("Searching messages…"));
  else if (searchState.failed) out.push(status("Message search failed. Try again.", true));

  let group = "";
  for (const [row, i] of resources) {
    if (row.hit.group !== group) out.push(searchGroup(row.hit.group, false, ""));
    group = row.hit.group;
    out.push(resourceRowTpl(row, i, selected));
  }
  if (searchState.resourcesLoading) out.push(status("Loading skills, crons, apps…"));
  if (searchState.resourceFailures.length)
    out.push(status(`Could not search: ${searchState.resourceFailures.join(", ")}. Try searching again.`, true));
  if (searchState.resourcesLimited) out.push(status("Refine your search to see more resource matches."));

  const empty =
    !searchState.loading &&
    !searchState.resourcesLoading &&
    !searchState.failed &&
    !titles.length &&
    !hits.length &&
    !resources.length;
  if (empty) out.push(html`<div class="chat-search-empty">No results match “${searchState.query.trim()}”.</div>`);
  return html`${out}`;
}

function paletteTpl(): TemplateResult {
  const list = rows();
  const selected = selectedIndex(list);
  const askIndex = list.findIndex((row) => row.kind === "ask");
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
        <div class="chat-search-results">${resultsTpl(list, selected)}</div>
        ${
          askIndex >= 0
            ? html`<div class="chat-search-askbar">${askRowTpl({ kind: "ask", key: "ask" }, askIndex, selected)}</div>`
            : nothing
        }
        <div class="chat-search-foot">
          <span><span class="chat-search-kbd">↑↓</span> navigate</span>
          <span><span class="chat-search-kbd">↵</span> open</span>
          <span><span class="chat-search-kbd">${isMac ? "⌘↵" : "Ctrl+↵"}</span> ask QM in a new chat</span>
        </div>
      </div>
    </div>
  `;
}
