import "./side-chat.css";
import { cachedTranscript, refreshCachedTranscript, storeTranscript } from "./transcript-cache";
import { passageOccurrence, passageRange } from "./passage-range";
import { html, nothing } from "lit";
import { markdown } from "./message-markdown";
import { retractedReason } from "./items";
import { messageWorkTimeline } from "./timeline";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { ArrowUp, ArrowUpRight, Maximize2, Minimize2, Minus, MessageSquare, X } from "lucide";
import { tip } from "./tooltip";
import {
  api,
  fetchTranscript,
  TAIL_TURNS,
  forkCutSeq,
  forkSession,
  itemsToMessages,
  messageText,
  type AssistantWork,
  type CoreSession,
} from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import { openSession, openSessionInto, refreshSessions, workingMark } from "./sessions";
import { hasHumanMessage, markWorking } from "./session-list";
import { saveDraft, storedDraft } from "./drafts";
import { appear, inRail, leave } from "./side-chat-motion";
import { withoutSideChatExcerpt } from "./side-chat-excerpt";
import { liveWorkDuration } from "./live-work-duration";
import { liveTurnOf } from "./working-dot";
import type { Conversation, ConvCtx } from "./conv-types";
import { messageEntrySeqs } from "./message-link";
import { icon } from "./icons";
import { brandMark, brandName, sheenLabel } from "./ui";
import { errMessage } from "../../chassis/src/errors";
import { reportHandledError } from "./browser-errors";

const PREVIEW_NOTE = {
  loading: "Loading…",
  ready: "No reply.",
  failed: "Could not load preview. Open the side chat to retry.",
};

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
  let sendOnOpen = false;
  let maximized = false;
  let includeExcerpt = true;
  const previews = new Map<string, { text: string; question: string; state: keyof typeof PREVIEW_NOTE }>();
  const unsent = new Set<string>();
  let loadingId: string | null = null;
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
  let pressedOutside: number | null = null;
  const highlightResize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => paintHighlights());
  let watched = new WeakSet<Element>();
  function watch(element: Element) {
    if (watched.has(element)) return;
    watched.add(element);
    highlightResize?.observe(element);
  }
  function openCard() {
    const panel = panelHost()?.parentElement;
    return panel?.closest<HTMLElement>(".side-chat-card") ?? panel ?? null;
  }
  function paintHighlights() {
    let railBottom = Number.NEGATIVE_INFINITY;
    let reach = Number.NEGATIVE_INFINITY;
    let stack: HTMLElement | null = null;
    const hosts = [...anchors.keys()].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    for (const host of hosts) {
      const entries = anchors.get(host)!;
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
      const placed = placeCards(host, origin, shapes, railBottom);
      railBottom = placed.bottom;
      reach = Math.max(reach, placed.reach);
      stack = host.parentElement;
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
    if (!stack) return;
    const added = Number.parseFloat(stack.style.getPropertyValue("--side-chat-overhang")) || 0;
    const overhang = `${Math.max(0, Math.ceil(Math.max(railBottom, reach) - (stack.getBoundingClientRect().bottom - added)))}px`;
    if (stack.style.getPropertyValue("--side-chat-overhang") !== overhang)
      stack.style.setProperty("--side-chat-overhang", overhang);
  }
  function placeCards(
    host: HTMLElement,
    origin: DOMRect,
    shapes: { session: CoreSession; line: { top: number } }[],
    above: number,
  ) {
    const rail = inRail(host);
    const floor = rail ? above - origin.top : 0;
    let nextCardTop = 0;
    let reach = Number.NEGATIVE_INFINITY;
    const gap = Number.parseFloat(getComputedStyle(host).rowGap) || 0;
    const cards = Array.from(
      host.querySelectorAll<HTMLElement>(":scope > .side-chat-card, :scope > .side-chat-panel"),
      (card) => {
        const firstLine = shapes.find(({ session }) => session.id === card.dataset.sideChatId)?.line;
        const draftRange =
          !card.dataset.sideChatId && pendingAnchor && observedRows.get(host)
            ? passageRange(observedRows.get(host)!, pendingAnchor.quote, pendingAnchor.occurrence)
            : null;
        return {
          card,
          top: firstLine?.top ?? draftRange?.getClientRects?.()[0]?.top ?? origin.top,
          height: card.getBoundingClientRect().height,
          marginBottom: Number.parseFloat(getComputedStyle(card).marginBottom) || 0,
        };
      },
    );
    for (const { card, top, height, marginBottom } of cards) {
      const id = card.dataset.sideChatId ?? "";
      card.classList.toggle("hovered", Boolean(hovered) && id === hovered);
      const floating = rail && !id;
      const line = Math.max(top - origin.top, floor);
      const offset = floating ? line : Math.max(0, line - nextCardTop);
      const value = `${offset}px`;
      if (card.style.getPropertyValue("--side-chat-offset") !== value)
        card.style.setProperty("--side-chat-offset", value);
      const start = floating ? offset : nextCardTop + offset;
      const panel = card.querySelector(":scope > .side-chat-panel")?.getBoundingClientRect().height ?? 0;
      reach = Math.max(reach, origin.top + start + Math.max(height, panel));
      if (!floating) nextCardTop = start + height + (rail ? 0 : marginBottom) + gap;
    }
    return { bottom: Math.max(above, rail ? origin.top + nextCardTop : origin.bottom), reach };
  }
  function besideRow(card: HTMLElement | null) {
    const row = card?.closest(".side-chat-markers")?.previousElementSibling;
    return row instanceof HTMLElement ? row : undefined;
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

  function collapse(after?: () => void) {
    const card = openCard();
    const inline = card && !inRail(card);
    const leaving = epoch;
    const settle = () => {
      if (leaving !== epoch) return;
      ctx.chat.holdTranscript(besideRow(card));
      close();
      redraw();
      if (inline) appear(card.querySelector(":scope > .side-chat-note"));
      after?.();
    };
    return leave(panelHost()?.parentElement)?.then(settle) ?? settle();
  }

  function dismiss() {
    const target = returnFocus;
    void collapse(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
      else ctx.composer.focusComposerEnd();
    });
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

  function pendingKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!pendingDraft.trim()) return;
    sendOnOpen = true;
    redraw();
  }

  function panelKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (conversation?.composer.closeMenus()) conversation.drawActiveChat();
    else dismiss();
  }

  function asked(session: CoreSession, messages: readonly object[]) {
    const question = messages.findLast((message) => {
      const { role, opener } = message as { role?: string; opener?: boolean };
      return (role === "user" || role === "user-with-attachments") && !opener;
    });
    return question
      ? withoutSideChatExcerpt(
          messageText(question as Parameters<typeof messageText>[0]),
          session.sideChat?.quote,
        ).trim()
      : "";
  }

  async function loadPreview(session: CoreSession) {
    const id = sourceId;
    const preview = { ...(previews.get(session.id) ?? { text: "", question: "", state: "loading" as const }) };
    previews.set(session.id, preview);
    try {
      const page = await fetchTranscript(session.id, { tailTurns: 1 });
      const { items } = page;
      if (sourceId !== id || previews.get(session.id) !== preview) return;
      if (pendingQuote === null && !cachedTranscript(session.id)) storeTranscript(session.id, page);
      else refreshCachedTranscript(session.id);
      const turn = itemsToMessages(items.filter((item) => item.seq > (session.forkBoundarySeq ?? -1)));
      const messages = turn.filter((message): message is AssistantWork => message.role === "assistant");
      preview.question = asked(session, turn) || preview.question;
      const replies = messages.map(messageText).filter(Boolean);
      const work = messages.at(-1)?.work;
      if (!replies.length && work)
        replies.push(
          ...messageWorkTimeline(work, "").flatMap((part) =>
            part.kind === "text" && !retractedReason(part.item) ? [part.item.text!] : [],
          ),
        );
      preview.text = replies.join("\n\n");
      preview.state = "ready";
    } catch (cause) {
      reportHandledError("web:side_chat_preview", cause);
      if (sourceId !== id || previews.get(session.id) !== preview) return;
      preview.text = "";
      preview.state = "failed";
    }
    if (previewFrame === null)
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        if (sourceId === id) redraw();
      });
  }

  function note(chat: CoreSession) {
    if (unsent.has(chat.id))
      return chat.id === active?.id
        ? nothing
        : html`<div class="side-chat-note">
            <div class="side-chat-preview draft"><strong>Draft</strong> ${storedDraft(chat.threadRef)}</div>
          </div>`;
    const preview = previews.get(chat.id);
    const state = preview?.state ?? "loading";
    const text = preview?.text || (chat.working && state !== "failed" ? "" : PREVIEW_NOTE[state]);
    return html`<div class="side-chat-note">
      ${preview?.question ? html`<div class="side-chat-question">${preview.question}</div>` : nothing}${
        text ? html` <div class="side-chat-preview">${markdown(text)}</div> ` : nothing
      }${
        chat.working
          ? html`<div class="side-chat-working work-head">
              ${workingMark()}${sheenLabel("Working", true)}${
                chat.workingSince === undefined
                  ? nothing
                  : html`<span class="work-elapsed"
                      >${liveWorkDuration({ status: "working", startedAt: chat.workingSince, activity: [] })}</span
                    >`
              }
            </div>`
          : nothing
      }
    </div>`;
  }

  function refreshHighlights(fresh: readonly string[] = []) {
    const id = sourceId;
    if (!id) return;
    void api<{ sessions: CoreSession[] }>(`/api/sessions/${encodeURIComponent(id)}/side-chats`).then(
      async (result) => {
        if (sourceId !== id) return;
        const listed = result.sessions ?? [];
        const finished = new Set(chats.filter((chat) => chat.working).map((chat) => chat.id));
        const changed = (chat: CoreSession) => fresh.includes(chat.id) || (finished.has(chat.id) && !chat.working);
        const loaded = listed.filter((chat) => chat.id !== active?.id && changed(chat));
        await Promise.all(loaded.map(loadPreview));
        if (loaded.length) await new Promise((resolve) => window.requestAnimationFrame(resolve));
        if (sourceId !== id) return;
        const order = new Map(chats.map((chat, position) => [chat.id, position]));
        for (const chat of listed) unsent.delete(chat.id);
        const kept = chats.filter(
          (chat) => (chat.id === active?.id || unsent.has(chat.id)) && !listed.some((row) => row.id === chat.id),
        );
        chats = [...listed, ...kept].toSorted(
          (left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity),
        );
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
      const leaving = active;
      const id = sourceId;
      const state = conversation?.state;
      const live = state && liveTurnOf(state);
      const draft = (conversation?.composer.state.draft || storedDraft(leaving.threadRef)).trim();
      const preview = previews.get(leaving.id);
      if (preview && !preview.question) preview.question = asked(leaving, state?.agent?.state.messages ?? []);
      if (!unsent.has(leaving.id) || live || hasHumanMessage(state?.agent?.state.messages ?? [])) {
        unsent.delete(leaving.id);
        if (live) chats = markWorking(chats, live);
        void Promise.resolve(state?.agent?.waitForIdle())
          .catch((cause) => reportHandledError("web:side_chat_close", cause))
          .then(() => sourceId === id && refreshHighlights([leaving.id]));
      } else {
        if (draft) saveDraft(leaving.threadRef, draft);
        else {
          unsent.delete(leaving.id);
          chats = chats.filter((chat) => chat.id !== leaving.id);
        }
        refreshHighlights();
      }
    }
    loadingId = null;
    pendingQuote = null;
    pendingAnchor = null;
    pendingDraft = "";
    sendOnOpen = false;
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
    document.addEventListener("pointerdown", pressStarted, true);
    document.addEventListener("click", clickedOutside);
    const id = ctx.chat.state.sessionId;
    if (id === sourceId) return;
    close();
    if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
    previewFrame = null;
    sourceId = id;
    highlightResize?.disconnect();
    watched = new WeakSet();
    observedRows.clear();
    for (const host of anchors.keys())
      host.querySelectorAll(":scope > .side-chat-highlight").forEach((element) => element.remove());
    anchors.clear();
    paintHighlights();
    chats = [];
    previews.clear();
    unsent.clear();
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

  function pressStarted(event: PointerEvent) {
    const card = openCard();
    pressedOutside = card && !(event.target instanceof Node && card.contains(event.target)) ? epoch : null;
  }

  function clickedOutside(event: MouseEvent) {
    const pressed = pressedOutside;
    pressedOutside = null;
    const target = event.target;
    if (pressed !== epoch || event.button !== 0 || pendingQuote !== null || choices.size) return;
    if (!(target instanceof Element) || !ctx.chat.state.host?.contains(target)) return;
    if (target.closest(".side-chat-card, .side-chat-discuss, .side-chat-error, dialog, [popover]")) return;
    if (window.getSelection()?.toString().trim()) return;
    void collapse();
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

  function reveal() {
    const card =
      [...(ctx.chat.state.host?.querySelectorAll<HTMLElement>(".side-chat-card") ?? [])].find(
        (element) => element.dataset.sideChatId === loadingId,
      ) ?? null;
    ctx.chat.holdTranscript(besideRow(card));
    loadingId = null;
    redraw();
    conversation?.drawActiveChat();
    if (card) appear(panelHost()?.parentElement);
  }

  async function show(session: CoreSession, creating = false) {
    if (!creating) {
      if (active) await collapse();
      close();
    }
    const cached = cachedTranscript(session.id);
    const transcript =
      cached && !cached.earlierItems ? undefined : fetchTranscript(session.id, { tailTurns: TAIL_TURNS });
    transcript?.catch(() => {});
    active = session;
    loadingId = creating ? null : session.id;
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
      const loaded = await openSessionInto(conv, session, transcript);
      if (conversation === conv) {
        if (!loaded) throw new Error("Could not load side chat. Try again.");
        if (creating) conv.composer.state.draft = pendingDraft;
        const send = creating && sendOnOpen;
        pendingQuote = null;
        pendingDraft = "";
        sendOnOpen = false;
        reveal();
        conv.composer.focusComposerEnd();
        if (send) void conv.composer.submit();
      }
    } catch (cause) {
      reportHandledError("web:side_chat_open", cause);
      if (opening !== epoch) return;
      loadingId = null;
      sendOnOpen = false;
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
    if (active && !retry) await collapse();
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
    const panel = panelHost()?.closest<HTMLElement>(".side-chat-panel");
    if (!created) appear(panel);
    panel?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
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
      unsent.add(result.session.id);
      chats = [...chats.filter((chat) => chat.id !== result.session.id), result.session];
      await show(result.session, true);
    } catch (cause) {
      reportHandledError("web:side_chat_create", cause);
      if (opening === epoch) {
        error = errMessage(cause, "Could not start side chat.");
        sendOnOpen = false;
      }
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
      if (chat) refreshHighlights([chat.id]);
    },
    catchUp() {
      if (chats.some((chat) => chat.working)) refreshHighlights();
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
      document.removeEventListener("pointerdown", pressStarted, true);
      document.removeEventListener("click", clickedOutside);
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
      watched = new WeakSet();
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
            watch(host);
            for (const card of host.querySelectorAll(":scope > .side-chat-card, :scope .side-chat-panel")) watch(card);
            if (row) {
              observedRows.set(host, row as HTMLElement);
              watch(row);
            }
            scheduleHighlights();
          });
        })}
      >
        ${repeat(
          matches,
          (chat) => chat.id,
          (chat) => {
            const open = active?.id === chat.id;
            const shown = open && loadingId !== chat.id;
            return html` <div
              class="side-chat-card ${shown ? "" : "collapsed"} ${open && !shown ? "opening" : ""}"
              @click=${(event: MouseEvent) => {
                if (
                  active?.id === chat.id ||
                  (event.target as Element).closest("a, button") ||
                  window.getSelection()?.toString()
                )
                  return;
                returnFocus = (event.currentTarget as HTMLElement).querySelector(":scope > .side-chat-marker");
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
                ${shown ? nothing : html`<b class="side-chat-more" aria-hidden="true">…</b>`}
              </button>
              ${note(chat)}${open ? this.card() : nothing}
            </div>`;
          },
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
                    appear(openCard());
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
                          ?readonly=${sendOnOpen}
                          @keydown=${pendingKeydown}
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
