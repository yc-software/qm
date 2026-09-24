import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

export type AppNotice = { id: string; text: string; createdAt: number; request: boolean; url?: string };
export const appNoticeState = { notices: [] as AppNotice[], error: "", toast: null as AppNotice | null };
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> | undefined;
let generation = 0;
let onChange = () => {};

export function hideAppNoticeToast(): void {
  appNoticeState.toast = null;
  onChange();
}

export function refreshAppNotices(fresh = false): Promise<void> {
  if (pending) return fresh ? pending.then(() => refreshAppNotices()) : pending;
  const current = generation;
  pending = (async () => {
    try {
      const { notices } = await api<{ notices: AppNotice[] }>("/api/deployment-notices");
      if (current !== generation) return;
      const previous = new Set(appNoticeState.notices.map((notice) => notice.id));
      const arrived = notices.filter((notice) => !previous.has(notice.id));
      appNoticeState.toast =
        arrived.sort((a, b) => b.createdAt - a.createdAt)[0] ??
        notices.find((notice) => notice.id === appNoticeState.toast?.id) ??
        null;
      appNoticeState.notices = notices;
      appNoticeState.error = "";
    } catch (error) {
      if (current !== generation) return;
      appNoticeState.error = errMessage(error, "Could not load app notices.");
    } finally {
      if (current === generation) {
        pending = undefined;
        onChange();
      }
    }
  })();
  return pending;
}

export function stopAppNotices(): void {
  generation++;
  clearTimeout(timer);
  pending = undefined;
  onChange = () => {};
  appNoticeState.notices = [];
  appNoticeState.error = "";
  appNoticeState.toast = null;
}

export function startAppNotices(changed: () => void): void {
  stopAppNotices();
  onChange = changed;
  const current = generation;
  const poll = async () => {
    await refreshAppNotices();
    if (current === generation) timer = setTimeout(() => void poll(), 15_000);
  };
  void poll();
}
