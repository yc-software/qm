import { html, nothing, render } from "lit";
import { ChevronDown, ChevronUp, Pin, PinOff, X } from "lucide";
import { api, withBase, type CoreSession, type SessionStateEvent } from "./core-bridge.ts";
import type { ConvCtx, Conversation } from "./conv-types.ts";
import { appState } from "./shell-state.ts";
import { icon } from "./ui.ts";
import { errMessage, swallow } from "../../chassis/src/errors.ts";

type Owner = Pick<ConvCtx, "chat" | "composer">;

interface CanvasRecord {
  html: string;
  css: string;
  js: string;
  pinned: boolean;
  rev: number;
}

interface Panel {
  sessionId: string;
  el: HTMLElement;
  head: HTMLElement;
  shadow: ShadowRoot;
  canvas: CanvasRecord | null;
  expanded: boolean;
  owner: Owner;
  script: HTMLScriptElement | null;
  lifetime: AbortController;
  cleanups: Array<() => void>;
}

interface UiCanvasApi {
  sessionId: string;
  rev: number;
  root: ShadowRoot;
  signal: AbortSignal;
  onDispose(fn: () => void): void;
  send(text: string): Promise<boolean>;
}

type UiSignal =
  { kind: "canvas" } | { kind: "observe"; callId: string; selector?: string; css?: boolean; screenshot?: boolean };

declare global {
  interface Window {
    qmUiCanvasTake?: (sessionId: string, rev: number) => UiCanvasApi | undefined;
  }
}

const SNAPSHOT_BUDGET_BYTES = 700_000;
const SCREENSHOT_BUDGET_CHARS = 600_000;
const HIDDEN_TAB_DELAY_MS = 1_500;
const SENT_PREFIX = "[canvas] ";

const loaded = new Map<string, CanvasRecord | null>();
const loading = new Map<string, { dirty: boolean }>();
const panels = new Map<string, Panel>();
const handoff = new Map<string, UiCanvasApi>();
const waiting = new Map<string, Set<Owner>>();
const announced = new Set<string>();

function take(sessionId: string, rev: number): UiCanvasApi | undefined {
  const key = `${sessionId}#${rev}`;
  const handed = handoff.get(key);
  handoff.delete(key);
  return handed;
}

function disabled(): boolean {
  return !appState.me || Boolean(appState.me.impersonatedBy);
}

function load(sessionId: string, owner?: Owner): void {
  if (owner) waiting.set(sessionId, (waiting.get(sessionId) ?? new Set()).add(owner));
  const inFlight = loading.get(sessionId);
  if (inFlight) {
    if (!owner) inFlight.dirty = true;
    return;
  }
  const state = { dirty: false };
  loading.set(sessionId, state);
  void api<{ canvas: CanvasRecord }>(`/api/ui-canvas/${encodeURIComponent(sessionId)}`)
    .then((r) => r.canvas)
    .catch(() => null)
    .then((canvas) => {
      loading.delete(sessionId);
      if (state.dirty) return load(sessionId);
      loaded.set(sessionId, canvas);
      const panel = panels.get(sessionId);
      if (panel && !canvas) disposePanel(panel);
      else if (panel && canvas) applyCanvas(panel, canvas);
      if (!canvas || panel) announced.delete(sessionId);
      for (const o of waiting.get(sessionId) ?? []) o.chat.redraw();
      if (panel) panel.owner.chat.redraw();
      waiting.delete(sessionId);
    });
}

export function uiCanvasPanel(owner: Owner): HTMLElement | typeof nothing {
  const sessionId = owner.chat.state.sessionId;
  for (const panel of panels.values())
    if (panel.owner.chat === owner.chat && panel.sessionId !== sessionId) disposePanel(panel);
  if (!sessionId || disabled()) return nothing;
  if (!loaded.has(sessionId)) {
    load(sessionId, owner);
    return nothing;
  }
  const canvas = loaded.get(sessionId);
  if (!canvas) return nothing;
  let panel = panels.get(sessionId);
  if (!panel) {
    panel = createPanel(sessionId, owner);
    applyCanvas(panel, canvas);
  }
  panel.owner = owner;
  return panel.el;
}

export function resyncUiCanvas(open: Array<string | null>): void {
  const keep = new Set([...panels.keys(), ...open.filter((id): id is string => Boolean(id))]);
  for (const sessionId of loaded.keys()) if (!keep.has(sessionId)) loaded.delete(sessionId);
  for (const sessionId of keep) load(sessionId);
}

export function releaseUiCanvas(conv: Conversation): void {
  for (const panel of panels.values()) if (panel.owner.chat === conv) disposePanel(panel);
}

function createPanel(sessionId: string, owner: Owner): Panel {
  const el = document.createElement("div");
  el.className = "ui-canvas";
  const head = document.createElement("div");
  head.className = "ui-canvas-head";
  const body = document.createElement("div");
  body.className = "ui-canvas-body";
  el.append(head, body);
  const panel: Panel = {
    sessionId,
    el,
    head,
    shadow: body.attachShadow({ mode: "open" }),
    canvas: null,
    expanded: false,
    owner,
    script: null,
    lifetime: new AbortController(),
    cleanups: [],
  };
  panels.set(sessionId, panel);
  return panel;
}

function cleanup(panel: Panel): void {
  panel.lifetime.abort();
  for (const fn of panel.cleanups.splice(0)) {
    try {
      fn();
    } catch (error) {
      swallow("web-ui: ui canvas cleanup", error);
    }
  }
  panel.script?.remove();
  panel.script = null;
  if (panel.canvas) handoff.delete(`${panel.sessionId}#${panel.canvas.rev}`);
}

function disposePanel(panel: Panel): void {
  cleanup(panel);
  panel.el.remove();
  panels.delete(panel.sessionId);
}

function applyCanvas(panel: Panel, canvas: CanvasRecord): void {
  const previous = panel.canvas;
  if (previous?.rev !== canvas.rev) {
    cleanup(panel);
    panel.lifetime = new AbortController();
    const style = document.createElement("style");
    style.textContent = canvas.css;
    const body = document.createElement("div");
    body.innerHTML = canvas.html;
    panel.shadow.replaceChildren(style, body);
    if (canvas.js.trim()) runScript(panel, canvas);
    panel.expanded = previous !== null || canvas.pinned || announced.has(panel.sessionId);
    announced.delete(panel.sessionId);
  }
  panel.canvas = canvas;
  drawHead(panel);
}

function runScript(panel: Panel, canvas: CanvasRecord): void {
  const signal = panel.lifetime.signal;
  window.qmUiCanvasTake ??= take;
  handoff.set(`${panel.sessionId}#${canvas.rev}`, {
    sessionId: panel.sessionId,
    rev: canvas.rev,
    root: panel.shadow,
    signal,
    onDispose: (fn) => {
      if (signal.aborted) fn();
      else panel.cleanups.push(fn);
    },
    send: (text) => sendFromCanvas(panel, text),
  });
  const script = document.createElement("script");
  script.src = withBase(`/api/ui-canvas/${encodeURIComponent(panel.sessionId)}/script.js?rev=${canvas.rev}`);
  script.onerror = () => {
    if (panel.script === script && !signal.aborted) load(panel.sessionId);
  };
  panel.script = script;
  panel.el.append(script);
}

function drawHead(panel: Panel): void {
  const canvas = panel.canvas;
  if (!canvas) return;
  const open = canvas.pinned || panel.expanded;
  panel.el.classList.toggle("collapsed", !open);
  panel.el.classList.toggle("pinned", canvas.pinned);
  render(
    html`<span class="ui-canvas-title" title="Written by the agent. Its code runs in this page with your session."
        >Canvas</span
      >
      <button
        class="icon-btn"
        aria-pressed=${canvas.pinned}
        title=${canvas.pinned ? "Unpin canvas" : "Pin canvas open"}
        @click=${() => void update(panel, { pinned: !canvas.pinned })}
      >
        ${icon(canvas.pinned ? PinOff : Pin, 13)}
      </button>
      ${
        canvas.pinned
          ? nothing
          : html`<button
              class="icon-btn"
              aria-expanded=${open}
              title=${open ? "Collapse canvas" : "Expand canvas"}
              @click=${() => {
                panel.expanded = !open;
                drawHead(panel);
              }}
            >
              ${icon(open ? ChevronUp : ChevronDown, 13)}
            </button>`
      }
      <button class="icon-btn" title="Close canvas" @click=${() => void update(panel, { dismiss: true })}>
        ${icon(X, 13)}
      </button>`,
    panel.head,
  );
}

async function update(panel: Panel, change: { pinned?: boolean; dismiss?: true }): Promise<void> {
  if (change.dismiss) {
    loaded.set(panel.sessionId, null);
    disposePanel(panel);
  } else if (panel.canvas && change.pinned !== undefined) {
    panel.canvas = { ...panel.canvas, pinned: change.pinned };
    loaded.set(panel.sessionId, panel.canvas);
    drawHead(panel);
  }
  await api(`/api/ui-canvas/${encodeURIComponent(panel.sessionId)}`, {
    method: "POST",
    body: JSON.stringify(change),
  }).catch(() => load(panel.sessionId));
}

async function sendFromCanvas(panel: Panel, text: string): Promise<boolean> {
  const { chat, composer } = panel.owner;
  const agent = chat.state.agent;
  if (panel.lifetime.signal.aborted || !agent || chat.state.sessionId !== panel.sessionId || !text.trim()) return false;
  const message = SENT_PREFIX + text.trim();
  if (agent.state.isStreaming) return (await chat.signalLiveRun("steer", message)).ok;
  if (composer.state.draft || composer.state.attachments.length) return false;
  await composer.sendSuggestedPrompt(message, agent);
  return true;
}

export function handleUiSignal(
  event: SessionStateEvent & { ui?: UiSignal },
  conversations: Conversation[],
  sessions: CoreSession[],
): void {
  if (disabled() || !event.ui) return;
  if (event.ui.kind === "canvas") {
    const sessionId = event.sessionId;
    if (sessionId && (loaded.has(sessionId) || conversations.some((c) => c.state.sessionId === sessionId))) {
      announced.add(sessionId);
      load(sessionId);
    }
    return;
  }
  void answerObserve(event.ui, conversations, sessions);
}

async function answerObserve(
  signal: Extract<UiSignal, { kind: "observe" }>,
  conversations: Conversation[],
  sessions: CoreSession[],
): Promise<void> {
  if (document.visibilityState !== "visible") await new Promise((r) => setTimeout(r, HIDDEN_TAB_DELAY_MS));
  const snapshot = await buildSnapshot(signal, conversations, sessions).catch((error: unknown) => ({
    error: errMessage(error),
  }));
  const post = (body: unknown) =>
    api(`/api/ui-canvas/observe/${encodeURIComponent(signal.callId)}`, {
      method: "POST",
      body: JSON.stringify({ snapshot: body }),
    });
  await post(snapshot)
    .catch((error: unknown) => post({ error: `the snapshot could not be delivered: ${errMessage(error)}` }))
    .catch(() => undefined);
}

function stylesheetText(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      out.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
    } catch {
      out.push(`/* unreadable stylesheet: ${sheet.href ?? "inline"} */`);
    }
  }
  return out.join("\n");
}

async function screenshot(target: HTMLElement): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const { toJpeg } = await import("html-to-image");
    for (const quality of [0.7, 0.4]) {
      const dataUrl = await toJpeg(target, { quality, pixelRatio: 1 });
      if (dataUrl.length <= SCREENSHOT_BUDGET_CHARS) return { dataUrl };
    }
    return { error: "screenshot exceeded the size budget; narrow it with a selector" };
  } catch (error) {
    return { error: errMessage(error) };
  }
}

function findTarget(selector: string | undefined): Element | null {
  if (!selector) return document.documentElement;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

export function fitSnapshot(
  snapshot: Record<string, unknown>,
  budget = SNAPSHOT_BUDGET_BYTES,
): Record<string, unknown> {
  const out = { ...snapshot };
  const truncated: string[] = [];
  for (const field of ["html", "css", "sessions", "screenshot"]) {
    const over = byteLength({ ...out, truncated: [...truncated, field] }) - budget;
    if (over <= 0) break;
    const value = out[field];
    if (value === undefined) continue;
    truncated.push(field);
    if (typeof value === "string" && field !== "screenshot") {
      out[field] = value.slice(0, Math.max(0, value.length - over));
      while (byteLength({ ...out, truncated }) > budget && (out[field] as string).length)
        out[field] = (out[field] as string).slice(0, Math.floor((out[field] as string).length * 0.9));
    } else delete out[field];
  }
  return truncated.length ? { ...out, truncated } : out;
}

async function buildSnapshot(
  signal: Extract<UiSignal, { kind: "observe" }>,
  conversations: Conversation[],
  sessions: CoreSession[],
): Promise<Record<string, unknown>> {
  const target = findTarget(signal.selector);
  const shot = signal.screenshot && target instanceof HTMLElement ? await screenshot(target) : undefined;
  return fitSnapshot({
    url: location.href,
    title: document.title,
    at: Date.now(),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    view: appState.currentView,
    panes: conversations.map((conv) => {
      const rect = conv.state.host?.getBoundingClientRect();
      return {
        sessionId: conv.state.sessionId,
        threadRef: conv.state.threadRef,
        scopeId: conv.state.scopeId,
        context: conv.state.contextName,
        attached: Boolean(conv.state.host?.isConnected),
        streaming: Boolean(conv.state.agent?.state.isStreaming),
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      };
    }),
    canvases: [...panels.values()].map((p) => ({
      sessionId: p.sessionId,
      rev: p.canvas?.rev ?? null,
      pinned: p.canvas?.pinned ?? false,
      attached: p.el.isConnected,
      expanded: p.expanded,
    })),
    selector: signal.selector ?? null,
    found: target !== null,
    html: target?.outerHTML ?? null,
    ...(signal.css ? { css: stylesheetText() } : {}),
    ...(shot ? { screenshot: shot } : {}),
    sessions,
  });
}
