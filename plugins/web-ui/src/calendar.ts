import "./calendar.css";
import { html, nothing, render, type TemplateResult } from "lit";
import { ExternalLink, History, RotateCcw } from "lucide";
import { api } from "./core-bridge";
import { appState, replacePanePreservingFocus, switchView } from "./shell";
import { icon } from "./icons";
import { waveLoader } from "./ui";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import { openAppById } from "./apps-page";
import type { AppView } from "./app-view";

const cal = {
  app: null as AppView | null,
  loading: false,
  resetting: false,
  error: "",
};
let host: HTMLElement | null = null;
let generation = 0;

export function renderCalendar(): void {
  if (appState.currentView !== "calendar" || !appState.mainEl) return;
  host = document.createElement("div");
  host.className = "pane content-wide-page calendar-page";
  draw();
  replacePanePreservingFocus(host);
  if (!cal.app) void seed(false);
}

function draw(): void {
  if (!host || appState.currentView !== "calendar") return;
  render(pageTpl(), host);
}

async function seed(reset: boolean): Promise<void> {
  const current = ++generation;
  cal.loading = !reset;
  cal.resetting = reset;
  cal.error = "";
  draw();
  try {
    const result = await api<{ app: AppView }>("/api/seeded-apps/calendar", {
      method: "POST",
      body: JSON.stringify(reset ? { reset: true } : {}),
    });
    if (current === generation) cal.app = result.app;
  } catch (cause) {
    if (current === generation) cal.error = errMessage(cause, "Couldn't open your Calendar app.");
  } finally {
    if (current === generation) {
      cal.loading = false;
      cal.resetting = false;
      draw();
    }
  }
}

async function restore(app: AppView): Promise<void> {
  try {
    const result = await api<{ app: AppView }>(`/api/apps/${encodeURIComponent(app.id)}/restore`, { method: "POST" });
    cal.app = { ...app, ...result.app };
  } catch (cause) {
    cal.error = errMessage(cause, "Couldn't restore your Calendar app.");
  }
  draw();
}

async function connectGoogle(): Promise<void> {
  try {
    const result = await api<{ authorizeUrl?: string }>("/api/connectors/google/start", {
      method: "POST",
      body: JSON.stringify({ returnTo: deepLinkPath(UI_BASE, "calendar", null) }),
    });
    if (!result.authorizeUrl) throw new Error("Google didn't return a sign-in page.");
    location.href = result.authorizeUrl;
  } catch (cause) {
    cal.error = errMessage(cause, "Couldn't start connecting Google.");
    draw();
  }
}

function frameSrc(app: AppView): string {
  const url = new URL(app.webUrl ?? `/d/${encodeURIComponent(app.name ?? app.id)}/`, location.href);
  url.searchParams.set("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
  return url.href;
}

function manageApp(app: AppView): void {
  openAppById(app.id);
  switchView("apps");
}

function confirmReset(): void {
  if (confirm("Replace your Calendar app with the original version? Your changes stay in its version history."))
    void seed(true);
}

function headTpl(app: AppView | null): TemplateResult {
  return html`<div class="pane-head">
    <h1 class="pane-title">Calendar</h1>
    <div class="pane-head-actions">
      ${cal.resetting ? waveLoader({ width: 13, height: 16, label: "Resetting", cls: "cal-loader" }) : nothing}
      ${
        app?.webUrl
          ? html`<a class="btn" href=${app.webUrl} target="_blank" rel="noreferrer"
              >${icon(ExternalLink, 14)}<span>Open app</span></a
            >`
          : nothing
      }
      ${
        app
          ? html`<button class="btn" type="button" @click=${() => manageApp(app)}>
                ${icon(History, 14)}<span>Versions</span>
              </button>
              <button class="btn" type="button" ?disabled=${cal.resetting} @click=${confirmReset}>
                ${icon(RotateCcw, 14)}<span>Reset</span>
              </button>`
          : nothing
      }
    </div>
  </div>`;
}

function bodyTpl(): TemplateResult {
  const app = cal.app;
  if (cal.loading)
    return html`<div class="cal-app-status">
      ${waveLoader({ width: 13, height: 16, label: "Setting up your Calendar app", cls: "cal-loader" })}
      <span>Setting up your Calendar app…</span>
    </div>`;
  if (!app)
    return html`<div class="inbox-notice cal-notice" role="alert">
      <span>${cal.error}</span>
      <button class="btn" type="button" @click=${() => void seed(false)}>Retry</button>
    </div>`;
  if (app.status === "archived")
    return html`<div class="inbox-notice cal-notice">
      <span>Your Calendar app is archived.</span>
      <button class="btn" type="button" @click=${() => void restore(app)}>Restore</button>
    </div>`;
  return html`${
      cal.error ? html`<div class="inbox-notice cal-notice" role="alert"><span>${cal.error}</span></div>` : nothing
    } <iframe class="cal-app-frame" src=${frameSrc(app)} title="Calendar app"></iframe>`;
}

function pageTpl(): TemplateResult {
  return html`${headTpl(cal.app)}
    <section class="cal-main">${bodyTpl()}</section>`;
}

window.addEventListener("message", (event: MessageEvent) => {
  const frame = host?.querySelector<HTMLIFrameElement>(".cal-app-frame");
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data as { type?: unknown; connector?: unknown } | null;
  if (data?.type === "qm:connect" && data.connector === "google") void connectGoogle();
});
