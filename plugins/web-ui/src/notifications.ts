import { html, nothing, type TemplateResult } from "lit";
import { swallowAs } from "../../chassis/src/errors";
import { api, withBase } from "./core-bridge";
import { appState, can } from "./shell-state";
import { brandName } from "./ui";

export interface ReplyNotice {
  sessionId: string;
  title: string;
  body: string;
  url?: string;
}

const PROMPT_DISMISSED_KEY = "qm.notifications.prompt-dismissed";
const OPEN_SESSION_MESSAGE = "qm:open-session";
const REPLY_NOTICE_MESSAGE = "qm:reply-notice";

let pushSubscribed = false;
let openConversation: (sessionId: string) => void = () => {};
let isOpen: (sessionId: string) => boolean = () => false;
const listeners = new Set<() => void>();

const supported = (): boolean => typeof Notification !== "undefined";
const canNotify = (): boolean => supported() && can("notifications") && !appState.me?.impersonatedBy;
const canPush = (): boolean => canNotify() && "serviceWorker" in navigator;

export function onNotificationStateChange(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  return Boolean(current) && new Uint8Array(current!).every((byte, i) => byte === key[i]);
}

async function ensurePushSubscription(): Promise<void> {
  const registration = await navigator.serviceWorker.register(withBase("/sw.js"), { scope: withBase("/") });
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const key = keyBytes(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && !sameKey(existing, key)) await existing.unsubscribe();
  const subscription =
    existing && sameKey(existing, key)
      ? existing
      : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/api/push/subscription", { method: "PUT", body: JSON.stringify(subscription.toJSON()) });
  pushSubscribed = true;
}

function subscribeForPush(): void {
  void ensurePushSubscription().catch(
    swallowAs("web-ui: push subscription (showing notifications from the page)", undefined),
  );
}

export function startNotifications(open: (sessionId: string) => void, opened: (sessionId: string) => boolean): void {
  openConversation = open;
  isOpen = opened;
  if (!canPush()) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; sessionId?: unknown; notice?: ReplyNotice } | null;
    if (data?.type === OPEN_SESSION_MESSAGE && typeof data.sessionId === "string") openConversation(data.sessionId);
    if (data?.type === REPLY_NOTICE_MESSAGE && data.notice && !viewing(data.notice)) {
      const notice = data.notice;
      void navigator.serviceWorker.ready
        .then((registration) =>
          registration.showNotification(notice.title, { body: notice.body, tag: notice.sessionId, data: notice }),
        )
        .catch(swallowAs("web-ui: show forwarded reply notice", undefined));
    }
  });
  navigator.serviceWorker.startMessages();
  if (Notification.permission === "granted") subscribeForPush();
}

export async function stopPushNotifications(): Promise<void> {
  pushSubscribed = false;
  if (!canPush()) return;
  const subscription = await (
    await navigator.serviceWorker.getRegistration(withBase("/"))
  )?.pushManager.getSubscription();
  if (!subscription) return;
  await api(`/api/push/subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
  await subscription.unsubscribe();
}

async function turnOnNotifications(): Promise<void> {
  const permission = await Notification.requestPermission();
  changed();
  if (permission === "granted") subscribeForPush();
}

function dismissPrompt(): void {
  localStorage.setItem(PROMPT_DISMISSED_KEY, "1");
  changed();
}

const viewing = (notice: ReplyNotice): boolean =>
  isOpen(notice.sessionId) && document.visibilityState === "visible" && document.hasFocus();

export function showReplyNotice(notice: ReplyNotice): void {
  if (pushSubscribed || !canNotify() || Notification.permission !== "granted" || viewing(notice)) return;
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

function notificationNote(): string {
  if (!supported())
    return "This browser can't show notifications. On iPhone and iPad, add this app to your Home Screen, then turn them on there.";
  if (Notification.permission === "granted") return "On in this browser.";
  if (Notification.permission === "denied")
    return "Blocked in this browser's site settings. Allow notifications for this site there to turn them on.";
  return "Get a notification when a reply lands in a conversation you aren't viewing.";
}

export function notificationsSettingsRow(): TemplateResult | typeof nothing {
  if (!can("notifications")) return nothing;
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
