import "./side-chat.css";
import { passageOccurrence, passageRange } from "./passage-range";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { ArrowUp, ArrowUpRight, Maximize2, Minimize2, MessageSquare, X } from "lucide";
import { tip } from "./tooltip";
import { api, forkCutSeq, forkSession, type CoreSession, type SessionEntry } from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import { openSession, openSessionInto, refreshSessions } from "./sessions";
import type { Conversation, ConvCtx } from "./conv-types";
import { messageEntrySeqs } from "./message-link";
import { icon } from "./icons";
import { errMessage } from "../../chassis/src/errors";
import { reportHandledError } from "./browser-errors";

export function createSideChatController(ctx: ConvCtx) {
  let sourceId: string | null = null;
  let chats: CoreSession[] = [];
  type SelectionAnchor = {
    index: number;
    quote: string;
    occurrence: number;
    left: number;
    top: number;
    panelTop: number;
  };
  let selected: SelectionAnchor | null = null;
  let active: CoreSession | null = null;
  let conversation: Conversation | null = null;
  let panel: HTMLElement | null = null;
  let busy = false;
  let selecting = false;
  let pendingAnchor: SelectionAnchor | null = null;
  let pendingQuote: string | null = null;
  let pendingDraft = "";
  let maximized = false;
  let includeExcerpt = true;
  let cardLeft = 16;
  let cardTop = 16;
  let moved = false;
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  let error = "";
  let epoch = 0;
  const redraw = () => ctx.chat.drawActiveChat();
  const panelId = `side-chat-${crypto.randomUUID()}`;
  let returnFocus: HTMLElement | null = null;
  const anchors = new Map<HTMLElement, { session: CoreSession; range: Range }[]>();
  const observedRows = new Map<HTMLElement, HTMLElement>();
  let hovered: string | undefined;
  let choices = new Set<string>();
  const highlightResize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => paintHighlights());
  function paintHighlights() {
    for (const [host, entries] of anchors) {
      if (!host.isConnected) {
        highlightResize?.unobserve(host);
        const row = observedRows.get(host);
        if (row) highlightResize?.unobserve(row);
        observedRows.delete(host);
        anchors.delete(host);
        continue;
      }
      const origin = host.getBoundingClientRect();
      const shapes = entries.flatMap(({ session, range }) => {
        const lines: Array<{ left: number; right: number; top: number; bottom: number }> = [];
        for (const rect of Array.from(range.getClientRects?.() ?? [])) {
          if (!rect.width || !rect.height) continue;
          const line = lines.find(
            (line) => Math.abs(line.top - rect.top) < 3 && rect.left <= line.right + 2 && rect.right >= line.left - 2,
          );
          if (line) {
            line.left = Math.min(line.left, rect.left);
            line.right = Math.max(line.right, rect.right);
            line.bottom = Math.max(line.bottom, rect.bottom);
          } else lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
        return lines.map((line, index) => ({ session, index, line }));
      });
      const existing = new Map(
        Array.from(host.querySelectorAll<HTMLElement>(".side-chat-highlight")).map((element) => [
          element.dataset.key,
          element,
        ]),
      );
      for (const { session, index, line } of shapes) {
        const key = `${session.id}:${index}`;
        const element = existing.get(key) ?? document.createElement("span");
        element.dataset.key = key;
        element.className = `side-chat-highlight${session.id === active?.id ? " active" : ""}${session.id === hovered ? " hovered" : ""}`;
        element.setAttribute("aria-hidden", "true");
        element.style.left = `${line.left - origin.left - 3}px`;
        element.style.top = `${line.top - origin.top - 1}px`;
        element.style.width = `${line.right - line.left + 6}px`;
        element.style.height = `${line.bottom - line.top + 2}px`;
        if (!element.isConnected) host.append(element);
        existing.delete(key);
      }
      for (const element of existing.values()) element.remove();
    }
  }
  function anchorsAt(event: MouseEvent) {
    return [...anchors.values()]
      .flat()
      .filter(({ range }) =>
        [...range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left - 3 &&
            event.clientX <= rect.right + 3 &&
            event.clientY >= rect.top - 1 &&
            event.clientY <= rect.bottom + 1,
        ),
      );
  }

  function dismissSelection() {
    if ((!selected && !choices.size) || busy) return;
    selected = null;
    choices.clear();
    redraw();
  }

  function dismiss() {
    const target = returnFocus;
    close();
    redraw();
    if (target?.isConnected) target.focus({ preventScroll: true });
    else ctx.composer.focusComposerEnd();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (selected || choices.size) {
      event.preventDefault();
      event.stopPropagation();
      dismissSelection();
    }
  }

  function panelKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (conversation?.composer.closeMenus()) conversation.drawActiveChat();
    else dismiss();
  }

  function outsidePointerDown(event: Event) {
    const card = panel?.closest(".side-chat-panel");
    if (!card || event.composedPath().includes(card)) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".side-chat-error")?.parentElement === card.parentElement
    )
      return;
    close();
    redraw();
  }

  function refreshHighlights() {
    const id = sourceId;
    if (!id) return;
    void api<{ sessions: CoreSession[] }>(`/api/sessions/${encodeURIComponent(id)}/side-chats`).then(
      (result) => {
        if (sourceId !== id) return;
        chats = result.sessions ?? [];
        redraw();
      },
      (cause) => {
        reportHandledError("web:side_chat_list", cause);
        if (sourceId !== id) return;
        error = errMessage(cause, "Could not load side chats.");
        redraw();
      },
    );
  }

  function close() {
    if (active) refreshHighlights();
    pendingQuote = null;
    pendingAnchor = null;
    pendingDraft = "";
    document.removeEventListener("pointerdown", outsidePointerDown, true);
    epoch++;
    busy = false;
    choices.clear();
    drag = null;
    moved = false;
    if (conversation) disposeConversation(conversation);
    conversation = null;
    active = null;
    panel = null;
    selected = null;
  }

  function sync() {
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("mousedown", selectionStarted, true);
    document.addEventListener("mouseup", selectionEnded, true);
    const id = ctx.chat.state.sessionId;
    if (id === sourceId) return;
    close();
    sourceId = id;
    highlightResize?.disconnect();
    observedRows.clear();
    for (const host of anchors.keys())
      host.querySelectorAll(".side-chat-highlight").forEach((element) => element.remove());
    anchors.clear();
    paintHighlights();
    chats = [];
    error = "";
    busy = false;
    refreshHighlights();
  }

  function selectionStarted(event: MouseEvent) {
    if (event.button !== 0) return;
    selecting = true;
    if (event.target instanceof Element && event.target.closest(".message-row[data-index]")) dismissSelection();
  }

  function selectionEnded() {
    const wasSelecting = selecting;
    selecting = false;
    if (wasSelecting) selectionChanged(new Event("selectionchange"));
  }

  const selectionChanged = (event: Event) =>
    select(event, ctx.chat.state.host?.querySelector<HTMLElement>(".chat-scroll") ?? null);

  function select(event: Event, selectionHost?: HTMLElement | null) {
    if (event.target instanceof Element && event.target.closest("button, textarea, input, [contenteditable]")) return;
    const selection = window.getSelection();
    const host = selectionHost === undefined ? (event.currentTarget as HTMLElement) : selectionHost;
    if (!host || busy || selecting) return;
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount ||
      (event instanceof KeyboardEvent && event.key === "Escape")
    ) {
      dismissSelection();
      if (event instanceof MouseEvent && event.type === "mouseup" && selection?.isCollapsed) {
        const matching = anchorsAt(event);
        const anchor = matching[0];
        if (anchor) {
          returnFocus = anchor.range.startContainer.parentElement?.closest<HTMLElement>(".message-row") ?? null;
          if (returnFocus) returnFocus.tabIndex = -1;
          if (matching.length > 1) {
            choices = new Set(matching.map(({ session }) => session.id));
            redraw();
          } else void show(anchor.session);
        }
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const element = range.startContainer.parentElement;
    const row = element?.closest<HTMLElement>(".message-row[data-index]");
    if (
      !row ||
      !host.contains(row) ||
      !row.contains(range.endContainer) ||
      element?.closest("button, textarea, input, [contenteditable]")
    )
      return dismissSelection();
    const messages = [...ctx.chat.state.inheritedMessages, ...(ctx.chat.state.agent?.state.messages ?? [])];
    const index = Number(row.dataset.index) + ctx.chat.state.inheritedMessages.length;
    const quote = selection.toString().trim();
    if (index < 0 || !quote || !messages[index]) return dismissSelection();
    const occurrence = passageOccurrence(row, range, quote);
    if (occurrence === null) return dismissSelection();
    const bounds = range.getBoundingClientRect();
    const layout = host.closest(".side-chat-layout")?.getBoundingClientRect();
    if (!layout) return dismissSelection();
    const top = bounds.top - layout.top;
    returnFocus = row;
    row.tabIndex = -1;
    const next = {
      index,
      quote,
      occurrence,
      left: Math.max(8, Math.min(bounds.left - layout.left, layout.width - 200)),
      top: top >= 46 ? top - 40 : bounds.bottom - layout.top + 8,
      panelTop: Math.max(12, Math.min(bounds.bottom - layout.top + 12, layout.height - 222)),
    };
    if (
      selected &&
      Object.keys(next).every((key) => selected![key as keyof typeof next] === next[key as keyof typeof next])
    )
      return;
    selected = next;
    error = "";
    redraw();
  }

  function startDrag(event: PointerEvent) {
    if (maximized || event.button !== 0 || (event.target as Element).closest("button")) return;
    const header = event.currentTarget as HTMLElement;
    const card = header.closest<HTMLElement>(".side-chat-panel")!;
    const layout = card.parentElement!.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: bounds.left - layout.left, top: bounds.top - layout.top };
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
    card.classList.add("dragging");
  }

  function moveDrag(event: PointerEvent) {
    if (!drag) return;
    const header = event.currentTarget as HTMLElement;
    const card = header.closest<HTMLElement>(".side-chat-panel")!;
    const layout = card.parentElement!.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    cardLeft = Math.max(12, Math.min(drag.left + event.clientX - drag.x, layout.width - bounds.width - 12));
    cardTop = Math.max(12, Math.min(drag.top + event.clientY - drag.y, layout.height - bounds.height - 12));
    moved = true;
    card.style.setProperty("--side-chat-left", `${cardLeft}px`);
    card.style.setProperty("--side-chat-top", `${cardTop}px`);
  }

  function endDrag(event: PointerEvent) {
    drag = null;
    const header = event.currentTarget as HTMLElement;
    header.closest(".side-chat-panel")?.classList.remove("dragging");
    if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
  }

  function positionCard() {
    if (moved) return;
    const anchor = [...anchors.values()].flat().find((entry) => entry.session.id === active?.id);
    const row = anchor?.range.startContainer.parentElement;
    const layout = row?.closest(".side-chat-layout")?.getBoundingClientRect();
    const bounds = anchor?.range.getBoundingClientRect?.();
    if (!layout || !bounds) return;
    const width = Math.min(360, layout.width - 24);
    const messageBounds = row?.closest(".message-row")?.getBoundingClientRect();
    const beside = (messageBounds?.right ?? bounds.right) - layout.left + 20;
    cardLeft =
      beside + width <= layout.width - 12
        ? beside
        : Math.max(12, Math.min(bounds.left - layout.left, layout.width - width - 12));
    const top = beside + width <= layout.width - 12 ? bounds.top : bounds.bottom + 12;
    cardTop = Math.max(12, Math.min(top - layout.top, layout.height - Math.min(440, layout.height - 24) - 12));
  }

  async function show(session: CoreSession, creating = false) {
    if (!creating) close();
    active = session;
    includeExcerpt = true;
    document.addEventListener("pointerdown", outsidePointerDown, true);
    maximized = false;
    positionCard();
    const opening = epoch;
    redraw();
    await Promise.resolve();
    if (!panel || opening !== epoch) return;
    positionCard();
    redraw();
    const conv = createConversation(
      {
        pane: true,
        ownsUrl: false,
        container: () => panel,
        claimContainer: () => panel,
        visible: () => Boolean(panel?.isConnected),
        density: () => "full",
        onDensityChange: () => {},
        ensureDeliveryStream,
      },
      { placeholder: "Ask about…", includeSideChatExcerpt: () => includeExcerpt },
    );
    conversation = conv;
    try {
      const loaded = await openSessionInto(conv, session);
      if (conversation === conv) {
        if (!loaded) throw new Error("Could not load side chat. Try again.");
        if (creating) conv.composer.state.draft = pendingDraft;
        pendingQuote = null;
        pendingDraft = "";
        redraw();
        conv.drawActiveChat();
        conv.composer.focusComposerEnd();
      }
    } catch (cause) {
      reportHandledError("web:side_chat_open", cause);
      if (opening !== epoch) return;
      error = errMessage(cause, "Could not open side chat.");
      redraw();
    }
  }

  async function discuss(retry = false) {
    const anchor = retry ? pendingAnchor : selected;
    if (!anchor || !sourceId || busy) return;
    const draft = retry ? pendingDraft : "";
    const created = retry ? active : null;
    const id = sourceId;
    const messages = [...ctx.chat.state.inheritedMessages, ...(ctx.chat.state.agent?.state.messages ?? [])];
    close();
    const opening = epoch;
    pendingAnchor = anchor;
    pendingQuote = anchor.quote;
    pendingDraft = draft;
    cardLeft = anchor.left;
    cardTop = anchor.panelTop;
    maximized = false;
    document.addEventListener("pointerdown", outsidePointerDown, true);
    window.getSelection()?.removeAllRanges();
    busy = true;
    error = "";
    redraw();
    queueMicrotask(() => panel?.closest(".side-chat-panel")?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    try {
      if (created) {
        await show(created, true);
        return;
      }
      const { entries } = await api<{ entries: SessionEntry[] }>(`/api/sessions/${encodeURIComponent(id)}`);
      const floor = Math.max(
        ctx.chat.state.forkSession?.forkBoundarySeq ?? -1,
        (ctx.chat.state.transcriptAnchorSeq ?? 0) - 1,
      );
      const cut = forkCutSeq(entries, messages, anchor.index, floor);
      const seq = messageEntrySeqs(messages[anchor.index]!)[0] ?? cut;
      if (cut === undefined || seq === undefined)
        throw new Error("This message is still saving. Try again in a moment.");
      const result = await forkSession(id, Math.max(cut, ...entries.map((entry) => entry.seq ?? 0)), {
        entrySeq: seq,
        quote: anchor.quote,
        occurrence: anchor.occurrence,
      });
      if (sourceId !== id) return;
      if (opening !== epoch) return;
      ctx.composer.carryModelPick(ctx.chat.state.threadRef, result.session.threadRef);
      window.getSelection()?.removeAllRanges();
      await show(result.session, true);
    } catch (cause) {
      reportHandledError("web:side_chat_create", cause);
      if (opening === epoch) error = errMessage(cause, "Could not start side chat.");
    } finally {
      if (opening === epoch) {
        busy = false;
        redraw();
      }
    }
  }

  async function expand() {
    if (!active || busy) return;
    busy = true;
    const session = active;
    const expanding = epoch;
    redraw();
    try {
      const result = session.sideChat?.expanded
        ? { session }
        : await api<{ session: CoreSession }>(`/api/sessions/${encodeURIComponent(session.id)}/expand`, {
            method: "POST",
          });
      if (expanding !== epoch) return;
      const expanded = { ...session, ...result.session };
      chats = chats.map((chat) => (chat.id === session.id ? expanded : chat));
      await refreshSessions({ silent: true });
      if (expanding !== epoch) return;
      close();
      await openSession(expanded);
    } catch (cause) {
      reportHandledError("web:side_chat_expand", cause);
      if (expanding !== epoch) return;
      error = errMessage(cause, "Could not expand side chat.");
    } finally {
      if (expanding === epoch) {
        busy = false;
        redraw();
      }
    }
  }

  return {
    sync,
    select,
    dismissSelection,
    onScroll() {
      dismissSelection();
      if (active) {
        positionCard();
        redraw();
      }
    },
    onKeydown,
    dispose() {
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("mousedown", selectionStarted, true);
      document.removeEventListener("mouseup", selectionEnded, true);
      selecting = false;
      close();
      for (const host of anchors.keys())
        host.querySelectorAll(".side-chat-highlight").forEach((element) => element.remove());
      anchors.clear();
      observedRows.clear();
      highlightResize?.disconnect();
    },
    hover(event: MouseEvent) {
      const next = anchorsAt(event)[0]?.session.id;
      (event.currentTarget as HTMLElement).style.cursor = next ? "pointer" : "";
      if (next !== hovered) {
        hovered = next;
        paintHighlights();
      }
    },
    leave() {
      hovered = undefined;
      paintHighlights();
    },
    markers(seqs: readonly number[]) {
      const matches = chats.filter((chat) => chat.sideChat && seqs.includes(chat.sideChat.entrySeq));
      return matches.length
        ? html`<div
            class="side-chat-markers ${matches.some((chat) => choices.has(chat.id)) ? "choosing" : ""}"
            ${ref((element) => {
              if (!element) return;
              const host = element as HTMLElement;
              queueMicrotask(() => {
                for (const key of anchors.keys()) {
                  if (key.isConnected) continue;
                  highlightResize?.unobserve(key);
                  const previous = observedRows.get(key);
                  if (previous) highlightResize?.unobserve(previous);
                  observedRows.delete(key);
                  anchors.delete(key);
                }
                if (!host.isConnected) return;
                const row = host.previousElementSibling;
                anchors.set(
                  host,
                  row
                    ? matches.flatMap((session) => {
                        const range = passageRange(row, session.sideChat!.quote, session.sideChat!.occurrence);
                        return range ? [{ session, range }] : [];
                      })
                    : [],
                );
                highlightResize?.observe(host);
                if (row) {
                  observedRows.set(host, row as HTMLElement);
                  highlightResize?.observe(row);
                }
                paintHighlights();
              });
            })}
          >
            ${matches.map(
              (chat, index) =>
                html`<button
                  class="side-chat-marker ${choices.has(chat.id) ? "choice" : ""}"
                  type="button"
                  aria-expanded=${active?.id === chat.id}
                  aria-controls=${active?.id === chat.id ? panelId : nothing}
                  aria-label=${`Open side chat: ${chat.sideChat!.quote}`}
                  @click=${(event: MouseEvent) => {
                    returnFocus = event.currentTarget as HTMLElement;
                    void show(chat);
                  }}
                  ${tip(chat.sideChat!.quote)}
                >
                  ${icon(MessageSquare, 14)}
                  <span>${choices.has(chat.id) ? `${index + 1}. ${chat.title || "Side chat"}` : "Open side chat"}</span>
                  ${chat.sideChat!.expanded ? icon(ArrowUpRight, 13) : nothing}
                </button>`,
            )}
          </div>`
        : nothing;
    },
    view() {
      return html`${selected ? html`<button class="side-chat-discuss" type="button" style=${`left:${selected.left}px;top:${selected.top}px`} @mousedown=${(event: MouseEvent) => event.preventDefault()} @click=${() => void discuss()} ?disabled=${busy} aria-busy=${busy}>${icon(MessageSquare, 15)} <span>Ask about</span></button>` : nothing}
      ${
        error
          ? html`<div class="side-chat-error" role="alert">
              ${error}${pendingQuote !== null ? html`<button @click=${() => void discuss(true)} ?disabled=${busy}>Retry</button>` : nothing}<button
                @click=${() => {
                  error = "";
                  redraw();
                }}
                aria-label="Dismiss error"
              >
                ${icon(X, 14)}
              </button>
            </div>`
          : nothing
      }
      ${
        active || pendingQuote !== null
          ? html`<aside
              class="side-chat-panel ${maximized ? "maximized" : ""}"
              style=${`--side-chat-left:${cardLeft}px;--side-chat-top:${cardTop}px`}
              id=${panelId}
              aria-label="Side chat"
              @keydown=${panelKeydown}
            >
              <header
                class="side-chat-header"
                @pointerdown=${startDrag}
                @pointermove=${moveDrag}
                @pointerup=${endDrag}
                @pointercancel=${endDrag}
                @lostpointercapture=${endDrag}
              >
                <button
                  class="icon-btn subtle compact"
                  aria-label=${maximized ? "Collapse side chat" : "Expand side chat"}
                  @click=${() => {
                    maximized = !maximized;
                    redraw();
                  }}
                >
                  ${icon(maximized ? Minimize2 : Maximize2, 15)}
                </button>
                <button
                  class="icon-btn subtle compact"
                  type="button"
                  @click=${() => void expand()}
                  ?disabled=${busy || !active}
                  aria-busy=${busy}
                  aria-label="Open as session"
                  ${tip("Open as session")}
                >
                  ${icon(ArrowUpRight, 15)}
                </button>
                <button
                  class="icon-btn subtle compact"
                  type="button"
                  aria-label="Close side chat"
                  @click=${dismiss}
                  ${tip("Close side chat · Esc")}
                >
                  ${icon(X, 17)}
                </button>
              </header>
              ${
                maximized && includeExcerpt && active?.sideChat?.quote
                  ? html`<div class="side-chat-excerpt">
                      <span>${active.sideChat.quote}</span
                      ><button
                        class="icon-btn"
                        aria-label="Remove excerpt"
                        @click=${() => {
                          includeExcerpt = false;
                          redraw();
                        }}
                      >
                        ${icon(X, 12)}
                      </button>
                    </div>`
                  : nothing
              }
              ${
                pendingQuote !== null
                  ? html`<div class="side-chat-pending">
                      <div class="side-chat-excerpt"><span>${pendingQuote}</span></div>
                      <div class="side-chat-draft">
                        <textarea
                          aria-label="Ask about"
                          placeholder="Ask about…"
                          .value=${pendingDraft}
                          @input=${(event: Event) => {
                            pendingDraft = (event.target as HTMLTextAreaElement).value;
                          }}
                        ></textarea>
                        <button class="send-btn" type="button" disabled aria-label="Send message">
                          ${icon(ArrowUp, 18)}
                        </button>
                      </div>
                    </div>`
                  : nothing
              }
              <div
                class="side-chat-conversation"
                ?hidden=${pendingQuote !== null}
                ${ref((element) => {
                  panel = element as HTMLElement | null;
                })}
              ></div>
            </aside>`
          : nothing
      }`;
    },
  };
}
