import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Check, ChevronDown, Download, createElement, type IconNode } from "lucide";

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

export function slackMark(size = 14): TemplateResult {
  return html`<svg
    class="slack-mark"
    width=${size}
    height=${size}
    viewBox="0 0 127 127"
    role="img"
    aria-label="Slack"
    focusable="false"
  >
    <path
      d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
      fill="#E01E5A"
    />
    <path
      d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
      fill="#36C5F0"
    />
    <path
      d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
      fill="#2EB67D"
    />
    <path
      d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
      fill="#ECB22E"
    />
  </svg>`;
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

export interface MenuSelectOption {
  value: string | null;
  label: string;
  glyph?: IconNode;
}

export function menuSelect(props: {
  value: string | null;
  options: MenuSelectOption[];
  onSelect: (value: string | null) => void;
  ariaLabel: string;
  prefix?: string;
  className?: string;
}): TemplateResult {
  const current = props.value ?? null;
  const selected = props.options.find((o) => (o.value ?? null) === current) ?? props.options[0];
  const option = (o: MenuSelectOption): TemplateResult => {
    const active = (o.value ?? null) === current;
    return html`
      <button
        class="menu-option ${active ? "active" : ""}"
        type="button"
        role="menuitemradio"
        aria-checked=${active ? "true" : "false"}
        @click=${(e: Event) => {
          e.stopPropagation();
          closeFormMenus();
          props.onSelect(o.value ?? null);
        }}
      >
        <span class="menu-option-label menu-select-option"
          >${o.glyph ? icon(o.glyph, 14) : nothing}<span>${o.label}</span></span
        >
        ${active ? icon(Check, 15) : nothing}
      </button>
    `;
  };
  return html`
    <div
      class=${`menu-control form-menu-control field-menu${props.className ? ` ${props.className}` : ""}`}
      data-drop="down"
    >
      <button
        class="menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label=${props.ariaLabel}
        @click=${toggleFormMenu}
      >
        <span class="menu-label">${props.prefix ?? ""}${selected?.label ?? ""}</span>${icon(ChevronDown, 14)}
      </button>
      <div class="menu-popover" role="menu" hidden>${props.options.map(option)}</div>
    </div>
  `;
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

export function chipBadge(
  glyph: IconNode,
  name: string,
  size?: number,
  href?: string,
  download = false,
): TemplateResult {
  const inner = html`${icon(glyph, 14)}<span dir="auto">${name}</span
    >${typeof size === "number" ? html`<small>${formatBytes(size)}</small>` : nothing}`;
  if (!href) return html`<span class="file-chip">${inner}</span>`;
  if (download) return html`<a class="file-chip" href=${href} download=${name}>${inner}</a>`;
  return html`<span class="file-chip-group"
    ><a class="file-chip" href=${href} target="_blank" rel="noreferrer">${inner}</a
    ><a class="file-chip-download" href=${href} download=${name} title="Download ${name}" aria-label="Download ${name}"
      >${icon(Download, 14)}</a
    ></span
  >`;
}
