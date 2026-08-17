import { html, render, type TemplateResult } from "lit";
import { ExternalLink, Monitor, Moon, Sun, type IconNode } from "lucide";
import { icon } from "./ui";
import { ADMIN_HOME_URL, appState } from "./shell";

export type ThemeChoice = "light" | "dark" | "system";

const THEME_KEY = "theme";

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; glyph: IconNode }> = [
  { value: "light", label: "Light", glyph: Sun },
  { value: "dark", label: "Dark", glyph: Moon },
  { value: "system", label: "System", glyph: Monitor },
];

let settingsHost: HTMLElement | null = null;

export function storedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    void 0;
  }
  return "system";
}

export function applyTheme(): void {
  const choice = storedTheme();
  const dark = choice === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : choice === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    void 0;
  }
  applyTheme();
  drawSettings();
}

export function watchSystemTheme(): void {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedTheme() === "system") applyTheme();
  });
}

function themeRow(): TemplateResult {
  const current = storedTheme();
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Theme</div>
        <div class="settings-row-note">System follows your device's light or dark setting.</div>
      </div>
      <div class="settings-choice" role="radiogroup" aria-label="Theme">
        ${THEME_OPTIONS.map(
          (option) => html`
            <button
              class="settings-choice-option ${current === option.value ? "selected" : ""}"
              type="button"
              role="radio"
              aria-checked=${current === option.value ? "true" : "false"}
              @click=${() => setTheme(option.value)}
            >
              ${icon(option.glyph, 15)}<span>${option.label}</span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function adminRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Admin</div>
        <div class="settings-row-note">Org settings, people, and policy.</div>
      </div>
      <a class="btn settings-row-action" href=${ADMIN_HOME_URL}> <span>Open admin</span>${icon(ExternalLink, 15)} </a>
    </div>
  `;
}

function accountRow(): TemplateResult {
  const me = appState.me;
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Account</div>
        <div class="settings-row-note">${me?.user ?? "Not signed in"}${me?.org ? ` · ${me.org}` : ""}</div>
      </div>
    </div>
  `;
}

function settingsPane(): TemplateResult {
  return html`
    <div class="list-page-head">
      <h1 class="pane-title">Settings</h1>
    </div>
    <div class="settings-group">${themeRow()} ${adminRow()} ${accountRow()}</div>
  `;
}

function drawSettings(): void {
  if (appState.currentView !== "settings" || !appState.mainEl) return;
  if (!settingsHost || settingsHost.parentElement !== appState.mainEl) {
    settingsHost = document.createElement("div");
    settingsHost.className = "pane settings-page";
    appState.mainEl.replaceChildren(settingsHost);
  }
  render(settingsPane(), settingsHost);
}

export function renderSettings(): void {
  drawSettings();
}
