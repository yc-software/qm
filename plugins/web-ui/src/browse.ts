import { html, nothing, render, type TemplateResult } from "lit";
import { Box, Brain, Clock, Files, Folder, KeyRound, Rocket, ShieldCheck, type IconNode } from "lucide";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import { nextGridIndex } from "./grid-nav";
import { setScopedSession } from "./session-scope";
import { ADMIN_HOME_URL, appState, can, switchView } from "./shell";
import { icon } from "./ui";
import type { View } from "./shell-state";

interface Destination {
  view: View | null;
  href: string;
  glyph: IconNode;
  label: string;
  blurb: string;
}

const BROWSE_COLUMNS = 2;

const browseState = { open: false, sel: 0 };

let host: HTMLDivElement | null = null;

function destinations(): Destination[] {
  const to = (view: View, glyph: IconNode, label: string, blurb: string): Destination => ({
    view,
    href: deepLinkPath(UI_BASE, view, null),
    glyph,
    label,
    blurb,
  });
  const list: Destination[] = [
    to("contexts", Folder, "Projects", "Group chats, files, and automations"),
    to("files", Files, "Files", "Everything you and QM have shared"),
    to("crons", Clock, "Crons", "Work that runs on a schedule"),
    to("keychain", KeyRound, "Keychain", "Connected accounts and credentials"),
    to("deploys", Rocket, "Apps", "What QM has shipped for you"),
    to("memory", Brain, "Memory", "What QM remembers about your work"),
    to("skills", Box, "Skills", "Reusable procedures QM can follow"),
  ];
  if (can("admin")) {
    list.push({
      view: null,
      href: ADMIN_HOME_URL,
      glyph: ShieldCheck,
      label: "Admin",
      blurb: "Org settings, people, and policy",
    });
  }
  return list;
}

export function openBrowse(): void {
  if (browseState.open) return;
  browseState.open = true;
  const current = destinations().findIndex((d) => d.view === appState.currentView);
  browseState.sel = current >= 0 ? current : 0;
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLElement>(".browse-tile.selected")?.focus());
}

export function closeBrowse(): void {
  if (!browseState.open) return;
  browseState.open = false;
  draw();
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "browse-host";
    document.body.appendChild(host);
  }
  return host;
}

function draw(): void {
  render(browseState.open ? paletteTpl() : nothing, ensureHost());
}

function go(d: Destination): void {
  closeBrowse();
  if (!d.view) {
    location.href = d.href;
    return;
  }
  setScopedSession(null);
  switchView(d.view);
}

function onGridKeydown(e: KeyboardEvent): void {
  const list = destinations();
  if (e.key === "Escape") {
    e.preventDefault();
    closeBrowse();
    return;
  }
  const next = nextGridIndex(browseState.sel, e.key, list.length, BROWSE_COLUMNS);
  if (next !== null) {
    e.preventDefault();
    browseState.sel = next;
    draw();
    requestAnimationFrame(() => host?.querySelector<HTMLElement>(".browse-tile.selected")?.focus());
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    const d = list[browseState.sel];
    if (!d) return;
    e.preventDefault();
    go(d);
  }
}

function tile(d: Destination, i: number): TemplateResult {
  return html`<a
    class="browse-tile ${i === browseState.sel ? "selected" : ""} ${d.view === appState.currentView ? "current" : ""}"
    href=${d.href}
    tabindex=${i === browseState.sel ? "0" : "-1"}
    @focus=${() => {
      if (browseState.sel === i) return;
      browseState.sel = i;
      draw();
    }}
    @click=${(e: MouseEvent) => {
      if (!isPlainLeftClick(e)) return;
      e.preventDefault();
      go(d);
    }}
  >
    <span class="browse-tile-icon">${icon(d.glyph, 18)}</span>
    <span class="browse-tile-text">
      <span class="browse-tile-label">${d.label}</span>
      <span class="browse-tile-blurb">${d.blurb}</span>
    </span>
  </a>`;
}

function paletteTpl(): TemplateResult {
  return html`
    <div
      class="chat-search-overlay browse-overlay"
      @pointerdown=${(e: PointerEvent) => {
        if (e.target === e.currentTarget) closeBrowse();
      }}
    >
      <div class="chat-search-palette browse-palette" role="dialog" aria-label="Browse" @keydown=${onGridKeydown}>
        <div class="chat-search-inputrow browse-head">
          <span class="browse-title">Browse</span>
          <span class="chat-search-kbd">esc</span>
        </div>
        <div class="browse-grid" role="group" aria-label="Destinations">${destinations().map(tile)}</div>
      </div>
    </div>
  `;
}
