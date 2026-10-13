import { html, render } from "lit";
import { appState, paneHost } from "./shell";

export function renderCalendar(): void {
  if (appState.currentView !== "calendar" || !appState.mainEl) return;
  const host = paneHost("calendar");
  host.className = "pane content-wide-page";
  render(
    html`
      <div class="pane-head">
        <h1 class="pane-title">Calendar</h1>
      </div>
      <div class="empty compact">Coming soon.</div>
    `,
    host,
  );
}
