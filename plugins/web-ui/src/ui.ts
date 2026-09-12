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

const CLAUDE_MARK =
  "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z";

const CODEX_FRAME =
  "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z";

const CODEX_MARK =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z";

const PI_GLYPH = "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z";

const PI_DOT = "M517.36 400H634.72V634.72H517.36Z";

const MARK_KEYS: Record<string, "claude" | "codex" | "pi"> = {
  anthropic: "claude",
  pi: "pi",
  claude: "claude",
  openai: "codex",
  codex: "codex",
};

export function modelMark(key: string, size = 16): TemplateResult | null {
  const mark = MARK_KEYS[key.toLocaleLowerCase()];
  if (!mark) return null;
  if (mark === "pi")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 800 800"
      role="img"
      aria-label="Pi"
      focusable="false"
    >
      <rect width="800" height="800" rx="170" fill="#5b74e8" />
      <path fill="#fff" fill-rule="evenodd" d=${PI_GLYPH} />
      <path fill="#fff" d=${PI_DOT} />
    </svg>`;
  if (mark === "claude")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Claude"
      focusable="false"
    >
      <path clip-rule="evenodd" fill-rule="evenodd" fill="#d97757" d=${CLAUDE_MARK} />
    </svg>`;
  return html`<svg
    class="model-mark"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    role="img"
    aria-label="Codex"
    focusable="false"
  >
    <defs>
      <linearGradient id="model-mark-codex" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21">
        <stop stop-color="#b1a7ff" />
        <stop offset=".5" stop-color="#7a9dff" />
        <stop offset="1" stop-color="#3941ff" />
      </linearGradient>
    </defs>
    <path fill="var(--background, #fff)" d=${CODEX_FRAME} />
    <path fill="url(#model-mark-codex)" d=${CODEX_MARK} />
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
