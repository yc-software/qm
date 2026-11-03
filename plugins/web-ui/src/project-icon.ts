import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { Shuffle } from "lucide";
import emojiSource from "emoji-datasource/emoji.json" with { type: "json" };
import { api } from "./core-bridge";
import { icon } from "./icons";

/**
 * Project icons: one Unicode emoji ("🚢") or a workspace custom emoji shortcode (":shipit:").
 * Custom emoji resolve through the catalog the Slack surface publishes (`/api/custom-emoji`).
 */

interface PickerEmoji {
  /** Stored value: the character itself, or `:name:` for a custom emoji. */
  value: string;
  name: string;
  keywords: string[];
  url?: string;
}

interface PickerSection {
  label: string;
  items: PickerEmoji[];
}

const RECENT_KEY = "qm.projectIcon.recent";
const RECENT_MAX = 16;
const CUSTOM_ICON = /^:([a-z0-9_+'-]{1,100}):$/;

let customEmoji: Record<string, string> | null = null;
let customLoad: Promise<void> | null = null;
const customListeners = new Set<() => void>();

export function onCustomEmojiLoaded(listener: () => void): void {
  customListeners.add(listener);
}

export function loadCustomEmoji(): Promise<void> {
  customLoad ??= api<{ emoji?: Record<string, string> }>("/api/custom-emoji")
    .then((body) => {
      customEmoji = body.emoji ?? {};
    })
    .catch(() => {
      customEmoji = {};
      customLoad = null;
    })
    .finally(() => {
      for (const listener of customListeners) listener();
    });
  return customLoad;
}

function customUrl(value: string): string | null {
  const name = CUSTOM_ICON.exec(value)?.[1];
  if (!name) return null;
  if (!customEmoji) void loadCustomEmoji();
  return customEmoji?.[name] ?? null;
}

/** The icon glyph for a project, or `null` when it has none (callers fall back to the folder). */
export function projectIconTpl(value: string | undefined, size = 16): TemplateResult | null {
  if (!value) return null;
  if (CUSTOM_ICON.test(value)) {
    const url = customUrl(value);
    return html`<span class="project-icon" style=${`--project-icon-size:${size}px`} aria-hidden="true"
      >${url ? html`<img src=${url} alt="" draggable="false" />` : nothing}</span
    >`;
  }
  return html`<span class="project-icon" style=${`--project-icon-size:${size}px`} aria-hidden="true">${value}</span>`;
}

let standardSections: PickerSection[] | null = null;

const CATEGORY_LABELS: Record<string, string> = {
  "Smileys & Emotion": "Smileys",
  "People & Body": "People",
  "Animals & Nature": "Animals & nature",
  "Food & Drink": "Food & drink",
  "Travel & Places": "Travel & places",
  Activities: "Activities",
  Objects: "Objects",
  Symbols: "Symbols",
  Flags: "Flags",
};

function standard(): PickerSection[] {
  if (standardSections) return standardSections;
  const byCategory = new Map<string, PickerEmoji[]>();
  for (const row of [...emojiSource].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const label = CATEGORY_LABELS[row.category];
    if (!label || !row.unified) continue;
    const value = String.fromCodePoint(...row.unified.split("-").map((hex) => parseInt(hex, 16)));
    const list = byCategory.get(label) ?? [];
    list.push({ value, name: row.short_name, keywords: row.short_names });
    byCategory.set(label, list);
  }
  standardSections = Object.values(CATEGORY_LABELS)
    .map((label) => ({ label, items: byCategory.get(label) ?? [] }))
    .filter((section) => section.items.length);
  return standardSections;
}

function customItems(): PickerEmoji[] {
  return Object.entries(customEmoji ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, url]) => ({ value: `:${name}:`, name, keywords: [name], url }));
}

function lookup(value: string): PickerEmoji | null {
  const custom = CUSTOM_ICON.exec(value)?.[1];
  if (custom) {
    const url = customEmoji?.[custom];
    return url ? { value, name: custom, keywords: [custom], url } : null;
  }
  for (const section of standard()) {
    const hit = section.items.find((item) => item.value === value);
    if (hit) return hit;
  }
  return null;
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(value: string): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([value, ...readRecent().filter((v) => v !== value)].slice(0, RECENT_MAX)),
    );
  } catch {
    // Recents are a convenience; private mode or a full quota just skips them.
  }
}

function normalizeQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replaceAll("-", "_");
}

/** 0 = exact name, 1 = prefix, 2 = word prefix, 3 = substring, -1 = no match. */
function rank(item: PickerEmoji, needle: string): number {
  let best = -1;
  for (const keyword of item.keywords) {
    const k = keyword.toLowerCase().replaceAll("-", "_");
    let score = -1;
    if (k === needle) score = 0;
    else if (k.startsWith(needle)) score = 1;
    else if (k.includes(`_${needle}`)) score = 2;
    else if (k.includes(needle)) score = 3;
    if (score >= 0 && (best < 0 || score < best)) best = score;
  }
  return best;
}

function sections(query: string): PickerSection[] {
  const needle = normalizeQuery(query);
  const custom = customItems();
  if (needle) {
    const hits = [...custom, ...standard().flatMap((section) => section.items)]
      .map((item, order) => ({ item, order, score: rank(item, needle) }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map((hit) => hit.item);
    return hits.length ? [{ label: "Results", items: hits }] : [];
  }
  const recent = readRecent()
    .map(lookup)
    .filter((item): item is PickerEmoji => item !== null);
  return [
    ...(recent.length ? [{ label: "Recent", items: recent }] : []),
    ...(custom.length ? [{ label: "Custom", items: custom }] : []),
    ...standard(),
  ];
}

interface PickerOptions {
  anchor: HTMLElement;
  current: string | undefined;
  onPick: (value: string | null) => void | Promise<void>;
  align?: "start" | "end";
}

interface PickerState extends PickerOptions {
  query: string;
  active: number;
  flat: PickerEmoji[];
}

let host: HTMLDivElement | null = null;
let state: PickerState | null = null;

export function projectIconPickerOpen(): boolean {
  return state !== null;
}

export function openProjectIconPicker(options: PickerOptions): void {
  closeProjectIconPicker();
  state = { ...options, query: "", active: 0, flat: [] };
  host = document.createElement("div");
  host.className = "project-icon-picker-host";
  document.body.append(host);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("resize", closeProjectIconPicker);
  onCustomEmojiLoaded(draw);
  void loadCustomEmoji();
  draw();
  requestAnimationFrame(() => {
    place();
    host?.querySelector<HTMLInputElement>(".project-icon-search input")?.focus();
  });
}

export function closeProjectIconPicker(): void {
  if (!host) return;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("resize", closeProjectIconPicker);
  customListeners.delete(draw);
  const anchor = state?.anchor;
  render(nothing, host);
  host.remove();
  host = null;
  state = null;
  if (anchor?.isConnected) anchor.focus({ preventScroll: true });
}

function onOutside(event: PointerEvent): void {
  if (!host || !state) return;
  const target = event.target as Node;
  if (host.contains(target) || state.anchor.contains(target)) return;
  closeProjectIconPicker();
}

function place(): void {
  const panel = host?.querySelector<HTMLElement>(".project-icon-picker");
  if (!panel || !state) return;
  const rect = state.anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const margin = 8;
  let left = state.align === "end" ? rect.right - width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

async function choose(value: string | null): Promise<void> {
  if (!state) return;
  const { onPick } = state;
  if (value) rememberRecent(value);
  closeProjectIconPicker();
  await onPick(value);
}

function random(): void {
  const pool = [...customItems(), ...standard().flatMap((section) => section.items)];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) void choose(pick.value);
}

function setActive(index: number, reveal: boolean): void {
  if (!state || !host) return;
  state.active = index;
  host.querySelector(".project-icon-cell.active")?.classList.remove("active");
  const next = host.querySelector<HTMLElement>(`.project-icon-cell[data-index="${index}"]`);
  next?.classList.add("active");
  if (reveal) next?.scrollIntoView({ block: "nearest" });
}

function moveActive(delta: number): void {
  if (!state || !state.flat.length) return;
  setActive(Math.max(0, Math.min(state.flat.length - 1, state.active + delta)), true);
}

const COLUMNS = 12;

function onKey(event: KeyboardEvent): void {
  if (!state) return;
  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeProjectIconPicker();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = state.flat[state.active];
    if (item) void choose(item.value);
  } else if (event.key in moves && (event.key === "ArrowDown" || event.key === "ArrowUp" || state.query)) {
    event.preventDefault();
    moveActive(moves[event.key]!);
  }
}

function cell(item: PickerEmoji, index: number, current: string | undefined): TemplateResult {
  const active = state?.active === index;
  return html`<button
    class="project-icon-cell ${active ? "active" : ""} ${item.value === current ? "current" : ""}"
    type="button"
    role="option"
    aria-label=${item.name.replaceAll("_", " ")}
    title=${`:${item.name}:`}
    data-index=${index}
    @pointerenter=${() => setActive(index, false)}
    @click=${() => void choose(item.value)}
  >
    ${item.url ? html`<img src=${item.url} alt="" loading="lazy" draggable="false" />` : item.value}
  </button>`;
}

function draw(): void {
  if (!host || !state) return;
  const list = sections(state.query);
  state.flat = list.flatMap((section) => section.items);
  state.active = Math.min(state.active, Math.max(0, state.flat.length - 1));
  let index = 0;
  const current = state.current;
  render(
    html`<div
      class="project-icon-picker"
      role="dialog"
      aria-label="Choose a project icon"
      @keydown=${onKey}
      ${ref((el) => el && requestAnimationFrame(place))}
    >
      <div class="project-icon-picker-top">
        <span class="project-icon-picker-tab">Emoji</span>
        ${
          current
            ? html`<button class="project-icon-picker-remove" type="button" @click=${() => void choose(null)}>
                Remove
              </button>`
            : nothing
        }
      </div>
      <div class="project-icon-search">
        <input
          type="text"
          placeholder="Filter…"
          aria-label="Search emoji"
          autocomplete="off"
          spellcheck="false"
          .value=${state.query}
          @input=${(event: InputEvent) => {
            if (!state) return;
            state.query = (event.target as HTMLInputElement).value;
            state.active = 0;
            draw();
            host?.querySelector(".project-icon-grid-scroll")?.scrollTo({ top: 0 });
          }}
        />
        <button class="project-icon-random" type="button" title="Random" aria-label="Random emoji" @click=${random}>
          ${icon(Shuffle, 15)}
        </button>
      </div>
      <div class="project-icon-grid-scroll" role="listbox" aria-label="Emoji">
        ${
          list.length
            ? list.map(
                (section) =>
                  html`<div class="project-icon-section">${section.label}</div>
                    <div class="project-icon-grid">${section.items.map((item) => cell(item, index++, current))}</div>`,
              )
            : html`<div class="project-icon-empty">No emoji found</div>`
        }
      </div>
    </div>`,
    host,
  );
}
