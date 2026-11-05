import { uiStateId, UI_STATE_MAX_BYTES, type PersistedUiState, type UiStateStore } from "./ui-state.ts";

export interface UiCanvas {
  html: string;
  css: string;
  js: string;
  pinned: boolean;
  rev: number;
}

export interface UiCanvasPatch {
  html?: string;
  css?: string;
  js?: string;
  pinned?: boolean;
  replace?: boolean;
}

export const ALWAYS_ON_CANVAS = "always-on";

export class UiCanvasTooLargeError extends Error {}

function uiCanvasKey(target: string): string {
  return `canvas:${target}`;
}

export function uiObserveKey(callId: string): string {
  return `observe:${callId}`;
}

function storedRev(value: unknown): number {
  const rev = (value as { rev?: unknown } | null)?.rev;
  return typeof rev === "number" ? rev : 0;
}

function asCanvas(value: unknown): UiCanvas | null {
  if (!value || typeof value !== "object" || (value as { dismissed?: unknown }).dismissed === true) return null;
  const v = value as Partial<UiCanvas>;
  return {
    html: typeof v.html === "string" ? v.html : "",
    css: typeof v.css === "string" ? v.css : "",
    js: typeof v.js === "string" ? v.js : "",
    pinned: v.pinned === true,
    rev: typeof v.rev === "number" ? v.rev : 0,
  };
}

function nextCanvas(stored: unknown, patch: UiCanvasPatch | null): UiCanvas | { dismissed: true; rev: number } {
  const current = asCanvas(stored);
  if (!patch) return { dismissed: true, rev: storedRev(stored) };
  if (!current && patch.html === undefined && patch.css === undefined && patch.js === undefined)
    return { dismissed: true, rev: storedRev(stored) };
  const base =
    patch.replace || !current ? { html: "", css: "", js: "", pinned: false, rev: storedRev(stored) } : current;
  const html = patch.html ?? base.html;
  const css = patch.css ?? base.css;
  const js = patch.js ?? base.js;
  const changed = !current || html !== current.html || css !== current.css || js !== current.js;
  const next = { html, css, js, pinned: patch.pinned ?? base.pinned, rev: changed ? base.rev + 1 : base.rev };
  if (Buffer.byteLength(JSON.stringify(next)) > UI_STATE_MAX_BYTES) throw new UiCanvasTooLargeError();
  return next;
}

export async function readUiCanvas(store: UiStateStore, principalId: string, target: string): Promise<UiCanvas | null> {
  return asCanvas((await store.get(uiStateId(principalId, uiCanvasKey(target))))?.value);
}

export async function writeUiCanvas(
  store: UiStateStore,
  principalId: string,
  target: string,
  patch: UiCanvasPatch | null,
): Promise<UiCanvas | null> {
  const id = uiStateId(principalId, uiCanvasKey(target));
  let written: unknown = null;
  const apply = (rec: PersistedUiState | null): PersistedUiState => {
    written = nextCanvas(rec?.value ?? null, patch);
    return { value: written, updatedAt: Date.now() };
  };
  while (!(await store.update(id, apply)) && !(await store.insertIfAbsent(id, apply(null))));
  return asCanvas(written);
}
