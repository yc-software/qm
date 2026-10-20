import type { Readable } from "node:stream";
import { collectBytes } from "../util/bytes.ts";
import { errMessage } from "../util/errors.ts";
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
  if (!store.update || !store.insertIfAbsent) await store.put(id, apply(await store.get(id)));
  else while (!(await store.update(id, apply)) && !(await store.insertIfAbsent(id, apply(null))));
  return asCanvas(written);
}

export async function installSharedCanvas(
  store: UiStateStore,
  principalId: string,
  file: { stream: Readable } | null,
): Promise<UiCanvas | string> {
  if (!file) return "no such file is shared with you";
  const { data } = await collectBytes(file.stream, { maxBytes: UI_STATE_MAX_BYTES });
  let shared: Record<string, unknown>;
  try {
    shared = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    return `not a shared canvas: ${errMessage(error)}`;
  }
  const [html = "", css = "", js = ""] = [shared?.html, shared?.css, shared?.js];
  if (typeof html !== "string" || typeof css !== "string" || typeof js !== "string")
    return "not a shared canvas: html, css and js must be strings";
  try {
    return (await writeUiCanvas(store, principalId, ALWAYS_ON_CANVAS, {
      html,
      css,
      js,
      pinned: shared.pinned !== false,
      replace: true,
    }))!;
  } catch (error) {
    if (error instanceof UiCanvasTooLargeError) return "the shared canvas is too large";
    throw error;
  }
}
