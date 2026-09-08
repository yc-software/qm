import { html, nothing, render, type TemplateResult } from "lit";
import { BookOpen, ExternalLink, LogOut, Monitor, Moon, ShieldUser, Sun, type IconNode } from "lucide";
import { icon } from "./ui";
import { ADMIN_HOME_URL, appState, can, signOut } from "./shell";
import { sessionsState, setWebOnly } from "./sessions";
import { errMessage } from "../../chassis/src/errors";
import { importTheme, isPalette, themeCss, themeTokens, type Palette } from "./theme-import";

export type ThemeChoice = "light" | "dark" | "system" | "custom";

const THEME_KEY = "theme";
const CUSTOM_THEME_KEY = "theme:custom";
const CUSTOM_THEME_STYLE_ID = "custom-theme";
const THEME_FILE_ACCEPT = ".itermcolors,.plist,.json,.jsonc,application/json,text/xml,application/xml";

const QM_ABOUT_URL = "https://github.com/yc-software/qm";

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; glyph: IconNode }> = [
  { value: "light", label: "Light", glyph: Sun },
  { value: "dark", label: "Dark", glyph: Moon },
  { value: "system", label: "System", glyph: Monitor },
];

let settingsHost: HTMLElement | null = null;
let themeImportError: string | null = null;

export function storedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    if (stored === "custom" && storedCustomTheme()) return stored;
  } catch {
    void 0;
  }
  return "system";
}

export function storedCustomTheme(): Palette | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) ?? "null");
    return isPalette(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeCustomTheme(palette: Palette | null): void {
  try {
    if (palette) localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(palette));
    else localStorage.removeItem(CUSTOM_THEME_KEY);
  } catch {
    void 0;
  }
}

export function applyTheme(): void {
  const choice = storedTheme();
  const custom = choice === "custom" ? storedCustomTheme() : null;
  const root = document.documentElement;
  let styleEl = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (custom) {
    const tokens = themeTokens(custom);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = CUSTOM_THEME_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = themeCss(tokens);
    root.classList.toggle("dark", tokens.dark);
    return;
  }
  styleEl?.remove();
  const dark = choice === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : choice === "dark";
  root.classList.toggle("dark", dark);
}

export function setTheme(choice: ThemeChoice): void {
  themeImportError = null;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    void 0;
  }
  applyTheme();
  drawSettings();
}

export function installCustomTheme(palette: Palette): void {
  storeCustomTheme(palette);
  setTheme("custom");
}

export function removeCustomTheme(): void {
  const wasActive = storedTheme() === "custom";
  storeCustomTheme(null);
  setTheme(wasActive ? "system" : storedTheme());
}

async function onThemeFileChosen(e: Event): Promise<void> {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    installCustomTheme(importTheme(file.name, await file.text()));
  } catch (err) {
    themeImportError = errMessage(err, "Couldn't read that theme file.");
    drawSettings();
  }
}

export function watchSystemTheme(): void {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedTheme() === "system") applyTheme();
  });
}

function themeSwatches(palette: Palette): TemplateResult {
  const { vars } = themeTokens(palette);
  const swatches = [vars["--background"], vars["--syntax-tag"], vars["--syntax-string"], vars["--primary"]];
  return html`
    <span class="theme-swatches" aria-hidden="true">
      ${swatches.map((color) => html`<span class="theme-swatch" style="background:${color}"></span>`)}
    </span>
  `;
}

function themeOption(
  value: ThemeChoice,
  current: ThemeChoice,
  label: string,
  glyph: TemplateResult | SVGElement,
): TemplateResult {
  return html`
    <button
      class="settings-choice-option ${current === value ? "selected" : ""}"
      type="button"
      role="radio"
      aria-checked=${current === value ? "true" : "false"}
      @click=${() => setTheme(value)}
    >
      ${glyph}<span>${label}</span>
    </button>
  `;
}

function themeRow(): TemplateResult {
  const current = storedTheme();
  const custom = storedCustomTheme();
  const note = themeImportError
    ? html`<span class="settings-row-error">${themeImportError}</span>`
    : "System follows your device's light or dark setting. Import an iTerm2 .itermcolors or a VS Code color theme .json to paint the app with its palette.";
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Theme</div>
        <div class="settings-row-note">${note}</div>
      </div>
      <div class="settings-theme-controls">
        <div class="settings-choice" role="radiogroup" aria-label="Theme">
          ${THEME_OPTIONS.map((option) => themeOption(option.value, current, option.label, icon(option.glyph, 15)))}
          ${custom ? themeOption("custom", current, custom.name, themeSwatches(custom)) : nothing}
        </div>
        <div class="settings-theme-import">
          <input
            class="theme-file-input"
            type="file"
            hidden
            accept=${THEME_FILE_ACCEPT}
            @change=${(e: Event) => void onThemeFileChosen(e)}
          />
          <button
            class="settings-theme-link"
            type="button"
            @click=${(e: Event) =>
              (e.currentTarget as HTMLElement).parentElement
                ?.querySelector<HTMLInputElement>(".theme-file-input")
                ?.click()}
          >
            ${custom ? "Replace theme file" : "Import theme file"}
          </button>
          ${
            custom
              ? html`
                  <button
                    class="settings-theme-link"
                    type="button"
                    aria-label="Remove imported theme"
                    @click=${() => removeCustomTheme()}
                  >
                    Remove
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

const SURFACE_OPTIONS: Array<{ webOnly: boolean; label: string }> = [
  { webOnly: false, label: "All conversations" },
  { webOnly: true, label: "Web only" },
];

function sidebarSurfaceRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Sidebar conversations</div>
        <div class="settings-row-note">Web only hides the Slack channels and DMs the agent also works in.</div>
      </div>
      <div class="settings-choice" role="radiogroup" aria-label="Sidebar conversations">
        ${SURFACE_OPTIONS.map(
          (option) => html`
            <button
              class="settings-choice-option ${sessionsState.webOnly === option.webOnly ? "selected" : ""}"
              type="button"
              role="radio"
              aria-checked=${sessionsState.webOnly === option.webOnly ? "true" : "false"}
              @click=${() => {
                setWebOnly(option.webOnly);
                drawSettings();
              }}
            >
              <span>${option.label}</span>
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
      <a class="btn settings-row-action" href=${ADMIN_HOME_URL}>
        ${icon(ShieldUser, 15)}<span>Open admin</span>${icon(ExternalLink, 14)}
      </a>
    </div>
  `;
}

function aboutRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">Learn more about QM</div>
        <div class="settings-row-note">
          Why Y Combinator built this open-source agent harness, and how to run your own.
        </div>
      </div>
      <a class="btn settings-row-action" href=${QM_ABOUT_URL} target="_blank" rel="noreferrer noopener">
        ${icon(BookOpen, 15)}<span>Read the announcement</span>${icon(ExternalLink, 14)}
      </a>
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
      <button class="btn settings-row-action" type="button" @click=${() => void signOut()}>
        ${icon(LogOut, 15)}<span>Sign out</span>
      </button>
    </div>
  `;
}

function settingsPane(): TemplateResult {
  return html`
    <div class="list-page-head">
      <h1 class="pane-title">Settings</h1>
    </div>
    <div class="settings-group">
      ${themeRow()} ${sidebarSurfaceRow()} ${can("admin") ? adminRow() : nothing} ${aboutRow()} ${accountRow()}
    </div>
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
