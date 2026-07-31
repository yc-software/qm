import { createChatSurface } from "./chat";
import { createComposerSurface } from "./composer";
import { densityTierFor, type DensityTier } from "./density";
import { subscribeDeliveries } from "./core-bridge";
import { applySessionState } from "./session-list";
import { refreshSessions, renderList, sessionsState } from "./sessions";
import { appState } from "./shell-state";
import type { Conversation, ConvCtx, ConvHost } from "./conv-types";

const live = new Set<Conversation>();
let main: Conversation | null = null;

export function createConversation(host: ConvHost): Conversation {
  const ctx = { ...host } as ConvCtx;
  ctx.chat = createChatSurface(ctx);
  ctx.composer = createComposerSurface(ctx);
  const conv = ctx.chat as Conversation;
  conv.composer = ctx.composer;
  live.add(conv);
  return conv;
}

export function disposeConversation(conv: Conversation): void {
  live.delete(conv);
  if (main === conv) main = null;
  conv.composer.dispose();
  conv.dispose();
}

export function allConversations(): Conversation[] {
  return [...live];
}

export function mainConversation(): Conversation {
  main ??= createConversation({
    pane: false,
    ownsUrl: true,
    container: () => appState.mainEl,
    claimContainer: () => {
      exitCanvas();
      return appState.mainEl;
    },
    visible: () => appState.currentView === "chats",
    density: () => "full" as DensityTier,
    onDensityChange: () => {},
    ensureDeliveryStream,
  });
  return main;
}

export function paneDensity(el: HTMLElement): DensityTier {
  const r = el.getBoundingClientRect();
  return densityTierFor(r.width || el.clientWidth, r.height || el.clientHeight);
}

let exitCanvas: () => void = () => {};

export function onExitCanvas(fn: () => void): void {
  exitCanvas = fn;
}

let deliveryStreamOpen = false;

export function ensureDeliveryStream(): void {
  if (deliveryStreamOpen) return;
  deliveryStreamOpen = true;
  subscribeDeliveries(
    (threadRef) => {
      void refreshSessions({ silent: true });
      for (const conv of live) conv.onDelivery(threadRef);
    },
    (event) => {
      const { list, matched } = applySessionState(sessionsState.list, event);
      if (matched) {
        sessionsState.list = list;
        renderList();
      } else {
        void refreshSessions({ silent: true });
      }
      // A run can start server-side for an open conversation without this tab asking
      // for it (a steer replayed as a fresh turn after its run ended, a cron wake, a
      // message from another surface). Attach the open view instead of waiting for a
      // visibilitychange, so the new turn — and its triggering message — show up live.
      if (event.state === "working") for (const conv of live) conv.resumeIfIdle();
    },
    () => void refreshSessions({ silent: true }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const conv of live) conv.resumeIfIdle();
  });
}
