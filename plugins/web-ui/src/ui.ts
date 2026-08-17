import { html, nothing, type TemplateResult } from "lit";
import { Check, ChevronDown, createElement, type IconNode } from "lucide";

export function brandName(): string {
  if (typeof document === "undefined") return "QM";
  return document.querySelector<HTMLMetaElement>('meta[name="brand-self-label"]')?.content || "QM";
}

export function brandMark(): TemplateResult {
  return html`<span class="brand-mark" aria-hidden="true"></span>`;
}

const SWELL_PATH =
  "M-24 24 c4 -8 8 -8 12 0 c4 8 8 8 12 0 c4 -8 8 -8 12 0 c4 8 8 8 12 0 c4 -8 8 -8 12 0 c4 8 8 8 12 0 c4 -8 8 -8 12 0 c4 8 8 8 12 0";

const SWELL_VIEWBOX = "0 0 38.4 48";

export function waveLoader(
  o: { width?: number; height?: number; viewBox?: string; label?: string; cls?: string } = {},
): TemplateResult {
  const width = o.width ?? 24.5;
  return html`<svg
    class="wl wl-swell ${o.cls ?? ""}"
    width=${width}
    height=${o.height ?? width * 1.25}
    viewBox=${o.viewBox ?? SWELL_VIEWBOX}
    fill="none"
    role="img"
    aria-label=${o.label ?? "Loading"}
    xmlns="http://www.w3.org/2000/svg"
  >
    <g class="wl-row">
      <path d=${SWELL_PATH} fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.6" />
    </g>
  </svg>`;
}

export function workingWave(): TemplateResult {
  return waveLoader({
    width: 13.6,
    height: 5.7,
    viewBox: "0 16 38.4 16",
    label: "Agent is working",
    cls: "working-wave",
  });
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
      .value=${props.value ?? nothing}
      ?disabled=${props.disabled ?? false}
      @change=${(e: Event) => props.onChange((e.currentTarget as HTMLSelectElement).value, e)}
    >
      ${props.options}
    </select>
    ${icon(ChevronDown, 16)}
  </span>`;
}

export function selectMenu(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}): TemplateResult {
  const current = props.options.find((o) => o.value === props.value);
  return html`<div
    class=${`menu-control form-menu-control select-menu${props.className ? ` ${props.className}` : ""}`}
    data-drop="down"
  >
    <button
      class="menu-button"
      type="button"
      aria-haspopup="menu"
      aria-expanded="false"
      aria-label=${props.ariaLabel ?? nothing}
      ?disabled=${props.disabled ?? false}
      @click=${toggleFormMenu}
    >
      <span class="menu-label">${current?.label ?? ""}</span>${icon(ChevronDown, 14)}
    </button>
    <div class="menu-popover" role="menu" hidden>
      ${props.options.map((o) => {
        const active = o.value === props.value;
        return html`<button
          class="menu-option ${active ? "active" : ""}"
          type="button"
          role="menuitemradio"
          aria-checked=${active ? "true" : "false"}
          @click=${(e: Event) => {
            e.stopPropagation();
            closeFormMenus();
            props.onChange(o.value);
          }}
        >
          <span class="menu-option-label">${o.label}</span>${active ? icon(Check, 15) : nothing}
        </button>`;
      })}
    </div>
  </div>`;
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
    if (menu) {
      menu.hidden = true;
      menu.style.transform = "";
      menu.classList.remove("drop-up");
    }
    closed = true;
  });
  return closed;
}

function placeMenuPopover(menu: HTMLElement): void {
  const margin = 8;
  menu.style.transform = "";
  menu.classList.remove("drop-up");
  const rect = menu.getBoundingClientRect();
  const overflowRight = rect.right - (window.innerWidth - margin);
  const overflowLeft = margin - rect.left;
  if (overflowRight > 0)
    menu.style.transform = `translateX(${-Math.min(overflowRight, Math.max(0, rect.left - margin))}px)`;
  else if (overflowLeft > 0)
    menu.style.transform = `translateX(${Math.min(overflowLeft, window.innerWidth - margin - rect.right)}px)`;
  const anchorTop = menu.parentElement?.getBoundingClientRect().top ?? rect.top;
  if (rect.bottom > window.innerHeight - margin && anchorTop - rect.height - margin >= margin)
    menu.classList.add("drop-up");
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
  if (!menu) return;
  menu.hidden = !open;
  if (open) placeMenuPopover(menu);
}
