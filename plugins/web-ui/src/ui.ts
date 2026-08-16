import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Check, ChevronDown, createElement, type IconNode } from "lucide";

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

export function fieldSelect(props: {
  options: TemplateResult | TemplateResult[];
  onChange: (value: string, event: Event) => void;
  value?: string;
  id?: string;
  ariaLabel?: string;
  describedBy?: string;
  focusKey?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}): TemplateResult {
  return html`<span
    class=${`field-select${props.compact ? " compact" : ""}${props.className ? ` ${props.className}` : ""}`}
  >
    <select
      id=${props.id ?? nothing}
      aria-label=${props.ariaLabel ?? nothing}
      aria-describedby=${props.describedBy ?? nothing}
      data-focus-key=${props.focusKey ?? nothing}
      .value=${props.value === undefined ? nothing : live(props.value)}
      ?disabled=${props.disabled ?? false}
      @change=${(e: Event) => props.onChange((e.currentTarget as HTMLSelectElement).value, e)}
    >
      ${props.options}
    </select>
    ${icon(ChevronDown, 16)}
  </span>`;
}

export function initials(s: string): string {
  const base = (s.split("@")[0] || s).trim();
  const parts = base.split(/[.\-_ ]+/).filter(Boolean);
  const two = parts.length >= 2 ? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "") : base.slice(0, 2);
  return (two || "?").toUpperCase();
}

export function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      btn.textContent = "Copied";
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
  return s.length > 48 ? `${s.slice(0, 47)}…` : s || "(no action)";
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

export function setFormMenuValue(control: HTMLElement | null, value: string, labelText: string): void {
  if (!control) return;
  const input = control.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (input) input.value = value;
  const label = control.querySelector<HTMLElement>(".menu-label");
  if (label) label.textContent = labelText;
  control.querySelectorAll<HTMLButtonElement>(".menu-option").forEach((option) => {
    const active = option.dataset.value === value;
    option.classList.toggle("active", active);
    option.setAttribute("aria-checked", active ? "true" : "false");
    option.querySelector("svg")?.remove();
  });
  const activeOption = Array.from(control.querySelectorAll<HTMLButtonElement>(".menu-option")).find((option) =>
    option.classList.contains("active"),
  );
  if (activeOption) activeOption.append(icon(Check, 15));
}
