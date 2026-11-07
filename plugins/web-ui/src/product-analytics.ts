import type { Me } from "./shell-state";
import { reportHandledError } from "./browser-errors.ts";

interface AnalyticsHook {
  page?(view: string): void;
  track?(event: string, properties: { insertId: string }): void;
  stop?(): void;
}

type AnalyticsModule = {
  createAnalytics?: (context: {
    org: string;
    user: string;
    options?: unknown;
  }) => AnalyticsHook | Promise<AnalyticsHook>;
};

let hook: AnalyticsHook | undefined;
let generation = 0;
let currentView = "chats";
let lastCapturedView: string | undefined;
const sent = new Set<string>();

function call(context: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    reportHandledError(`analytics: ${context}`, error);
  }
}

function reset(): void {
  generation++;
  const previous = hook;
  hook = undefined;
  if (previous) call("stop", () => previous.stop?.());
  sent.clear();
  lastCapturedView = undefined;
}

export function stopAnalytics(): void {
  reset();
  currentView = "chats";
}

export async function initializeAnalytics(
  me: Me,
  view = "chats",
  load: (url: string) => Promise<AnalyticsModule> = (url) => import(url) as Promise<AnalyticsModule>,
): Promise<void> {
  currentView = view;
  reset();
  const current = generation;
  if (!me.analytics?.module || me.impersonatedBy) return;
  try {
    const { createAnalytics } = await load(me.analytics.module);
    if (typeof createAnalytics !== "function") throw new Error("the analytics module must export createAnalytics");
    const created = await createAnalytics({ org: me.org, user: me.user, options: me.analytics.options });
    if (current !== generation) {
      call("stop", () => created.stop?.());
      return;
    }
    hook = created;
    capturePageview(currentView);
  } catch (error) {
    reportHandledError("analytics: initialization", error);
  }
}

export function capturePageview(view: string): void {
  currentView = view;
  const active = hook;
  if (!active || lastCapturedView === view) return;
  lastCapturedView = view;
  call("page", () => active.page?.(view));
}

export function captureMessage(runId: string, firstMessage: boolean): void {
  const active = hook;
  if (!active || sent.has(runId)) return;
  sent.add(runId);
  if (sent.size > 1000) sent.delete(sent.values().next().value!);
  call("track", () => active.track?.("message_sent", { insertId: `${runId}:message_sent` }));
  if (firstMessage) call("track", () => active.track?.("session_started", { insertId: `${runId}:session_started` }));
}
