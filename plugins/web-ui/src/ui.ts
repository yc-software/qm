import { html, type TemplateResult } from "lit";
import { createElement, type IconNode } from "lucide";
import { locale, t } from "./i18n.ts";

export function brandName(): string {
  if (typeof document === "undefined") return "QM";
  return document.querySelector<HTMLMetaElement>('meta[name="brand-self-label"]')?.content || "QM";
}

export function brandMark(): TemplateResult {
  return html`<span class="brand-mark" aria-hidden="true"></span>`;
}

export function icon(node: IconNode, size = 18): SVGElement {
  const el = createElement(node, {
    class: "icon",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.9,
  });
  return el;
}

export function initials(s: string): string {
  const base = (s.split("@")[0] || s).trim();
  const parts = base.split(/[.\-_ ]+/).filter(Boolean);
  const two = parts.length >= 2 ? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "") : base.slice(0, 2);
  return (two || "?").toUpperCase();
}

export function relTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return t("time.justNow");
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return t("time.justNow");
  const selected = locale();
  const formatter = new Intl.RelativeTimeFormat(selected, {
    numeric: "always",
    style: selected === "ja" ? "narrow" : "long",
  });
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), "hour");
  return formatter.format(-Math.floor(seconds / 86400), "day");
}

export function formatBytes(bytes: number): string {
  const selected = locale();
  if (bytes < 1024) return `${new Intl.NumberFormat(selected).format(bytes)} B`;
  if (bytes < 1024 * 1024)
    return `${new Intl.NumberFormat(selected, { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`;
  return `${new Intl.NumberFormat(selected, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/apng",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-ms-bmp",
]);

export function browserRenderableImage(mimeType?: string): boolean {
  return RENDERABLE_IMAGE_TYPES.has((mimeType ?? "").split(";")[0]!.trim().toLowerCase());
}

const copyFeedback = new WeakMap<HTMLButtonElement, { html: string; timer: ReturnType<typeof setTimeout> }>();

export async function copyText(text: string, btn?: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const active = copyFeedback.get(btn);
      if (active) clearTimeout(active.timer);
      const html = active?.html ?? btn.innerHTML;
      btn.textContent = t("chat.copied");
      const timer = setTimeout(() => {
        btn.innerHTML = html;
        copyFeedback.delete(btn);
      }, 1200);
      copyFeedback.set(btn, { html, timer });
    }
  } catch {
    void 0;
  }
}

export function actionSnippet(action: string): string {
  const s = action.trim().replace(/\s+/g, " ");
  return s.length > 48 ? `${s.slice(0, 47)}…` : s || t("approval.noAction");
}

export function closeFormMenus(): boolean {
  let closed = false;
  document.querySelectorAll<HTMLElement>(".form-menu-control.open").forEach((control) => {
    control.classList.remove("open");
    control.querySelector<HTMLButtonElement>(".menu-button")?.setAttribute("aria-expanded", "false");
    const menu = control.querySelector<HTMLElement>(".menu-popover");
    if (menu) menu.hidden = true;
    closed = true;
  });
  return closed;
}

export function toggleFormMenu(e: Event): void {
  e.stopPropagation();
  const control = (e.currentTarget as HTMLElement).closest(".form-menu-control") as HTMLElement | null;
  if (!control) return;
  const wasOpen = control.classList.contains("open");
  closeFormMenus();
  control.classList.toggle("open", !wasOpen);
  const open = !wasOpen;
  control.querySelector<HTMLButtonElement>(".menu-button")?.setAttribute("aria-expanded", open ? "true" : "false");
  const menu = control.querySelector<HTMLElement>(".menu-popover");
  if (menu) menu.hidden = !open;
}
