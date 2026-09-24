import { fetchUiState, putUiState } from "./core-bridge";
import { defaultSidebarLayout, normalizeSidebarLayout, type SidebarLayout } from "./sidebar-model";

export const sidebarState = {
  layout: defaultSidebarLayout(),
  loaded: false,
  saving: false,
  error: "",
  notice: "",
  customizing: false,
  sectionMenu: null as string | null,
};

const listeners = new Set<() => void>();
let generation = 0;
let revision = 0;
let savedRevision = 0;
let timestamp = 0;
let savingGeneration: number | null = null;
let loading: Promise<void> | null = null;
let controller = new AbortController();

export function subscribeSidebar(listener: () => void): void {
  listeners.add(listener);
}

export function notifySidebar(): void {
  for (const listener of listeners) listener();
}

export function resetSidebarState(): void {
  generation++;
  controller.abort();
  controller = new AbortController();
  revision = savedRevision = timestamp = 0;
  savingGeneration = null;
  loading = null;
  sidebarState.layout = defaultSidebarLayout();
  sidebarState.loaded = sidebarState.saving = sidebarState.customizing = false;
  sidebarState.error = "";
  sidebarState.notice = "";
  sidebarState.sectionMenu = null;
}

export function loadSidebarState(): Promise<void> {
  if (loading) return loading;
  if (sidebarState.loaded) return Promise.resolve();
  const epoch = generation;
  const request = fetchUiState("sidebar-layout")
    .then((remote) => {
      if (epoch !== generation) return;
      sidebarState.layout = normalizeSidebarLayout(remote.value);
      timestamp = remote.updatedAt;
      sidebarState.loaded = true;
      sidebarState.error = "";
    })
    .catch(() => {
      if (epoch === generation) sidebarState.error = "Couldn't load your sidebar. Try again.";
    })
    .finally(() => {
      if (loading === request) loading = null;
      if (epoch === generation) notifySidebar();
    });
  loading = request;
  return request;
}

export function updateSidebarLayout(update: (layout: SidebarLayout) => SidebarLayout): void {
  if (!sidebarState.loaded) return;
  const next = normalizeSidebarLayout(update(sidebarState.layout));
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 60 * 1024) {
    sidebarState.notice = "This change would fill your sidebar. Remove unused sections or shortcuts and try again.";
    notifySidebar();
    return;
  }
  sidebarState.notice = "";
  sidebarState.layout = next;
  revision++;
  notifySidebar();
  void saveSidebarState();
}

async function persistSidebarRevision(epoch: number, keepalive = false): Promise<void> {
  const writingRevision = revision;
  timestamp = Math.max(Date.now(), timestamp + 1);
  const response = (await putUiState("sidebar-layout", sidebarState.layout, timestamp, {
    signal: controller.signal,
    keepalive,
  })) as { ok?: boolean; updatedAt?: number };
  if (epoch !== generation) return;
  if (typeof response?.updatedAt === "number" && Number.isFinite(response.updatedAt))
    timestamp = Math.max(timestamp, response.updatedAt);
  if (response?.ok === false && writingRevision > savedRevision) throw new Error("stale");
  savedRevision = Math.max(savedRevision, writingRevision);
  if (savedRevision === revision) sidebarState.error = "";
}

export async function saveSidebarState(): Promise<void> {
  const epoch = generation;
  if (!sidebarState.loaded || savingGeneration === epoch || revision === savedRevision) return;
  savingGeneration = epoch;
  sidebarState.saving = true;
  sidebarState.error = "";
  notifySidebar();
  try {
    while (savedRevision < revision && epoch === generation) await persistSidebarRevision(epoch);
  } catch {
    if (epoch === generation && savedRevision < revision)
      sidebarState.error = "Sidebar changes haven't saved. Try again.";
  } finally {
    if (epoch === generation) {
      sidebarState.saving = false;
      savingGeneration = null;
      notifySidebar();
    }
  }
}

export async function flushSidebarState(): Promise<void> {
  if (!sidebarState.loaded || savedRevision === revision) return;
  const epoch = generation;
  try {
    await persistSidebarRevision(epoch, true);
  } catch {
    if (epoch === generation && savedRevision < revision)
      sidebarState.error = "Sidebar changes haven't saved. Try again.";
  }
  if (epoch === generation) notifySidebar();
}

window.addEventListener("pagehide", () => void flushSidebarState());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushSidebarState();
});
