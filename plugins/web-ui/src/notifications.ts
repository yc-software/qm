import { html, nothing, type TemplateResult } from "lit";
import { inDesktopApp } from "./desktop-computer";
import { appState, can } from "./shell-state";
import { brandName } from "./ui";

export interface ReplyNotice {
  sessionId: string;
  title: string;
  body: string;
}

const PROMPT_DISMISSED_KEY = "qm.notifications.prompt-dismissed";

let openConversation: (sessionId: string) => void = () => {};
let isOpen: (sessionId: string) => boolean = () => false;
const listeners = new Set<() => void>();

const offered = (): boolean => inDesktopApp() && can("notifications");
const canNotify = (): boolean => offered() && !appState.me?.impersonatedBy;

export function onNotificationStateChange(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export function startNotifications(open: (sessionId: string) => void, opened: (sessionId: string) => boolean): void {
  openConversation = open;
  isOpen = opened;
}

async function turnOnNotifications(): Promise<void> {
  await Notification.requestPermission();
  changed();
}

function dismissPrompt(): void {
  localStorage.setItem(PROMPT_DISMISSED_KEY, "1");
  changed();
}

const viewing = (notice: ReplyNotice): boolean =>
  isOpen(notice.sessionId) && document.visibilityState === "visible" && document.hasFocus();

export function showReplyNotice(notice: ReplyNotice): void {
  if (!canNotify() || Notification.permission !== "granted" || viewing(notice)) return;
  const shown = new Notification(notice.title, { body: notice.body, tag: notice.sessionId });
  shown.onclick = () => {
    shown.close();
    window.focus();
    openConversation(notice.sessionId);
  };
}

export function notificationPrompt(): TemplateResult | typeof nothing {
  if (!canNotify() || Notification.permission !== "default" || localStorage.getItem(PROMPT_DISMISSED_KEY))
    return nothing;
  return html`
    <div class="top-banner notify" role="status">
      <span>Get a notification when ${brandName()} replies in a conversation you aren't viewing.</span>
      <button class="top-banner-action" type="button" @click=${() => void turnOnNotifications()}>Turn on</button>
      <button class="top-banner-action" type="button" @click=${dismissPrompt}>Not now</button>
    </div>
  `;
}

const notificationNote = (): string =>
  Notification.permission === "granted"
    ? "On in this app."
    : "Get a notification when a reply lands in a conversation you aren't viewing.";

export function notificationsSettingsRow(): TemplateResult | typeof nothing {
  if (!offered()) return nothing;
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Notifications</div>
        <div class="settings-row-note">${notificationNote()}</div>
      </div>
      ${
        canNotify() && Notification.permission === "default"
          ? html`<button class="btn settings-row-action" type="button" @click=${() => void turnOnNotifications()}>
              Turn on
            </button>`
          : nothing
      }
    </div>
  `;
}
