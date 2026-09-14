import { html, type TemplateResult } from "lit";
import { previousInboxConversations } from "./inbox-history";
import type { InboxItem } from "./inbox";
import { inboxHistoryList } from "./inbox-history-list";
import { inboxChatHeader } from "./inbox-chat-header";

interface HistoryView {
  selectedId: string | null;
  scrollTop: number;
  listScrollTop: number;
  container: HTMLElement;
}

const views = new Map<string, HistoryView>();

export function closeInboxHistory(): void {
  views.clear();
}

function chatFor(itemId: string, view: HistoryView): HTMLElement | undefined {
  const container = view.container.isConnected ? view.container : document;
  return [...container.querySelectorAll<HTMLElement>(".inbox-chat")].find((chat) => chat.dataset.inboxItem === itemId);
}

export function openInboxHistory(item: InboxItem, opener: HTMLElement, redraw: () => void): void {
  const chat = opener.closest<HTMLElement>(".inbox-chat");
  if (!chat?.parentElement) return;
  const view: HistoryView = {
    selectedId: null,
    scrollTop: chat.querySelector<HTMLElement>(".inbox-chat-log")?.scrollTop ?? 0,
    listScrollTop: 0,
    container: chat.parentElement,
  };
  views.set(item.id, view);
  redraw();
  chatFor(item.id, view)?.querySelector<HTMLButtonElement>(".inbox-history-back")?.focus({ preventScroll: true });
}

export function inboxHistoryPanel(
  item: InboxItem,
  redraw: () => void,
  renderConversation: (id: string, header: TemplateResult, onKeydown: (event: KeyboardEvent) => void) => TemplateResult,
): TemplateResult | null {
  const view = views.get(item.id);
  if (!view) return null;
  const conversations = previousInboxConversations(item);
  const selected = conversations.find((conversation) => conversation.id === view.selectedId);
  const close = () => {
    views.delete(item.id);
    redraw();
    requestAnimationFrame(() => {
      if (views.has(item.id)) return;
      const chat = chatFor(item.id, view);
      const log = chat?.querySelector<HTMLElement>(".inbox-chat-log");
      if (log) log.scrollTop = view.scrollTop;
      chat?.querySelector<HTMLButtonElement>('[aria-label="Previous conversations"]')?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    if (!selected) return close();
    view.selectedId = null;
    redraw();
    const chat = chatFor(item.id, view);
    const list = chat?.querySelector<HTMLElement>(".inbox-history-list");
    if (list) list.scrollTop = view.listScrollTop;
    [...(chat?.querySelectorAll<HTMLButtonElement>(".inbox-history-entry") ?? [])]
      .find((button) => button.dataset.historyId === selected.id)
      ?.focus({ preventScroll: true });
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };
  const header = inboxChatHeader({
    title: selected?.title ?? "Past conversations",
    className: "inbox-history-head",
    back,
    backLabel: selected ? "Back to past conversations" : "Back to conversation",
    close: selected ? close : undefined,
  });
  if (selected) return renderConversation(selected.id, header, onKeydown);
  return html`
    <div class="inbox-chat inbox-history-panel" data-inbox-item=${item.id} @keydown=${onKeydown}>
      ${header}
      ${inboxHistoryList(conversations, (id) => {
        view.listScrollTop = chatFor(item.id, view)?.querySelector<HTMLElement>(".inbox-history-list")?.scrollTop ?? 0;
        view.selectedId = id;
        redraw();
        chatFor(item.id, view)?.querySelector<HTMLTextAreaElement>(".inbox-chat-input")?.focus({ preventScroll: true });
      })}
    </div>
  `;
}
