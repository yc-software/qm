import "./side-chat.css";
import { cachedTranscript, storeTranscript } from "./transcript-cache";
import { passageOccurrence, passageRange } from "./passage-range";
import { html, nothing } from "lit";
import { markdown } from "./message-markdown";
import { isHidden } from "./items";
import { ref } from "lit/directives/ref.js";
import { ArrowUp, ArrowUpRight, Maximize2, Minimize2, Minus, MessageSquare, X } from "lucide";
import { tip } from "./tooltip";
import { api, fetchTranscript, forkCutSeq, forkSession, type CoreSession } from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import { openSession, openSessionInto, refreshSessions } from "./sessions";
import type { Conversation, ConvCtx } from "./conv-types";
import { messageEntrySeqs } from "./message-link";
import { icon } from "./icons";
import { brandMark, brandName } from "./ui";
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
  };
  let selected: SelectionAnchor | null = null;
  let active: CoreSession | null = null;
  let conversation: Conversation | null = null;
  let busy = false;
  let selecting = false;
  let pendingAnchor: SelectionAnchor | null = null;
  let pendingQuote: string | null = null;
  let pendingDraft = "";
  let maximized = false;
  let includeExcerpt = true;
  const previews = new Map<string, { text: string }>();
  let previewFrame: number | null = null;
  let error = "";
  let epoch = 0;
  const redraw = () => ctx.chat.drawActiveChat();
  const panelId = `side-chat-${crypto.randomUUID()}`;
  const panelHost = () =>
    ctx.chat.state.host?.querySelector<HTMLElement>(`#${panelId} > .side-chat-conversation`) ?? null;
  let returnFocus: HTMLElement | null = null;
  const anchors = new Map<HTMLElement, { session: CoreSession; range: Range }[]>();
  const observedRows = new Map<HTMLElement, HTMLElement>();
  let paintPending = false;
  function scheduleHighlights() {
    if (paintPending) return;
    paintPending = true;
    queueMicrotask(() => {
      paintPending = false;
      paintHighlights();
    });
  }
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
      let nextCardTop = 0;
      const gap = Number.parseFloat(getComputedStyle(host).rowGap) || 0;
      for (const card of host.querySelectorAll<HTMLElement>(":scope > .side-chat-card, :scope > .side-chat-panel")) {
        const firstLine = shapes.find(({ session }) => session.id === card.dataset.sideChatId)?.line;
        const draftRange =
          !card.dataset.sideChatId && pendingAnchor && observedRows.get(host)
            ? passageRange(observedRows.get(host)!, pendingAnchor.quote, pendingAnchor.occurrence)
            : null;
        const top = firstLine?.top ?? draftRange?.getClientRects?.()[0]?.top ?? origin.top;
        const offset = Math.max(0, top - origin.top - nextCardTop);
        const value = `${offset}px`;
        if (card.style.getPropertyValue("--side-chat-offset") !== value)
          card.style.setProperty("--side-chat-offset", value);
        nextCardTop +=
          offset +
          card.getBoundingClientRect().height +
          (Number.parseFloat(getComputedStyle(card).marginBottom) || 0) +
          gap;
      }
      const existing = new Map(
        Array.from(host.querySelectorAll<HTMLElement>(":scope > .side-chat-highlight")).map((element) => [
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

  function typeToDiscuss(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.key.length !== 1 ||
      (event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, button, [contenteditable], [role=textbox], .cm-editor, .monaco-editor",
        ))
    )
      return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    select(event, ctx.chat.state.host?.querySelector<HTMLElement>(".chat-scroll") ?? null);
    if (!selected || busy || !sourceId) return;
    event.preventDefault();
    void discuss(false, event.key);
  }

  function panelKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (conversation?.composer.closeMenus()) conversation.drawActiveChat();
    else dismiss();
  }

  async function loadPreview(session: CoreSession) {
    const id = sourceId;
    const preview = { text: "Loading…" };
    previews.set(session.id, preview);
    try {
      const page = await fetchTranscript(session.id, { tailTurns: 1 });
      const { items } = page;
      if (sourceId !== id || previews.get(session.id) !== preview) return;
      if (pendingQuote === null && !cachedTranscript(session.id)) storeTranscript(session.id, page);
      const replies = items.filter(
        (item) =>
          item.seq > (session.forkBoundarySeq ?? -1) &&
          item.kind === "AgentMessage" &&
          item.variant === null &&
          !isHidden(item),
      );
      preview.text = replies.map((item) => item.text ?? "").join("\n\n");
    } catch (cause) {
      reportHandledError("web:side_chat_preview", cause);
      if (sourceId !== id || previews.get(session.id) !== preview) return;
      preview.text = "Could not load preview. Open the side chat to retry.";
    }
    if (previewFrame === null)
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        if (sourceId === id) redraw();
      });
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
    if (active) {
      void loadPreview(active);
      refreshHighlights();
    }
    pendingQuote = null;
    pendingAnchor = null;
    pendingDraft = "";
    epoch++;
    busy = false;
    choices.clear();
    if (conversation) disposeConversation(conversation);
    conversation = null;
    active = null;
    selected = null;
  }

  function sync() {
    document.addEventListener("keydown", typeToDiscuss);
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("mousedown", selectionStarted, true);
    document.addEventListener("mouseup", selectionEnded, true);
    const id = ctx.chat.state.sessionId;
    if (id === sourceId) return;
    close();
    if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
    previewFrame = null;
    sourceId = id;
    highlightResize?.disconnect();
    observedRows.clear();
    for (const host of anchors.keys())
      host.querySelectorAll(":scope > .side-chat-highlight").forEach((element) => element.remove());
    anchors.clear();
    paintHighlights();
    chats = [];
    previews.clear();
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
      row.closest(".chat-scroll") !== host ||
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

  async function show(session: CoreSession, creating = false) {
    if (!creating) close();
    active = session;
    includeExcerpt = true;
    maximized = false;
    const opening = epoch;
    const draftInput = panelHost()
      ?.closest(".side-chat-panel")
      ?.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea");
    const draftSelection =
      draftInput === document.activeElement && draftInput
        ? ([draftInput.selectionStart, draftInput.selectionEnd, draftInput.selectionDirection] as const)
        : null;
    redraw();
    if (draftSelection) {
      const input = panelHost()
        ?.closest(".side-chat-panel")
        ?.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(...draftSelection);
    }
    await Promise.resolve();
    if (!panelHost() || opening !== epoch) return;
    redraw();
    const conv = createConversation(
      {
        pane: true,
        ownsUrl: false,
        container: panelHost,
        claimContainer: panelHost,
        visible: () => Boolean(panelHost()?.isConnected),
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

  async function discuss(retry = false, initialDraft = "") {
    const anchor = retry ? pendingAnchor : selected;
    if (!anchor || !sourceId || busy) return;
    const draft = retry ? pendingDraft : initialDraft;
    const created = retry ? active : null;
    const id = sourceId;
    const messages = [...ctx.chat.state.inheritedMessages, ...(ctx.chat.state.agent?.state.messages ?? [])];
    close();
    const opening = epoch;
    pendingAnchor = anchor;
    pendingQuote = anchor.quote;
    pendingDraft = draft;
    maximized = false;
    window.getSelection()?.removeAllRanges();
    busy = true;
    error = "";
    redraw();
    panelHost()
      ?.closest(".side-chat-panel")
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
    try {
      if (created) {
        await show(created, true);
        return;
      }
      const { items } = await fetchTranscript(id);
      const floor = Math.max(
        ctx.chat.state.forkSession?.forkBoundarySeq ?? -1,
        (ctx.chat.state.transcriptAnchorSeq ?? 0) - 1,
      );
      const cut = forkCutSeq(items, messages, anchor.index, floor);
      const seq = messageEntrySeqs(messages[anchor.index]!)[0] ?? cut;
      if (cut === undefined || seq === undefined)
        throw new Error("This message is still saving. Try again in a moment.");
      const result = await forkSession(id, Math.max(cut, ...items.map((item) => item.seq)), {
        entrySeq: seq,
        quote: anchor.quote,
        occurrence: anchor.occurrence,
      });
      if (sourceId !== id) return;
      if (opening !== epoch) return;
      ctx.composer.carryModelPick(ctx.chat.state.threadRef, result.session.threadRef);
      window.getSelection()?.removeAllRanges();
      chats = [...chats.filter((chat) => chat.id !== result.session.id), result.session];
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
    onDelivery(threadRef: string) {
      const chat = chats.find((session) => session.threadRef === threadRef);
      if (!chat) return;
      previews.delete(chat.id);
      redraw();
    },
    select,
    dismissSelection,
    onScroll() {
      dismissSelection();
    },
    onKeydown,
    dispose() {
      document.removeEventListener("keydown", typeToDiscuss);
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("mousedown", selectionStarted, true);
      document.removeEventListener("mouseup", selectionEnded, true);
      selecting = false;
      close();
      sourceId = null;
      if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
      previewFrame = null;
      for (const host of anchors.keys())
        host.querySelectorAll(":scope > .side-chat-highlight").forEach((element) => element.remove());
      anchors.clear();
      observedRows.clear();
      highlightResize?.disconnect();
    },
    hover(event: MouseEvent) {
      const card = (event.target as Element).closest<HTMLElement>(".side-chat-card");
      const passage = anchorsAt(event)[0]?.session.id;
      const next = card?.dataset.sideChatId ?? passage;
      (event.currentTarget as HTMLElement).style.cursor = passage ? "pointer" : "";
      if (next !== hovered) {
        hovered = next;
        paintHighlights();
      }
    },
    leave() {
      hovered = undefined;
      paintHighlights();
    },
    hasChats() {
      return chats.length > 0 || pendingQuote !== null;
    },
    markers(seqs: readonly number[], index: number) {
      const matches = chats.filter((chat) => chat.sideChat && seqs.includes(chat.sideChat.entrySeq));
      const pending = pendingQuote !== null && pendingAnchor?.index === index;
      if (!matches.length && !pending) return nothing;
      return html`<div
        class="side-chat-markers ${matches.length > 1 ? "crowded" : ""} ${matches.length >= 3 ? "dense" : ""} ${matches.some((chat) => choices.has(chat.id)) ? "choosing" : ""}"
        ${ref((element) => {
          if (!element) return;
          const host = element as HTMLElement;
          queueMicrotask(() => {
            if (!host.isConnected) return;
            for (const chat of matches) if (!previews.has(chat.id)) void loadPreview(chat);
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
            const ranges = new Map(anchors.get(host)!.map(({ session, range }) => [session.id, range]));
            const ordered = matches.toSorted((left, right) => {
              const a = ranges.get(left.id);
              const b = ranges.get(right.id);
              return a && b
                ? a.compareBoundaryPoints(host.ownerDocument.defaultView!.Range.START_TO_START, b)
                : Number(!a) - Number(!b);
            });
            if (ordered.some((chat, position) => chat.id !== matches[position]!.id)) {
              let position = 0;
              const ids = new Set(matches.map((chat) => chat.id));
              chats = chats.map((chat) => (ids.has(chat.id) ? ordered[position++]! : chat));
              redraw();
              return;
            }
            highlightResize?.observe(host);
            if (row) {
              observedRows.set(host, row as HTMLElement);
              highlightResize?.observe(row);
            }
            scheduleHighlights();
          });
        })}
      >
        ${matches.map(
          (chat) =>
            html` <div
              class="side-chat-card ${active?.id === chat.id ? "" : "collapsed"}"
              @click=${(event: MouseEvent) => {
                if (
                  active?.id === chat.id ||
                  (event.target as Element).closest("a, button") ||
                  window.getSelection()?.toString()
                )
                  return;
                returnFocus = (event.currentTarget as HTMLElement).querySelector("button");
                void show(chat);
              }}
              data-side-chat-id=${chat.id}
              @focusin=${() => {
                hovered = chat.id;
                paintHighlights();
              }}
              @focusout=${() => {
                hovered = undefined;
                paintHighlights();
              }}
            >
              <button
                class="side-chat-marker ${choices.has(chat.id) ? "choice" : ""}"
                type="button"
                aria-expanded=${active?.id === chat.id}
                aria-controls=${active?.id === chat.id ? panelId : nothing}
                aria-label=${`Open side chat: ${chat.sideChat!.quote}`}
                @click=${(event: MouseEvent) => {
                  returnFocus = event.currentTarget as HTMLElement;
                  if (active?.id !== chat.id) void show(chat);
                }}
              >
                ${brandMark()}<span class="side-chat-label"
                  ><strong>${brandName()}</strong> · Re:
                  “${choices.has(chat.id) ? chat.title || "Side chat" : chat.sideChat!.quote}”</span
                >
                ${chat.sideChat!.expanded ? icon(ArrowUpRight, 13) : nothing}
                ${active?.id !== chat.id ? html`<b class="side-chat-more" aria-hidden="true">…</b>` : nothing}
              </button>
              ${
                active?.id === chat.id
                  ? this.card()
                  : html`
                      <div class="side-chat-preview">
                        ${markdown(previews.get(chat.id)?.text || "Start the conversation about this passage.")}
                      </div>
                    `
              }
            </div>`,
        )}
        ${pending && !matches.some((chat) => chat.id === active?.id) ? this.card() : nothing}
      </div>`;
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
      } `;
    },
    card() {
      return html`${
        active || pendingQuote !== null
          ? html`<aside
              class="side-chat-panel ${maximized ? "maximized" : ""}"
              id=${panelId}
              aria-label="Side chat"
              @keydown=${panelKeydown}
            >
              <header class="side-chat-header">
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
                  aria-label="Collapse conversation"
                  @click=${dismiss}
                  ${tip("Collapse conversation · Esc")}
                >
                  ${icon(Minus, 17)}
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
              <div class="side-chat-conversation" ?hidden=${pendingQuote !== null}></div>
            </aside>`
          : nothing
      }`;
    },
  };
}
