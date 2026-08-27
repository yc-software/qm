import { randomBytes } from "node:crypto";
import type { ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { constantTimeEqual } from "../util/crypto.ts";
import { errMessage } from "../util/errors.ts";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const MAX_MINIAPP_HTML_BYTES = 512_000;
const MINIAPP_TITLE_MAX = 80;
export const MINIAPP_CSP =
  "sandbox allow-scripts allow-forms allow-pointer-lock allow-modals allow-popups; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; frame-ancestors *";

export type MiniappTheme = "light" | "dark";

const LIGHT = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  border: "#e5e5e5",
  secondary: "#f5f5f5",
  muted: "#737373",
  accent: "#4f46e5",
};
const DARK = {
  background: "#0a0a0a",
  foreground: "#fafafa",
  border: "#2a2a2a",
  secondary: "#171717",
  muted: "#a3a3a3",
  accent: "#818cf8",
};

function tokenBlock(t: typeof LIGHT): string {
  return `--background:${t.background};--foreground:${t.foreground};--border:${t.border};--secondary:${t.secondary};--muted-foreground:${t.muted};--brand-accent:${t.accent}`;
}

const SKIN_RULES =
  "html,body{margin:0!important;width:100%!important;height:100%!important;max-height:100%!important;overflow:hidden!important;background:var(--background)!important;color:var(--foreground)!important;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif!important;font-size:13px;line-height:1.35}" +
  "body{display:flex!important;flex-direction:column!important;box-sizing:border-box!important;padding:12px!important;gap:8px!important}" +
  "h1,h2,h3,p{margin:0}h1,h2,h3{font-size:15px;font-weight:600}" +
  "p,label,small{color:var(--muted-foreground)}" +
  "div,section,main,article,aside{overflow:hidden!important;max-width:100%;box-sizing:border-box}" +
  "canvas,svg{display:block;width:100%!important;flex:1 1 auto!important;min-height:0!important;max-height:none!important;background:var(--secondary)!important;border:1px solid var(--border);border-radius:12px}" +
  "select,input,button,textarea{background:var(--secondary);color:var(--foreground);border:1px solid var(--border);border-radius:8px;font:inherit;padding:5px 8px}" +
  "input[type=range]{appearance:none;height:4px;padding:0;background:var(--border);border:0;border-radius:99px;accent-color:var(--brand-accent);width:100%}" +
  "input[type=range]::-webkit-slider-thumb{appearance:none;width:16px;height:16px;border-radius:50%;background:var(--brand-accent);border:2px solid var(--background);box-shadow:0 1px 2px color-mix(in srgb,var(--foreground) 20%,transparent)}" +
  "input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--brand-accent);border:2px solid var(--background)}" +
  "*{scrollbar-width:none}" +
  "*::-webkit-scrollbar{width:0;height:0;display:none}";

const PROBE = `<script id="qm-miniapp-probe">(function(){var err=null;function fail(e){if(!err)err=(e&&e.message)||String(e);tell(false)}function tell(ok){try{parent.postMessage({source:"qm-miniapp",ok:ok,path:location.pathname,error:err||undefined},"*")}catch(x){}document.documentElement.setAttribute("data-qm-miniapp",ok?"ok":"err")}addEventListener("error",function(e){fail(e.error||e.message)},true);addEventListener("unhandledrejection",function(e){fail(e.reason)});function paint(){if(err)return;tell(true)}function afterPaint(){requestAnimationFrame(function(){requestAnimationFrame(paint)})}if(document.readyState==="complete")afterPaint();else addEventListener("load",afterPaint)})();</script>`;

export function parseMiniappTheme(raw: string | null | undefined): MiniappTheme | undefined {
  return raw === "dark" || raw === "light" ? raw : undefined;
}

export function parseMiniappView(raw: string | null | undefined): "source" | undefined {
  return raw === "source" ? "source" : undefined;
}

export function skinMiniappHtml(html: string, theme?: MiniappTheme): string {
  const root = theme
    ? `:root{color-scheme:${theme};${tokenBlock(theme === "dark" ? DARK : LIGHT)}}`
    : `:root{color-scheme:light;${tokenBlock(LIGHT)}}@media (prefers-color-scheme:dark){:root{color-scheme:dark;${tokenBlock(DARK)}}}`;
  const tag = `<style id="qm-miniapp-skin">${root}${SKIN_RULES}</style>`;
  const stripped = html
    .replace(/<style id="qm-miniapp-skin">[\s\S]*?<\/style>/, "")
    .replace(/<script id="qm-miniapp-probe">[\s\S]*?<\/script>/, "");
  const withSkin = /<head[^>]*>/i.test(stripped)
    ? stripped.replace(/<head[^>]*>/i, (m) => `${m}${tag}`)
    : `${tag}${stripped}`;
  if (/<\/body>/i.test(withSkin)) return withSkin.replace(/<\/body>/i, `${PROBE}</body>`);
  return `${withSkin}${PROBE}`;
}

export function assertMiniappOk(html: string): void {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const visible = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasStage = /<(canvas|svg|input|button|select)\b/i.test(body);
  if (!visible && !hasStage) throw new Error("miniapp has nothing to show — add a canvas, a control, or some text");
  if (/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/i.test(html)) {
    throw new Error("miniapp cannot use the network — inline everything");
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) throw new Error("miniapp scripts must be inline — no src=");
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) throw new Error("miniapp cannot use type=module");
    const code = (m[2] ?? "").trim();
    if (!code) continue;
    try {
      new Function(code);
    } catch (e) {
      throw new Error(`miniapp script does not parse: ${errMessage(e)}`, { cause: e });
    }
  }
}

export interface MiniappRecord {
  id: string;
  key: string;
  title: string;
  html: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdAt: number;
}

export interface MiniappInput {
  title: string;
  html?: string;
  file?: string;
}

export interface MiniappResult {
  id: string;
  title: string;
  url: string;
  directive: string;
}

export type MiniappStore = DurableMap<MiniappRecord>;

export function clipMiniappTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return "Playground";
  return title.length > MINIAPP_TITLE_MAX ? `${title.slice(0, MINIAPP_TITLE_MAX - 1)}…` : title;
}

export function documentHtml(title: string, html: string): string {
  const trimmed = html.trim();
  if (/^<!doctype html|<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${trimmed}</body></html>`;
}

function miniappPath(rec: Pick<MiniappRecord, "id" | "key">): string {
  return `/m/${rec.id}/${rec.key}`;
}

function miniappUrl(base: string | undefined, rec: Pick<MiniappRecord, "id" | "key">): string {
  const path = miniappPath(rec);
  const root = base?.replace(/\/$/, "");
  return root ? `${root}${path}` : path;
}

function miniappDirective(url: string, title: string): string {
  return `[[miniapp: ${url} | ${title}]]`;
}

export async function putMiniapp(
  store: MiniappStore,
  input: {
    title: string;
    html: string;
    ownerScopeId: ScopeId;
    createdBy: string;
    publicBase?: string;
    now?: number;
  },
): Promise<MiniappResult> {
  const title = clipMiniappTitle(input.title);
  const html = documentHtml(title, input.html);
  assertMiniappOk(html);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_MINIAPP_HTML_BYTES) {
    throw new Error(`miniapp HTML is ${bytes} bytes; keep it under ${MAX_MINIAPP_HTML_BYTES}`);
  }
  const rec: MiniappRecord = {
    id: randomBytes(12).toString("hex"),
    key: randomBytes(18).toString("base64url"),
    title,
    html,
    ownerScopeId: input.ownerScopeId,
    createdBy: input.createdBy,
    createdAt: input.now ?? Date.now(),
  };
  await store.put(rec.id, rec);
  const url = miniappUrl(input.publicBase, rec);
  return { id: rec.id, title, url, directive: miniappDirective(url, title) };
}

export async function openMiniapp(store: MiniappStore, id: string, key: string): Promise<MiniappRecord | null> {
  if (!id || !key) return null;
  const rec = await store.get(id);
  if (!rec || !constantTimeEqual(rec.key, key)) return null;
  return rec;
}
