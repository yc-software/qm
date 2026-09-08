import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCheck, ChevronDown, ChevronRight, Hash, Mail, PenLine } from "lucide";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import type { Conversation } from "./conv-types";
import type { DensityTier } from "./density";
import {
  attachInboxSurface,
  contextTpl,
  draftEditorTpl,
  handledNoteTpl,
  inboxOpenCount,
  inboxState,
  inboxViewName,
  itemsFor,
  persistDraft,
  refreshInbox,
  selectInboxView,
  type InboxItem,
} from "./inbox";
import { openSessionInto, refreshSessions, sessionsReady, sessionsState } from "./sessions";
import { switchView } from "./shell";
import { appState, can } from "./shell-state";
import { registerPaneKind } from "./pane-kinds";
import { exitSplitIfActive, splitState } from "./split";
import { icon, relTime } from "./ui";

interface SteerPanel {
  sessionId: string;
  host: HTMLElement;
  conversation: Conversation;
  open: boolean;
  working: boolean;
}

interface ReviewSurface {
  host: HTMLElement;
  viewId: string;
  density: () => DensityTier;
  tab: "open" | "handled";
  selectedId: string | null;
  steer: SteerPanel | null;
}

function mountDraftReviewPane(opts: {
  host: HTMLElement;
  viewId: string;
  density: () => DensityTier;
  onDensityChange: (handler: () => void) => void;
}): { dispose(): void } {
  const surface: ReviewSurface = {
    host: opts.host,
    viewId: opts.viewId,
    density: opts.density,
    tab: "open",
    selectedId: null,
    steer: null,
  };
  opts.host.classList.add("draft-review-pane-host");
  opts.onDensityChange(() => drawSurface(surface));
  const detach = attachInboxSurface({
    redraw: () => drawSurface(surface),
    visible: () => surface.host.isConnected,
  });
  drawSurface(surface);
  void refreshInbox({ ifStaleMs: 30_000, silent: true });
  return {
    dispose() {
      detach();
      dropSteer(surface);
      opts.host.classList.remove("draft-review-pane-host");
    },
  };
}

function reviewRows(surface: ReviewSurface): InboxItem[] {
  const rows = [...itemsFor(surface.viewId, surface.tab)];
  const at = (i: InboxItem): number =>
    surface.tab === "open" ? i.receivedAt : (i.sentAt ?? i.dismissedAt ?? i.receivedAt);
  return rows.sort((a, b) => at(b) - at(a));
}

function drawSurface(surface: ReviewSurface): void {
  if (!surface.host.isConnected) return;
  const rows = reviewRows(surface);
  const item = rows.find((i) => i.id === surface.selectedId) ?? rows[0] ?? null;
  surface.selectedId = item?.id ?? null;
  syncSteer(surface, item);
  render(surfaceTpl(surface, rows, item), surface.host);
}

function pickItem(surface: ReviewSurface, item: InboxItem): void {
  const previous = inboxState.items.find((i) => i.id === surface.selectedId);
  if (previous && previous.id !== item.id) void persistDraft(previous);
  surface.selectedId = item.id;
  drawSurface(surface);
}

function syncSteer(surface: ReviewSurface, item: InboxItem | null): void {
  const sessionId = item?.status === "open" ? (item.draftSessionId ?? null) : null;
  if (!sessionId) {
    dropSteer(surface);
    return;
  }
  if (surface.steer?.sessionId === sessionId) return;
  dropSteer(surface);
  const host = document.createElement("div");
  host.className = "mini-convo-body";
  host.dataset.density = "compact";
  const steer: SteerPanel = {
    sessionId,
    host,
    conversation: null as unknown as Conversation,
    open: true,
    working: false,
  };
  steer.conversation = createConversation({
    pane: true,
    ownsUrl: false,
    container: () => host,
    claimContainer: () => host,
    visible: () => splitState.active && appState.currentView === "chats" && surface.host.isConnected,
    density: () => "compact" as DensityTier,
    onDensityChange: () => {},
    ensureDeliveryStream,
    onState: (state) => {
      if (steer.working && !state.working) void refreshInbox({ silent: true });
      steer.working = state.working;
    },
  });
  surface.steer = steer;
  void mountSteerSession(surface, steer);
}

function dropSteer(surface: ReviewSurface): void {
  if (!surface.steer) return;
  disposeConversation(surface.steer.conversation);
  surface.steer = null;
}

async function mountSteerSession(surface: ReviewSurface, steer: SteerPanel): Promise<void> {
  steer.conversation.mountLoadingPane();
  const find = (): (typeof sessionsState.list)[number] | undefined =>
    sessionsState.list.find((s) => s.id === steer.sessionId);
  let session = find();
  if (!session) {
    await sessionsReady();
    session = find();
  }
  if (!session) {
    try {
      await refreshSessions({ silent: true });
    } catch {
      void 0;
    }
    session = find();
  }
  if (surface.steer !== steer) return;
  if (!session) {
    render(html`<div class="mini-convo-missing">The drafting session isn't available anymore.</div>`, steer.host);
    return;
  }
  await openSessionInto(steer.conversation, session);
}

function toggleSteer(surface: ReviewSurface): void {
  const steer = surface.steer;
  if (!steer) return;
  steer.open = !steer.open;
  drawSurface(surface);
  if (steer.open) steer.conversation.redraw();
}

function segTpl(surface: ReviewSurface, open: number, handled: number): TemplateResult {
  const btn = (tab: ReviewSurface["tab"], label: string, count: number): TemplateResult => html`
    <button
      class="rv-seg-btn ${surface.tab === tab ? "on" : ""}"
      type="button"
      role="tab"
      aria-selected=${surface.tab === tab ? "true" : "false"}
      @click=${() => {
        surface.tab = tab;
        drawSurface(surface);
      }}
    >
      <span>${label}</span><span class="rv-seg-count">${count}</span>
    </button>
  `;
  return html`<div class="rv-seg" role="tablist" aria-label="Draft review">
    ${btn("open", "Needs you", open)} ${btn("handled", "Handled", handled)}
  </div>`;
}

function rowTpl(surface: ReviewSurface, item: InboxItem): TemplateResult {
  const gmail = item.source === "gmail";
  const active = surface.selectedId === item.id;
  return html`
    <button class="rv-row ${active ? "active" : ""}" type="button" @click=${() => pickItem(surface, item)}>
      <span class="rv-glyph">${icon(gmail ? Mail : Hash, 13)}</span>
      <span class="rv-body">
        <span class="rv-l1">
          <span class="rv-from">${gmail ? item.from : (item.slack?.channelLabel ?? item.title)}</span>
          <span class="rv-time"
            >${relTime(
              surface.tab === "open"
                ? item.receivedAt
                : (item.sentAt ?? item.dismissedAt ?? item.repliedAt ?? item.receivedAt),
            )}</span
          >
        </span>
        <span class="rv-l2">${gmail ? item.title : item.from}</span>
      </span>
      ${
        item.status === "open" && item.draft
          ? html`<span class="rv-drafted" title="A reply is drafted and ready">${icon(CheckCheck, 12)}</span>`
          : nothing
      }
    </button>
  `;
}

function steerTpl(surface: ReviewSurface, item: InboxItem): TemplateResult | typeof nothing {
  const steer = surface.steer;
  if (!steer || steer.sessionId !== item.draftSessionId) return nothing;
  return html`<div class="mini-convo">
    <button
      class="mini-convo-head"
      type="button"
      aria-expanded=${steer.open ? "true" : "false"}
      @click=${() => toggleSteer(surface)}
    >
      <span class="mini-convo-caret">${icon(steer.open ? ChevronDown : ChevronRight, 12)}</span>
      <span class="mini-convo-title">Drafting session</span>
      <span class="mini-convo-sub">steer it and the draft rewrites in place</span>
      <span class="mini-convo-spacer"></span>
      <span class="mini-convo-open">${steer.open ? "Hide" : "Resume"}</span>
    </button>
    ${steer.open ? steer.host : nothing}
  </div>`;
}

function detailTpl(surface: ReviewSurface, item: InboxItem | null): TemplateResult {
  if (!item) {
    return html`<div class="empty compact rv-empty-detail">
      ${surface.tab === "open" ? "Nothing is waiting on you. Clear water ahead." : "Nothing handled yet."}
    </div>`;
  }
  const gmail = item.source === "gmail";
  return html`
    <div class="rv-detail-head">
      <span class="rv-detail-title">${gmail ? item.title : (item.slack?.channelLabel ?? item.title)}</span>
      <span class="rv-detail-from">${item.from}${item.fromDetail ? ` · ${item.fromDetail}` : ""}</span>
    </div>
    ${contextTpl(item)} ${item.status === "open" ? draftEditorTpl(item) : handledNoteTpl(item)}
    ${item.status === "open" ? steerTpl(surface, item) : nothing}
  `;
}

function surfaceTpl(surface: ReviewSurface, rows: InboxItem[], item: InboxItem | null): TemplateResult {
  const density = surface.density();
  const compact = density !== "full";
  const open = itemsFor(surface.viewId, "open").length;
  const handled = itemsFor(surface.viewId, "handled").length;
  return html`
    <div class="draft-review-surface ${compact ? "compact" : ""}" data-density=${density}>
      <div class="rv-side">
        ${segTpl(surface, open, handled)}
        <div class="rv-scroll">
          ${
            rows.length
              ? rows.map((row) => rowTpl(surface, row))
              : html`<div class="rv-empty">${surface.tab === "open" ? "Nothing needs you." : "Nothing here yet."}</div>`
          }
        </div>
      </div>
      <div class="rv-main">${detailTpl(surface, item)}</div>
    </div>
  `;
}

registerPaneKind({
  paramsKey: "draftReview",
  glyph: PenLine,
  title: (id) => (id === "all" ? "Draft review" : `${inboxViewName(id)} drafts`),
  badge: (id) => (can("inbox") ? inboxOpenCount(id) : 0),
  mount: ({ host, id, density, onDensityChange }) => {
    if (!can("inbox")) {
      render(html`<div class="empty compact">This pane kind is not available.</div>`, host);
      return { dispose: () => render(nothing, host) };
    }
    return mountDraftReviewPane({ host, viewId: id, density, onDensityChange });
  },
  maximize: (id) => {
    exitSplitIfActive();
    selectInboxView(id);
    switchView("inbox");
  },
});
