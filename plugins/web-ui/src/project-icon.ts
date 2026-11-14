import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { Shuffle } from "lucide";
import { api, type ProjectIcon } from "./core-bridge";
import { EMOJI_ROWS, filterEmoji, type EmojiRow } from "./emoji-picker";
import { icon } from "./icons";
import { errMessage, swallow } from "../../chassis/src/errors";

interface PickerItem {
  icon: ProjectIcon;
  name: string;
  url?: string;
}

interface PickerSection {
  label: string;
  items: PickerItem[];
}

const RECENT_KEY = "qm.projectIcon.recent";
const RECENT_MAX = 16;

let customEmoji: Record<string, string> | null = null;
let customLoad: Promise<void> | null = null;
const customListeners = new Set<() => void>();

export function onCustomEmojiLoaded(listener: () => void): void {
  customListeners.add(listener);
}

function loadCustomEmoji(): Promise<void> {
  customLoad ??= api<{ emoji?: Record<string, string> }>("/api/custom-emoji")
    .then((body) => {
      customEmoji = body.emoji ?? {};
    })
    .catch((e: unknown) => {
      console.error("custom emoji catalog failed to load", errMessage(e));
      customEmoji = {};
      customLoad = null;
    })
    .finally(() => {
      for (const listener of customListeners) listener();
    });
  return customLoad;
}

function customUrl(name: string): string | null {
  if (!customEmoji) void loadCustomEmoji();
  return customEmoji?.[name] ?? null;
}

export function projectIconTpl(value: ProjectIcon | undefined, size = 16): TemplateResult | null {
  if (!value) return null;
  const style = `--project-icon-size:${size}px`;
  if (value.kind !== "emoji") {
    const url = value.kind === "image" ? value.url : customUrl(value.name);
    return html`<span class="project-icon" style=${style} aria-hidden="true"
      >${url ? html`<img src=${url} alt="" draggable="false" />` : nothing}</span
    >`;
  }
  return html`<span class="project-icon" style=${style} aria-hidden="true">${value.value}</span>`;
}

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

function standardItem(row: EmojiRow): PickerItem {
  return { icon: { kind: "emoji", value: row.c }, name: row.n };
}

let standardSections: PickerSection[] | null = null;

function standard(): PickerSection[] {
  standardSections ??= Object.entries(CATEGORY_LABELS)
    .map(([category, label]) => ({
      label,
      items: EMOJI_ROWS.filter((row) => row.g === category).map(standardItem),
    }))
    .filter((section) => section.items.length);
  return standardSections;
}

function customRows(): EmojiRow[] {
  return Object.keys(customEmoji ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ n: name, c: "", a: [], g: "Custom" }));
}

function customItem(name: string): PickerItem | null {
  const url = customEmoji?.[name];
  return url ? { icon: { kind: "custom", name }, name, url } : null;
}

function customItems(rows: readonly EmojiRow[]): PickerItem[] {
  return rows.flatMap((row) => customItem(row.n) ?? []);
}

function itemFor(value: ProjectIcon): PickerItem | null {
  if (value.kind === "image") return { icon: value, name: "image", url: value.url };
  if (value.kind === "custom") return customItem(value.name);
  const row = EMOJI_ROWS.find((candidate) => candidate.c === value.value);
  return row ? standardItem(row) : null;
}

function sameIcon(a: ProjectIcon | null | undefined, b: ProjectIcon | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function readRecent(): ProjectIcon[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is ProjectIcon => typeof v === "object" && v !== null && "kind" in v)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(value: ProjectIcon): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([value, ...readRecent().filter((v) => !sameIcon(v, value))].slice(0, RECENT_MAX)),
    );
  } catch (error) {
    swallow("web-ui: remember recent icon", error);
  }
}

function sections(query: string): PickerSection[] {
  if (query.trim()) {
    const hits = [
      ...customItems(filterEmoji(customRows(), query)),
      ...filterEmoji(EMOJI_ROWS, query).map(standardItem),
    ];
    return hits.length ? [{ label: "Results", items: hits }] : [];
  }
  const recent = readRecent().flatMap((value) => itemFor(value) ?? []);
  const custom = customItems(customRows());
  return [
    ...(recent.length ? [{ label: "Recent", items: recent }] : []),
    ...(custom.length ? [{ label: "Custom", items: custom }] : []),
    ...standard(),
  ];
}

interface PickerOptions {
  anchor: HTMLElement;
  current: ProjectIcon | undefined;
  onPick: (value: ProjectIcon | null) => Promise<string | null>;
}

interface PickerState extends PickerOptions {
  query: string;
  active: number;
  flat: PickerItem[];
  error: string;
  saving: boolean;
}

let host: HTMLDivElement | null = null;
let state: PickerState | null = null;

export function openProjectIconPicker(options: PickerOptions): void {
  closeProjectIconPicker();
  state = { ...options, query: "", active: 0, flat: [], error: "", saving: false };
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

function closeProjectIconPicker(): void {
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
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

async function choose(value: ProjectIcon | null): Promise<void> {
  if (!state || state.saving) return;
  const picking = state;
  picking.saving = true;
  picking.error = "";
  draw();
  const error = await picking.onPick(value);
  if (state !== picking) return;
  if (error) {
    picking.saving = false;
    picking.error = error;
    draw();
    return;
  }
  if (value) rememberRecent(value);
  closeProjectIconPicker();
}

function random(): void {
  const pool = [...customItems(customRows()), ...standard().flatMap((section) => section.items)];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) void choose(pick.icon);
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
    if (item) void choose(item.icon);
  } else if (event.key in moves && (event.key === "ArrowDown" || event.key === "ArrowUp" || state.query)) {
    event.preventDefault();
    moveActive(moves[event.key]!);
  }
}

function pickImage(event: SubmitEvent): void {
  event.preventDefault();
  const url = new FormData(event.target as HTMLFormElement).get("url");
  if (typeof url === "string" && url.trim()) void choose({ kind: "image", url: url.trim() });
}

function glyph(value: ProjectIcon): string | typeof nothing {
  return value.kind === "emoji" ? value.value : nothing;
}

function cell(item: PickerItem, index: number, current: ProjectIcon | undefined): TemplateResult {
  const active = state?.active === index;
  return html`<button
    class="project-icon-cell ${active ? "active" : ""} ${sameIcon(item.icon, current) ? "current" : ""}"
    type="button"
    role="option"
    aria-label=${item.name.replaceAll("_", " ")}
    title=${`:${item.name}:`}
    data-index=${index}
    @pointerenter=${() => setActive(index, false)}
    @click=${() => void choose(item.icon)}
  >
    ${item.url ? html`<img src=${item.url} alt="" loading="lazy" draggable="false" />` : glyph(item.icon)}
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
      ${
        current
          ? html`<div class="project-icon-picker-top">
              <button class="project-icon-picker-remove" type="button" @click=${() => void choose(null)}>Remove</button>
            </div>`
          : nothing
      }
      ${state.error ? html`<div class="project-icon-error" role="alert">${state.error}</div>` : nothing}
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
      <form class="project-icon-url" @submit=${pickImage}>
        <input
          type="url"
          name="url"
          placeholder="Or paste an image URL…"
          aria-label="Image URL"
          autocomplete="off"
          spellcheck="false"
          @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
        />
        <button type="submit">Use</button>
      </form>
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
