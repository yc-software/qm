import { openSessionShare } from "./session-share";
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  Archive,
  Binoculars,
  Box,
  Brain,
  Clock3,
  Cog,
  Expand,
  Files,
  KeyRound,
  Link,
  Maximize2,
  MoreHorizontal,
  Plus,
  Rocket,
  Shrink,
  X,
} from "lucide";
import {
  createDockview,
  type DockviewApi,
  type DockviewWillDropEvent,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewGroupPanel,
  type IDockviewPanel,
  type IGroupHeaderProps,
  type IHeaderActionsRenderer,
  type ITabRenderer,
  type SerializedDockview,
  type TabPartInitParameters,
} from "dockview-core";
import {
  dropAddsTile,
  layoutNeedsSessionList,
  MAX_PANES,
  MAX_TILES,
  paneNeedsSessionList,
  serializedTileCount,
  v1PaneSeeds,
  type DropEdge,
  type PaneSeed,
  type SplitEdge,
} from "./split-layout";
import { paneKindByKey, paneKindEntry } from "./pane-kinds";
import { preservingFocus } from "./pane-focus";
import { attachTooltip, tip } from "./tooltip";
import { icon, workingWave } from "./ui";
import { contextsState, scopeTitle } from "./contexts";
import type { DensityTier } from "./density";
import { appState } from "./shell-state";
import { renderSidebarTop, switchView, syncDocumentTitle, syncUrlFromState } from "./shell";
import { sleep } from "./chat";
import {
  createConversation,
  disposeConversation,
  ensureDeliveryStream,
  mainConversation,
  paneDensity,
} from "./conversations";
import type { Conversation } from "./conv-types";
import {
  openSession,
  openSessionInto,
  refreshSessions,
  refreshSessionsOnOpen,
  sessionsReady,
  renderList,
  sessionsState,
  sessionTitle,
  archiveSessionById,
  syncWorkingPulse,
} from "./sessions";
import { conversationBackground, type RowIndicators } from "./session-list";
import { setScopedSession, type SessionTool } from "./session-scope";
import {
  fetchTranscript,
  fetchUiState,
  putUiState,
  TAIL_TURNS,
  type CoreSession,
  type UiStateRecord,
} from "./core-bridge";
import { isPhone, onPhoneChange } from "./viewport";

export const splitState = {
  active: false,
  focusedId: null as string | null,
};

const STORE_KEY = "web-ui:split-canvas:v1";
const REMOTE_STATE_KEY = "split-canvas";

interface PaneParams {
  sessionId?: string;
  threadRef?: string;
  scopeId?: string;
  [kindParamsKey: string]: string | undefined;
}

interface PaneDrag {
  params: PaneParams;
  existing(): IDockviewPanel | null;
  openFull(): void;
  splittableSingle(): boolean;
}

type PendingSeed = { kind: "v2"; layout: SerializedDockview } | { kind: "v1"; seeds: PaneSeed[] };

let canvasHost: HTMLElement | null = null;
let dockApi: DockviewApi | null = null;
let toastEl: HTMLElement | null = null;
let lastLayout: SerializedDockview | null = null;
let pendingSeed: PendingSeed | null = null;
const paneContents = new Map<string, PaneContent>();
const paneTabs = new Set<PaneTab>();
const groupActions = new Set<GroupActions>();
const stripDrops = new Set<StripDrop>();
let paneDrag: PaneDrag | null = null;
let singleOverlay: HTMLElement | null = null;
let toastMsg = "";
let toastTimer: number | null = null;
let headerSignature = "";
let persistTimer: number | null = null;
let remoteTimer: number | null = null;
let remotePayload: { updatedAt: number } | null = null;
let persistedUpdatedAt = 0;

function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

let suspended = false;

function persist(): void {
  if (suspended) return;
  try {
    if (dockApi) lastLayout = dockApi.toJSON();
    persistedUpdatedAt = Date.now();
    const payload = { v: 2, active: splitState.active, layout: lastLayout, updatedAt: persistedUpdatedAt };
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    pushRemoteSoon(payload);
  } catch {
    void 0;
  }
}

function pushRemoteSoon(payload: { updatedAt: number }): void {
  remotePayload = payload;
  if (remoteTimer !== null) window.clearTimeout(remoteTimer);
  remoteTimer = window.setTimeout(() => {
    remoteTimer = null;
    const p = remotePayload;
    remotePayload = null;
    if (p) void putUiState(REMOTE_STATE_KEY, p, p.updatedAt).catch(() => void 0);
  }, 400);
}

function flushRemoteNow(): void {
  if (remoteTimer !== null) {
    window.clearTimeout(remoteTimer);
    remoteTimer = null;
  }
  const p = remotePayload;
  if (!p) return;
  remotePayload = null;
  void putUiState(REMOTE_STATE_KEY, p, p.updatedAt, { keepalive: true }).catch(() => void 0);
}

window.addEventListener("pagehide", flushRemoteNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushRemoteNow();
});

function persistSoon(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 150);
}

function buildDock(): DockviewApi {
  const host = canvasHost!;
  const dockEl = document.createElement("div");
  dockEl.className = "split-dock";
  host.appendChild(dockEl);
  toastEl = document.createElement("div");
  toastEl.className = "split-toast-layer";
  host.appendChild(toastEl);
  const api = createDockview(dockEl, {
    theme: { name: "qm", className: "dockview-theme-qm", gap: 10 },
    createComponent: () => new PaneContent(),
    createTabComponent: () => new PaneTab(),
    createRightHeaderActionComponent: () => new GroupActions(),
    createPrefixHeaderActionComponent: () => new StripDrop(),
    singleTabMode: "fullwidth",
    disableFloatingGroups: true,
  });
  const inner = dockEl.querySelector(":scope > .dv-dockview") as HTMLElement | null;
  const box = (inner ?? dockEl).getBoundingClientRect();
  if (box.width > 0) api.layout(box.width, box.height, true);
  const holdTileCap = (e: DockviewWillDropEvent): void => {
    if (e.getData() === undefined) return;
    if (api.groups.length >= MAX_TILES && dropAddsTile(nativeDrop(api, e))) {
      e.preventDefault();
      canvasToast(`${MAX_TILES} tiles is the limit. Drop it on a tab strip instead`);
    }
  };
  api.onWillDrop(holdTileCap);
  api.onUnhandledDragOver((e) => {
    if (paneDrag && (e.target === "tab" || e.target === "header_space")) e.accept();
  });
  api.onDidDrop((e) => {
    const drag = paneDrag;
    endPaneDrag();
    const anchor = e.group?.activePanel ?? e.group?.panels[0];
    if (!anchor || !drag || focusExistingPane(drag.existing)) return;
    const at = e.panel ? e.group?.panels.indexOf(e.panel) : undefined;
    tabIntoPane(anchor.id, drag.params, at === -1 ? undefined : at);
  });
  const guarded = new WeakSet<IDockviewGroupPanel>();
  api.onDidLayoutChange(() => {
    for (const group of api.groups) {
      if (guarded.has(group)) continue;
      guarded.add(group);
      group.model.onWillDrop(holdTileCap);
    }
    if (paneDrag) refreshPaneDrag();
    persistSoon();
  });
  api.onDidActivePanelChange((e) => {
    splitState.focusedId = e.panel?.id ?? null;
    syncDocumentTitle();
  });
  api.onDidMaximizedGroupChange(() => {
    for (const a of groupActions) a.draw();
  });
  dockEl.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".dv-sash")) return;
    host.classList.add("resizing");
    const up = (): void => {
      host.classList.remove("resizing");
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  return api;
}

function nativeDrop(api: DockviewApi, e: DockviewWillDropEvent): Parameters<typeof dropAddsTile>[0] {
  const from = e.getData();
  return {
    edge: e.position !== "center",
    wholeTile: from !== undefined && from.panelId === null && !from.tabGroupId,
    sourceTilePanes: from ? (api.getGroup(from.groupId)?.panels.length ?? 0) : 0,
  };
}

function disposeDock(): void {
  dockApi?.dispose();
  dockApi = null;
  paneContents.clear();
  paneTabs.clear();
  groupActions.clear();
  stripDrops.clear();
  toastEl = null;
}

function ensureCanvas(): boolean {
  if (!appState.mainEl) return false;
  if (canvasHost && canvasHost.parentElement === appState.mainEl && dockApi) return true;
  disposeDock();
  canvasHost = document.createElement("div");
  canvasHost.className = "split-canvas";
  appState.mainEl.replaceChildren(canvasHost);
  mainConversation().state.host = null;
  dockApi = buildDock();
  const seed = pendingSeed;
  pendingSeed = null;
  try {
    if (lastLayout) {
      dockApi.fromJSON(lastLayout);
    } else if (seed?.kind === "v2") {
      dockApi.fromJSON(seed.layout);
    } else if (seed?.kind === "v1") {
      seedFromV1(dockApi, seed.seeds);
    }
  } catch {
    disposeDock();
    canvasHost.replaceChildren();
    lastLayout = null;
    dockApi = buildDock();
  }
  ensureDeliveryStream();
  splitState.focusedId = dockApi.activePanel?.id ?? dockApi.panels[0]?.id ?? null;
  syncDocumentTitle();
  headerSignature = computeHeaderSignature();
  return true;
}

function paneSeedTitle(params: PaneParams): string {
  const entry = paneKindEntry(params);
  if (entry) return entry.kind.title(entry.id);
  return params.sessionId ? "Conversation" : "New session";
}

function addPane(
  params: PaneParams,
  position?: {
    referencePanel: string;
    direction: "left" | "right" | "above" | "below" | "within";
    index?: number;
  },
): IDockviewPanel {
  return dockApi!.addPanel({
    id: uid(),
    component: "pane",
    tabComponent: "pane",
    title: paneSeedTitle(params),
    params: { ...params },
    ...(position ? { position } : {}),
  });
}

function seedFromV1(api: DockviewApi, seeds: PaneSeed[]): void {
  const placed: IDockviewPanel[] = [];
  for (const [i, seed] of seeds.entries()) {
    const params: PaneParams = {
      ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
      ...(seed.threadRef ? { threadRef: seed.threadRef } : {}),
    };
    let ref = placed[i - 2];
    if (i === 1) ref = placed[0];
    else if (seeds.length === 3) ref = placed[1];
    placed.push(
      addPane(params, i === 0 ? undefined : { referencePanel: ref!.id, direction: i === 1 ? "right" : "below" }),
    );
  }
  persist();
}

export function activateCanvas(first: PaneParams, second: PaneParams, edge: SplitEdge): void {
  if (isPhone()) return;
  mainConversation().teardown();
  mainConversation().composer.resetComposer();
  splitState.active = true;
  lastLayout = null;
  pendingSeed = null;
  if (!ensureCanvas()) return;
  const anchor = addPane(first);
  const fresh = addPane(second, { referencePanel: anchor.id, direction: edgeToDirection(edge) });
  fresh.api.setActive();
  persist();
  renderSidebarTop();
  syncUrlFromState();
  renderList();
}

function edgeToDirection(edge: SplitEdge): "left" | "right" | "above" | "below" {
  if (edge === "top") return "above";
  if (edge === "bottom") return "below";
  return edge;
}

onPhoneChange((phone) => {
  if (phone) {
    if (!splitState.active) return;
    const focused = focusedPaneSession();
    if (dockApi) lastLayout = dockApi.toJSON();

    suspended = true;
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    splitState.active = false;
    splitState.focusedId = null;
    disposeDock();
    canvasHost = null;
    headerSignature = "";
    syncDocumentTitle();
    renderSidebarTop();
    if (appState.currentView !== "chats") return;
    if (focused) void openSession(focused);
    else mainConversation().newChat();
    return;
  }
  if (!suspended && splitState.active) return;
  suspended = false;
  loadPersistedSplit();

  if (!splitState.active || appState.currentView !== "chats") return;

  sessionsState.openingKey = null;
  mainConversation().teardown();
  mainConversation().composer.resetComposer();
  if (!mountRestoredCanvas()) {
    mainConversation().newChat();
    return;
  }
  syncUrlFromState();
  renderList();
});

export function exitSplitIfActive(): void {
  if (!splitState.active) return;
  if (dockApi) lastLayout = dockApi.toJSON();
  splitState.active = false;
  splitState.focusedId = null;
  syncDocumentTitle();
  persist();
  disposeDock();
  canvasHost = null;
  headerSignature = "";
  renderSidebarTop();
}

function adoptPersisted(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;

  if (isPhone()) {
    if (typeof (raw as { updatedAt?: unknown }).updatedAt === "number")
      persistedUpdatedAt = (raw as { updatedAt: number }).updatedAt;
    pendingSeed = null;
    splitState.active = false;
    return;
  }
  const o = raw as { v?: unknown; active?: unknown; layout?: unknown; updatedAt?: unknown };
  if (o.v === 2) {
    if (typeof o.updatedAt === "number") persistedUpdatedAt = o.updatedAt;
    pendingSeed = null;
    splitState.active = false;
    if (o.active !== true || !o.layout || typeof o.layout !== "object") return;
    const panels = (o.layout as { panels?: object }).panels;
    const n = panels && typeof panels === "object" ? Object.keys(panels).length : 0;
    if (n < 2 || n > MAX_PANES || serializedTileCount(o.layout) > MAX_TILES) return;
    pendingSeed = { kind: "v2", layout: o.layout as SerializedDockview };
    splitState.active = true;
    return;
  }
  const seeds = v1PaneSeeds(raw);
  if (!seeds) return;
  pendingSeed = { kind: "v1", seeds };
  splitState.active = true;
}

export function loadPersistedSplit(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  } catch {
    return;
  }
  adoptPersisted(raw);
}

export function fetchRemoteSplit(timeoutMs = 2000): Promise<UiStateRecord | null> {
  return Promise.race([
    fetchUiState(REMOTE_STATE_KEY).catch(() => null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export async function adoptRemoteSplit(pending: Promise<UiStateRecord | null>): Promise<void> {
  const rec = await pending;
  if (!rec || typeof rec !== "object") return;
  const at = typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  if (!rec.value || typeof rec.value !== "object" || at <= persistedUpdatedAt) return;
  adoptPersisted(rec.value);
  persistedUpdatedAt = at;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...rec.value, updatedAt: at }));
  } catch {
    void 0;
  }
}

export function restoredCanvasNeedsSessionList(): boolean {
  if (!pendingSeed) return false;
  if (pendingSeed.kind === "v1") return pendingSeed.seeds.some((seed) => paneNeedsSessionList(seed));
  return layoutNeedsSessionList(pendingSeed.layout);
}

export function mountRestoredCanvas(): boolean {
  if (splitState.active && (dockApi?.panels.length ?? 0) > 0) return true;
  if (!splitState.active || (!pendingSeed && !lastLayout)) return false;
  if (!ensureCanvas()) {
    splitState.active = false;
    return false;
  }
  if ((dockApi?.panels.length ?? 0) === 0) {
    exitSplitIfActive();
    return false;
  }
  renderSidebarTop();
  renderList();
  return true;
}

function panelParams(panel: IDockviewPanel): PaneParams {
  return (panel.params ?? {}) as PaneParams;
}

function paneShowing(sessionId: string): IDockviewPanel | null {
  return dockApi?.panels.find((p) => panelParams(p).sessionId === sessionId) ?? null;
}

export function sessionInCanvas(sessionId: string): boolean {
  return splitState.active && paneShowing(sessionId) !== null;
}

/** Close any pane (and, outside the canvas, the main view) showing this session. */
export function closeSessionSurfaces(sessionId: string): boolean {
  if (!sessionId) return false;
  if (splitState.active && dockApi) {
    const showing = dockApi.panels.filter((p) => panelParams(p).sessionId === sessionId);
    if (showing.length) {
      closePanels(showing);
      return true;
    }
    return false;
  }
  const conv = mainConversation();
  if (conv.state.sessionId !== sessionId) return false;
  conv.newChat();
  return true;
}

export function splitInterceptsOpen(s: CoreSession): boolean {
  if (!splitState.active || appState.currentView !== "chats" || !s.id) return false;
  const target = splitState.focusedId ?? dockApi?.panels[0]?.id ?? "";
  openTargetInPane(target, sessionTarget(s.id, s.threadRef));
  renderList();
  refreshSessionsOnOpen();
  return true;
}

export function openBackgroundInCanvas(s: CoreSession): boolean {
  if (!s.id || !mountRestoredCanvas() || !dockApi) return false;
  const showing = paneShowing(s.id);
  if (showing) {
    activatePanel(showing);
    paneContents.get(showing.id)?.conversation?.requestBackgroundPanel(s.id, s.threadRef);
    return true;
  }
  const target = splitState.focusedId ?? dockApi.activePanel?.id ?? dockApi.panels[0]?.id ?? "";
  openTargetInPane(target, {
    ...sessionTarget(s.id, s.threadRef),
    params: { sessionId: s.id, threadRef: s.threadRef },
  });
  const opened = paneShowing(s.id);
  if (opened) paneContents.get(opened.id)?.conversation?.requestBackgroundPanel(s.id, s.threadRef);
  renderList();
  return true;
}

function sessionTarget(sessionId: string, threadRef: string): Pick<PaneDrag, "params" | "existing"> {
  return { params: { sessionId, threadRef }, existing: () => paneShowing(sessionId) };
}

function focusExistingPane(existing: () => IDockviewPanel | null, exceptPaneId?: string): boolean {
  const dup = existing();
  if (!dup) return false;
  if (dup.id !== exceptPaneId) {
    activatePanel(dup);
    canvasToast("Already open in a pane");
  }
  return true;
}

function openTargetInPane(paneId: string, target: Pick<PaneDrag, "params" | "existing">): void {
  if (!dockApi || focusExistingPane(target.existing, paneId)) return;
  const panel = dockApi.getPanel(paneId);
  if (!panel) return;
  const fresh = addPane(target.params, { referencePanel: panel.id, direction: "within" });
  dockApi.removePanel(panel);
  fresh.api.setActive();
  persist();
}

function roomForAnotherPane(): boolean {
  if ((dockApi?.panels.length ?? 0) < MAX_PANES) return true;
  canvasToast(`${MAX_PANES} conversations is all one canvas holds. Close one first`);
  return false;
}

function splitPane(paneId: string, edge: SplitEdge, params: PaneParams): void {
  if (!dockApi || !roomForAnotherPane()) return;
  if (dockApi.groups.length >= MAX_TILES) {
    if (tabIntoPane(paneId, params)) canvasToast(`${MAX_TILES} tiles is the limit, so it opened as a tab`);
    return;
  }
  const fresh = addPane(params, { referencePanel: paneId, direction: edgeToDirection(edge) });
  fresh.api.setActive();
  persist();
}

function tabIntoPane(paneId: string, params: PaneParams, index?: number): boolean {
  if (!dockApi || !roomForAnotherPane()) return false;
  const fresh = addPane(params, {
    referencePanel: paneId,
    direction: "within",
    ...(index === undefined ? {} : { index }),
  });
  fresh.api.setActive();
  persist();
  return true;
}

export function startNewChatInCanvas(scopeId?: string, threadRef?: string): Conversation | null {
  if (!splitState.active || !dockApi) return null;
  if (appState.currentView !== "chats") switchView("chats");
  if (!ensureCanvas() || !dockApi) return null;
  const target = dockApi.activePanel ?? dockApi.panels[0];
  if (!target) return null;
  const replace = dockApi.panels.length === 1 || dockApi.panels.length >= MAX_PANES;
  const tile = !replace && dockApi.groups.length === 2;
  const { width, height } = target.group.element.getBoundingClientRect();
  const direction = width >= height ? "right" : "below";
  const fresh = addPane(
    { ...(scopeId ? { scopeId } : {}), ...(threadRef ? { threadRef } : {}) },
    { referencePanel: target.id, direction: tile ? direction : "within" },
  );
  if (replace) dockApi.removePanel(target);
  fresh.api.setActive();
  persist();
  return paneContents.get(fresh.id)?.conversation ?? null;
}

function paneSplitWithBlank(panel: IDockviewPanel): void {
  const r = panel.group.element.getBoundingClientRect();
  splitPane(panel.id, r.width >= r.height ? "right" : "bottom", {});
}

function closePanels(panels: IDockviewPanel[]): void {
  if (!dockApi) return;
  for (const p of panels) {
    dockApi.removePanel(p);
  }
  reconcileAfterClose();
}

function reconcileAfterClose(): void {
  const rest = dockApi?.panels ?? [];
  if (rest.length === 0) {
    exitSplitIfActive();
    mainConversation().newChat();
    return;
  }
  if (rest.length === 1) {
    const lone = rest[0]!;
    const params = panelParams(lone);
    if (params.sessionId || paneKindEntry(params)) {
      void maximizePane(params);
    } else {
      exitSplitIfActive();
      mainConversation().newChat();
    }
    return;
  }
  persist();
}

async function maximizePane(params: PaneParams): Promise<void> {
  const entry = paneKindEntry(params);
  if (entry) {
    entry.kind.maximize(entry.id);
    return;
  }
  if (!params.sessionId) {
    canvasToast("Start the chat first, then open it full screen");
    return;
  }
  const find = (): CoreSession | undefined => sessionsState.list.find((s) => s.id === params.sessionId);
  let session = find();
  if (!session) {
    try {
      await refreshSessions({ silent: true });
    } catch {
      void 0;
    }
    session = find();
    if (!session) {
      canvasToast("Still syncing this conversation. Try again in a moment");
      return;
    }
  }
  exitSplitIfActive();
  void openSession(session);
}

function activatePanel(panel: IDockviewPanel): void {
  if (panel.group.activePanel === panel) panel.group.api.setActive();
  else panel.api.setActive();
}

function focusPane(paneId: string): void {
  const panel = dockApi?.getPanel(paneId);
  if (!panel || panel.api.isActive) return;
  preservingFocus(document, () => activatePanel(panel));
}

export function canvasToast(msg: string): void {
  toastMsg = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    toastMsg = "";
    drawToast();
  }, 2500);
  drawToast();
}

function drawToast(): void {
  if (!toastEl) return;
  render(toastMsg ? html`<div class="split-toast" role="status">${toastMsg}</div>` : nothing, toastEl);
}

export function beginSessionDrag(s: CoreSession): void {
  if (!s.id) return;
  const sessionId = s.id;
  beginPaneDrag({
    ...sessionTarget(sessionId, s.threadRef),
    openFull: () => {
      const session = sessionsState.list.find((x) => x.id === sessionId);
      if (session) void openSession(session);
    },
    splittableSingle: () => mainConversation().state.sessionId !== sessionId,
  });
}

export function beginPaneKindDrag(paramsKey: string, id: string): void {
  const kind = paneKindByKey(paramsKey);
  if (!kind) return;
  beginPaneDrag({
    params: { [kind.paramsKey]: id },
    existing: () => dockApi?.panels.find((p) => panelParams(p)[kind.paramsKey] === id) ?? null,
    openFull: () => kind.maximize(id),
    splittableSingle: () => true,
  });
}

function beginPaneDrag(drag: PaneDrag): void {
  paneDrag = drag;
  if (splitState.active) refreshPaneDrag();
  else showSingleDropOverlay();
}

function refreshPaneDrag(): void {
  const drag = paneDrag;
  if (!drag) return;
  const addsTab = !drag.existing() && (dockApi?.panels.length ?? 0) < MAX_PANES;
  canvasHost?.classList.toggle("session-dragging", addsTab);
  drawStripDrops();
  syncAllZones();
}

// really add one (not already on the canvas, below the pane ceiling).
function stripJoinable(drag = paneDrag): boolean {
  return Boolean(drag && !drag.existing() && (dockApi?.panels.length ?? 0) < MAX_PANES);
}

function drawStripDrops(): void {
  for (const s of stripDrops) s.draw();
}

export function endPaneDrag(): void {
  if (!paneDrag) return;
  paneDrag = null;
  hideSingleDropOverlay();
  canvasHost?.classList.remove("session-dragging");
  drawStripDrops();
  if (splitState.active) syncAllZones();
}

function syncAllZones(): void {
  for (const c of paneContents.values()) c.syncZones();
}

document.addEventListener("mousemove", (e) => {
  if (e.buttons === 0) endPaneDrag();
});

function zoneTpl(edge: DropEdge, label: string, onDrop: () => void): TemplateResult {
  const over = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    (e.currentTarget as HTMLElement).classList.add("over");
  };
  const leave = (e: DragEvent): void => (e.currentTarget as HTMLElement).classList.remove("over");
  const drop = (e: DragEvent): void => {
    e.preventDefault();
    onDrop();
  };
  return html`<div class="split-zone zone-${edge}" @dragover=${over} @dragleave=${leave} @drop=${drop}>
    <span>${label}</span>
  </div>`;
}

function splitZonesTpl(act: (edge: DropEdge) => () => void): TemplateResult {
  return html`
    ${zoneTpl("left", "Split left", act("left"))} ${zoneTpl("right", "Split right", act("right"))}
    ${zoneTpl("top", "Split up", act("top"))} ${zoneTpl("bottom", "Split down", act("bottom"))}
  `;
}

function zonesTpl(act: (edge: DropEdge) => () => void): TemplateResult {
  return html`${zoneTpl("center", "Open here", act("center"))} ${splitZonesTpl(act)}`;
}

function paneZonesTpl(paneId: string): TemplateResult | typeof nothing {
  const drag = paneDrag;
  if (!dockApi || !drag) return nothing;
  const showing = drag.existing();
  if (showing)
    return showing.id === paneId
      ? zoneTpl("center", "Show here", () => {
          endPaneDrag();
          focusPane(paneId);
        })
      : nothing;
  const act = paneZoneAct(paneId);
  const canSplit = dockApi.panels.length < MAX_PANES && dockApi.groups.length < MAX_TILES;
  return html`${zoneTpl("center", "Open here", act("center"))} ${canSplit ? splitZonesTpl(act) : nothing}`;
}

function paneZoneAct(paneId: string): (edge: DropEdge) => () => void {
  return (edge) => () => {
    const drag = paneDrag;
    endPaneDrag();
    if (!drag) return;
    if (edge === "center") {
      openTargetInPane(paneId, drag);
      return;
    }
    if (focusExistingPane(drag.existing)) return;
    splitPane(paneId, edge, drag.params);
  };
}

function currentChatParams(): PaneParams | null {
  const conv = mainConversation();
  const chatState = conv.state;
  if (!chatState.host) return null;
  if (chatState.sessionId)
    return { sessionId: chatState.sessionId, ...(chatState.threadRef ? { threadRef: chatState.threadRef } : {}) };
  const untouched =
    !chatState.pendingSend && !conv.composer.state.draft.trim() && (chatState.agent?.state.messages.length ?? 0) === 0;
  return untouched ? {} : null;
}

function showSingleDropOverlay(): void {
  if (splitState.active || appState.currentView !== "chats" || !appState.mainEl || singleOverlay) return;
  const drag = paneDrag;
  if (!drag) return;
  const act = (edge: DropEdge) => () => {
    endPaneDrag();
    const current = edge === "center" ? null : currentChatParams();
    if (edge === "center" || !current || !drag.splittableSingle()) {
      drag.openFull();
      return;
    }
    activateCanvas(current, drag.params, edge);
  };
  const splittable = drag.splittableSingle() && currentChatParams() !== null;
  singleOverlay = document.createElement("div");
  singleOverlay.className = "split-zones split-zones-single";
  render(splittable ? zonesTpl(act) : zoneTpl("center", "Open here", act("center")), singleOverlay);
  appState.mainEl.appendChild(singleOverlay);
}

function hideSingleDropOverlay(): void {
  singleOverlay?.remove();
  singleOverlay = null;
}

export function drawCanvas(): void {
  if (!splitState.active || appState.currentView !== "chats" || !appState.mainEl) return;
  if (!ensureCanvas()) return;
  refreshHeaders();
}

function computeHeaderSignature(): string {
  return (dockApi?.panels ?? [])
    .map(
      (p) =>
        `${p.id}|${paneSession(p)?.id ?? ""}|${paneCrumb(p) ?? ""}|${paneTitle(p)}|${paneIsWorking(p)}|${paneAwaitsInput(p)}|${paneBackground(p)?.label ?? ""}|${paneKindBadge(p)}`,
    )
    .join("~");
}

export function notifyPanesChanged(): void {
  if (!splitState.active || !dockApi) return;
  if (computeHeaderSignature() === headerSignature) return;
  refreshHeaders();
}

function refreshHeaders(): void {
  headerSignature = computeHeaderSignature();
  for (const t of paneTabs) t.draw();
  for (const a of groupActions) a.draw();
  for (const c of paneContents.values()) c.syncTitle();
  syncDocumentTitle();
}

function paneSession(panel: IDockviewPanel): CoreSession | undefined {
  const { sessionId } = panelParams(panel);
  return sessionId ? sessionsState.list.find((s) => s.id === sessionId) : undefined;
}

export function focusedPaneSession(): CoreSession | undefined {
  if (!splitState.active || !dockApi) return undefined;
  const panel = (splitState.focusedId && dockApi.getPanel(splitState.focusedId)) || dockApi.activePanel;
  return panel ? paneSession(panel) : undefined;
}

function paneTitle(panel: IDockviewPanel): string {
  const params = panelParams(panel);
  const entry = paneKindEntry(params);
  if (entry) return entry.kind.title(entry.id);
  const session = paneSession(panel);
  if (session) return sessionTitle(session);
  return params.sessionId ? "Conversation" : "New session";
}

function paneKindBadge(panel: IDockviewPanel): number {
  const entry = paneKindEntry(panelParams(panel));
  return entry ? entry.kind.badge(entry.id) : 0;
}

function paneScopeId(panel: IDockviewPanel): string | null {
  return paneSession(panel)?.scopeId || panelParams(panel).scopeId || null;
}

function paneCrumb(panel: IDockviewPanel): string | null {
  const scope = paneScopeId(panel);
  if (!scope || scope.startsWith("personal:")) return null;
  const context = contextsState.list.find((c) => c.scopeId === scope);
  return scopeTitle(scope, context?.name ?? null);
}

const PANE_TOOLS: { tool: SessionTool; glyph: Parameters<typeof icon>[0]; label: string }[] = [
  { tool: "crons", glyph: Clock3, label: "Crons" },
  { tool: "files", glyph: Files, label: "Files" },
  { tool: "apps", glyph: Rocket, label: "Apps" },
  { tool: "skills", glyph: Box, label: "Skills" },
  { tool: "memory", glyph: Brain, label: "Memory" },
  { tool: "keychain", glyph: KeyRound, label: "Your keychain" },
];

function openPaneTool(panel: IDockviewPanel, tool: SessionTool): void {
  const params = panelParams(panel);
  const session = paneSession(panel);
  const scope = paneScopeId(panel) ?? "";
  setScopedSession({
    scopeId: scope,
    sessionId: params.sessionId ?? session?.id ?? null,
    threadRef: params.threadRef ?? null,
    title: session?.title?.trim() || "New chat",
    crumb: paneCrumb(panel),
  });
  if (scope && (tool === "crons" || tool === "files" || tool === "apps")) contextsState.selected = scope;
  switchView(tool === "apps" ? "deploys" : tool);
}

function paneIsWorking(panel: IDockviewPanel): boolean {
  const conv = paneContents.get(panel.id)?.conversation;
  const agent = conv?.state.agent;
  if (agent?.state.isStreaming || (conv && conv.state.pendingSend !== null)) return true;
  return Boolean(paneSession(panel)?.working);
}

function paneAwaitsInput(panel: IDockviewPanel): boolean {
  return Boolean(paneSession(panel)?.awaitingInput);
}

function paneBackground(panel: IDockviewPanel): RowIndicators["background"] {
  const { sessionId, threadRef } = panelParams(panel);
  return conversationBackground(sessionsState.list, sessionId ?? null, threadRef ?? null);
}

class PaneContent implements IContentRenderer {
  readonly element: HTMLElement;
  conversation: Conversation | null = null;
  private kindPane: { dispose(): void } | null = null;
  private readonly chatEl: HTMLElement;
  private readonly zonesEl: HTMLElement;
  private readonly resize: ResizeObserver;
  private panelId = "";
  private panel: IDockviewPanel | null = null;
  private params: PaneParams = {};
  private density: DensityTier = "full";
  private loaded = false;
  private disposed = false;
  private redrawOnResize: Array<() => void> = [];

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "split-pane-content";
    this.chatEl = document.createElement("div");
    this.chatEl.className = "split-pane-chat";
    this.zonesEl = document.createElement("div");
    this.zonesEl.className = "split-zones";
    this.element.append(this.chatEl, this.zonesEl);
    this.element.addEventListener("focusin", () => focusPane(this.panelId));
    this.resize = new ResizeObserver(() => this.syncDensity());
  }

  private ensureConversation(): Conversation {
    this.conversation ??= createConversation({
      pane: true,
      ownsUrl: false,
      container: () => this.chatEl,
      claimContainer: () => this.chatEl,
      visible: () => splitState.active && appState.currentView === "chats",
      density: () => this.density,
      onDensityChange: (handler) => this.redrawOnResize.push(handler),
      ensureDeliveryStream,
      onState: (paneState) => {
        notePaneSession(this.panelId, paneState.sessionId, paneState.threadRef);
        refreshHeaders();
      },
      onExpand: () => {
        const panel = dockApi?.getPanel(this.panelId);
        if (panel && !panel.api.isMaximized()) panel.api.maximize();
      },
    });
    return this.conversation;
  }

  init(p: GroupPanelPartInitParameters): void {
    this.panelId = p.api.id;
    this.panel = p.containerApi.getPanel(p.api.id) ?? null;
    this.params = (p.params ?? {}) as PaneParams;
    this.element.dataset.paneId = this.panelId;
    paneContents.set(this.panelId, this);
    this.resize.observe(this.element);
    this.syncZones();
    p.api.onDidDimensionsChange(() => this.syncDensity());
    p.api.onDidVisibilityChange((e) => {
      if (!e.isVisible) return;
      if (!this.loaded) {
        void this.load();
        return;
      }
      this.syncDensity();
      this.conversation?.scrollToBottom();
    });
    if (p.api.isVisible) void this.load();
  }

  private syncDensity(): void {
    const next = paneDensity(this.element);
    if (!next) return;
    const changed = next !== this.density;
    this.element.dataset.density = this.density = next;
    if (!changed) return;
    for (const handler of this.redrawOnResize) handler();
  }

  private async load(): Promise<void> {
    if (this.loaded || this.disposed) return;
    this.loaded = true;
    this.syncDensity();
    const { sessionId, threadRef, scopeId } = this.params;
    const entry = paneKindEntry(this.params);
    if (entry) {
      this.kindPane = entry.kind.mount({
        host: this.chatEl,
        id: entry.id,
        density: () => this.density,
        onDensityChange: (handler) => this.redrawOnResize.push(handler),
      });
      return;
    }
    const conversation = this.ensureConversation();
    const wanted =
      sessionId ?? (threadRef ? (sessionsState.list.find((s) => s.threadRef === threadRef)?.id ?? null) : null);
    if (!wanted) {
      if (threadRef) {
        conversation.mountContinuable(threadRef, null, scopeId ?? null, []);
        return;
      }
      const context = scopeId ? contextsState.list.find((c) => c.scopeId === scopeId) : undefined;
      conversation.newChat(context ? { scopeId: context.scopeId, name: context.name ?? null } : undefined);
      return;
    }
    conversation.mountLoadingPane();
    let session = sessionsState.list.find((s) => s.id === wanted);
    if (!session) {
      await sessionsReady();
      if (this.disposed) return;
      session = sessionsState.list.find((s) => s.id === wanted);
    }
    if (!session) {
      await refreshSessions({ silent: true });
      if (this.disposed) return;
      session = sessionsState.list.find((s) => s.id === wanted);
    }
    if (!session) {
      const page = await fetchTranscript(wanted, { tailTurns: TAIL_TURNS }).catch(() => null);
      if (this.disposed) return;
      session = page?.session;
      if (!session) {
        conversation.mountReadOnly(
          { id: wanted, threadRef: threadRef ?? "", scopeId: "", title: "" } as CoreSession,
          [],
        );
        return;
      }
      await openSessionInto(conversation, session, Promise.resolve(page));
      if (this.disposed) return;
      refreshHeaders();
      return;
    }
    await openSessionInto(conversation, session);
    if (this.disposed) return;
    refreshHeaders();
  }

  update(p: { params: Record<string, unknown> }): void {
    this.params = (p.params ?? {}) as PaneParams;
    this.syncTitle();
  }

  syncTitle(): void {
    if (this.panel) attachTooltip(this.element, paneTitle(this.panel));
  }

  syncZones(): void {
    render(paneDrag ? paneZonesTpl(this.panelId) : nothing, this.zonesEl);
  }

  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    paneContents.delete(this.panelId);
    this.kindPane?.dispose();
    this.kindPane = null;
    if (this.conversation) disposeConversation(this.conversation);
  }
}

function sessionActions(sessionId: string, inTab: boolean): TemplateResult {
  const cls = inTab ? "split-tab-close" : "split-group-session-action";
  return html`<button
      type="button"
      class="icon-btn subtle ${cls} split-tab-share"
      ${tip("Share conversation")}
      aria-label="Share conversation"
      @pointerdown=${(e: Event) => {
        if (inTab) e.stopPropagation();
      }}
      @click=${(e: Event) => {
        if (inTab) e.stopPropagation();
        void openSessionShare(sessionId);
      }}
    >
      ${icon(Link, 13)}
    </button>
    <button
      class="icon-btn subtle ${cls} split-tab-archive"
      type="button"
      title="Archive session"
      aria-label="Archive session"
      @pointerdown=${(e: Event) => {
        if (inTab) e.stopPropagation();
      }}
      @click=${(e: Event) => {
        if (inTab) e.stopPropagation();
        archiveSessionById(sessionId);
      }}
    >
      ${icon(Archive, 13)}
    </button>`;
}

class PaneTab implements ITabRenderer {
  readonly element: HTMLElement;
  private panelId = "";
  private panel: IDockviewPanel | null = null;
  private inStrip = false;

  constructor() {
    this.element = document.createElement("span");
    this.element.className = "split-pane-title";
  }

  init(p: TabPartInitParameters): void {
    this.panelId = p.api.id;
    this.inStrip = p.tabLocation === "header";
    if (this.inStrip) paneTabs.add(this);
    this.draw();
  }

  update(): void {
    this.draw();
  }

  draw(): void {
    this.panel ??= dockApi?.getPanel(this.panelId) ?? null;
    const panel = this.panel;
    if (!panel) return;
    const entry = paneKindEntry(panelParams(panel));
    if (entry) {
      const title = entry.kind.title(entry.id);
      const count = entry.kind.badge(entry.id);
      this.element.title = title;
      render(
        html`
          <span class="pane-kind-glyph">${icon(entry.kind.glyph, 12)}</span>
          <span class="split-pane-title-text">${title}</span>
          ${count > 0 ? html`<span class="pane-kind-count" title=${`${count} waiting on you`}>${count}</span>` : nothing}
          ${
            this.inStrip
              ? html`<span class="split-tab-actions"
                  ><button
                    class="icon-btn subtle split-tab-close"
                    type="button"
                    ${tip("Close pane")}
                    aria-label="Close pane"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      closePanels([panel]);
                    }}
                  >
                    ${icon(X, 13)}
                  </button></span
                >`
              : nothing
          }
        `,
        this.element,
      );
      return;
    }
    const title = paneTitle(panel);
    const crumb = paneCrumb(panel);
    const working = paneIsWorking(panel);
    const awaiting = paneAwaitsInput(panel);
    const background = paneBackground(panel);
    const sessionId = panelParams(panel).sessionId ?? paneSession(panel)?.id;
    attachTooltip(this.element, crumb ? `${crumb} / ${title}` : title);
    render(
      html`
        ${working ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}
        ${awaiting ? html`<span class="awaiting-dot" aria-label="Waiting for your reply"></span>` : nothing}
        ${
          background
            ? html`<span class="bg-chip" aria-label=${background.label} ${tip(background.label)}
                >${background.jobs > 0 ? icon(Cog, 11) : nothing}${
                  background.watches > 0 ? icon(Binoculars, 11) : nothing
                }${background.crons > 0 ? icon(Clock3, 11) : nothing}</span
              >`
            : nothing
        }
        ${
          crumb
            ? html`<span class="split-pane-crumb">${crumb}</span><span class="split-pane-crumb-sep">/</span>`
            : nothing
        }
        <span class="split-pane-title-text" dir="auto">${title}</span>
        ${
          this.inStrip
            ? html`<span class="split-tab-actions">
                ${sessionId ? sessionActions(sessionId, true) : nothing}
                <button
                  class="icon-btn subtle split-tab-close"
                  type="button"
                  ${tip("Close pane")}
                  aria-label="Close pane"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    closePanels([panel]);
                  }}
                >
                  ${icon(X, 13)}
                </button></span
              >`
            : nothing
        }
      `,
      this.element,
    );
  }

  dispose(): void {
    paneTabs.delete(this);
  }
}

// The strip highlight needs a target behind it: with full-width single tabs dockview's
// header space is zero-width and a tab only accepts its outer reorder edges, so an
// external session drag has nothing real to land on. Dockview owns this element's
// lifecycle, so the zone is mounted and torn down with its group.
class StripDrop implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private group: IDockviewGroupPanel | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "split-zones strip-zones";
  }

  init(props: IGroupHeaderProps): void {
    this.group = props.group;
    stripDrops.add(this);
    this.draw();
  }

  draw(): void {
    const group = this.group;
    render(
      group && stripJoinable()
        ? zoneTpl("center", "Open as tab", () => {
            const drag = paneDrag;
            endPaneDrag();
            const anchor = group.activePanel ?? group.panels[0];
            if (!drag || !anchor || focusExistingPane(drag.existing)) return;
            tabIntoPane(anchor.id, drag.params);
          })
        : nothing,
      this.element,
    );
  }

  dispose(): void {
    stripDrops.delete(this);
  }
}

class GroupActions implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private props: IGroupHeaderProps | null = null;
  private menuOpen = false;

  constructor() {
    this.element = document.createElement("span");
    this.element.className = "split-pane-actions";
  }

  init(props: IGroupHeaderProps): void {
    this.props = props;
    groupActions.add(this);
    document.addEventListener("click", this.onDocClick);
    this.draw();
  }

  private readonly onDocClick = (e: Event): void => {
    if (!this.menuOpen) return;
    const tools = this.element.querySelector(".split-tools");
    if (tools && e.composedPath().includes(tools)) return;
    this.menuOpen = false;
    this.draw();
  };

  private readonly placeMenu = (el?: Element): void => {
    if (!(el instanceof HTMLElement)) return;
    const rect = this.element.querySelector(".split-tools-btn")?.getBoundingClientRect();
    if (!rect) return;
    el.style.position = "fixed";
    el.style.top = `${rect.bottom + 6}px`;
    el.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    el.style.left = "auto";
  };

  draw(): void {
    const props = this.props;
    if (!props) return;
    const activePanel = (): IDockviewPanel | null => {
      const g = dockApi?.groups.find((x) => x.id === props.group.id);
      return g?.activePanel ?? g?.panels[0] ?? null;
    };
    const panel = activePanel();
    const sessionId =
      panel && !paneKindEntry(panelParams(panel)) ? (panelParams(panel).sessionId ?? paneSession(panel)?.id) : null;
    const maximized = props.api.isMaximized();
    const runTool = (tool: SessionTool): void => {
      this.menuOpen = false;
      const p = activePanel();
      this.draw();
      if (p) openPaneTool(p, tool);
    };
    const menu = this.menuOpen
      ? html`
          <div
            class="session-menu-popover split-tools-menu"
            role="menu"
            ${ref(this.placeMenu)}
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${PANE_TOOLS.map(
              (t) => html`
                <button class="session-menu-option" type="button" role="menuitem" @click=${() => runTool(t.tool)}>
                  ${icon(t.glyph, 15)}<span>${t.label}</span>
                </button>
              `,
            )}
            <div class="split-tools-menu-sep" role="separator"></div>
            <button
              class="session-menu-option"
              type="button"
              role="menuitem"
              @click=${() => {
                this.menuOpen = false;
                this.draw();
                if (maximized) props.api.exitMaximized();
                else props.api.maximize();
              }}
            >
              ${icon(maximized ? Shrink : Expand, 15)}<span
                >${maximized ? "Restore to grid (Esc)" : "Focus over the grid"}</span
              >
            </button>
          </div>
        `
      : nothing;
    const buttons: { label: string; glyph: TemplateResult | SVGElement; cls?: string; run: () => void }[] = [
      {
        label: "Split this pane with a new session",
        glyph: icon(Plus, 15),
        run: () => {
          const p = activePanel();
          if (p) paneSplitWithBlank(p);
        },
      },
      {
        label: "Open full screen",
        glyph: icon(Maximize2, 14),
        run: () => {
          const p = activePanel();
          if (p) void maximizePane(panelParams(p));
        },
      },
      {
        label: "Close pane",
        glyph: icon(X, 15),
        cls: " split-group-close",
        run: () => {
          const g = dockApi?.groups.find((x) => x.id === props.group.id);
          if (g) closePanels([...g.panels]);
        },
      },
    ];
    render(
      html`<span class="split-tools">
          <button
            class="icon-btn subtle split-tools-btn ${this.menuOpen ? "active" : ""}"
            type="button"
            ${tip("Tools")}
            aria-label="Tools"
            aria-haspopup="menu"
            aria-expanded=${this.menuOpen ? "true" : "false"}
            @click=${() => {
              this.menuOpen = !this.menuOpen;
              this.draw();
            }}
          >
            ${icon(MoreHorizontal, 15)}
          </button>
          ${menu}
        </span>
        ${sessionId ? sessionActions(sessionId, false) : nothing}
        ${buttons.map(
          (b) =>
            html`<button
              class="icon-btn subtle${b.cls ?? ""}"
              type="button"
              ${tip(b.label)}
              aria-label=${b.label}
              @click=${b.run}
            >
              ${b.glyph}
            </button>`,
        )}`,
      this.element,
    );
  }

  dispose(): void {
    document.removeEventListener("click", this.onDocClick);
    groupActions.delete(this);
  }
}

function notePaneSession(paneId: string, sessionId: string | null, threadRef: string | null): void {
  const panel = dockApi?.getPanel(paneId);
  if (!panel) return;
  const params = panelParams(panel);
  if (params.sessionId || (!sessionId && (!threadRef || threadRef === params.threadRef))) return;
  panel.api.updateParameters({
    ...(sessionId ? { sessionId } : {}),
    ...(threadRef ? { threadRef } : {}),
  });
  persist();
  if (sessionId) void settlePaneTitle(sessionId);
  refreshHeaders();
}

async function settlePaneTitle(sessionId: string): Promise<void> {
  const titled = (): boolean => Boolean(sessionsState.list.find((s) => s.id === sessionId)?.title?.trim());
  await settlePoll([0, 1200, 2400, 4000, 6000], titled);
}

async function settlePoll(delays: number[], done: () => boolean): Promise<void> {
  for (const delay of delays) {
    if (delay) await sleep(delay);
    if (!splitState.active) return;
    try {
      await refreshSessions({ silent: true });
    } catch {
      void 0;
    }
    if (done()) return;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && splitState.active && dockApi?.hasMaximizedGroup()) dockApi.exitMaximizedGroup();
});
