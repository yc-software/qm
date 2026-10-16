import { html, render } from "lit";
import { createAutomationPage, type AutomationView } from "./automation-page";
import { userSendMessage } from "./core-bridge";
import { listBackLink } from "./list-page";
import { appState } from "./shell";
import { startNewChat } from "./sessions";
import {
  cronNextFire,
  cronRunSummary,
  cronRunSummaryTitle,
  cronScheduleDetail,
  cronScheduleSummary,
} from "./cron-format";

export interface CronView extends AutomationView {
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
}

const page = createAutomationPage<CronView>({
  kind: "crons",
  singular: "cron",
  title: "Crons",
  runSummary: cronRunSummary,
  runSummaryTitle: cronRunSummaryTitle,
  triggerFields: (c) =>
    html`<div class="field">
        <label>Schedule</label>
        <div class="value">${cronScheduleDetail(c)}</div>
      </div>
      <div class="field">
        <label>Next run</label>
        <div class="value">${cronNextFire(c) != null ? new Date(cronNextFire(c)!).toLocaleString() : "Never"}</div>
      </div>`,
  editHint:
    "To change the message, schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.",
  editPrompt: (c, title) =>
    `Help me edit cron ${c.id} ("${title}"). Its current schedule is ${cronScheduleSummary(c)}. Ask what I want changed, then update its task, schedule, timezone, destination, or run mode as requested.`,
  create: showNewCron,
  runNow: true,
});

export const resetActiveCron = page.reset;
export const openCronById = page.openById;
export const routeCronsHistory = page.routeHistory;
export const renderCronsPage = page.render;
const drawCronsPage = page.list;

function cronForm() {
  return html`
    <form class="resource-form cron-form" @submit=${onCreateCron}>
      ${listBackLink("Crons", drawCronsPage)}
      <h2>New cron</h2>
      <p class="hint">
        Describe what you want scheduled: what to do, how often, and where the result should go. The agent sets it up
        and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title
        naming what it is for, like <code>Gmail unread digest</code> or <code>GitLab CI watch</code>.
      </p>
      <label>
        <textarea
          name="text"
          rows="4"
          placeholder="Every weekday at 9am, summarize my unread email and DM me the highlights."
          required
        ></textarea>
      </label>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">Ask the agent to set it up</button></div>
    </form>
  `;
}

function showNewCron(): void {
  if (!appState.mainEl) return;
  page.reset();
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane";
  render(cronForm(), host);
  appState.mainEl.replaceChildren(host);
}

function onCreateCron(e: Event): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const text = (form.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
  if (!text) {
    if (errSlot) errSlot.textContent = "Describe the cron you want.";
    return;
  }
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Set up a cron for me: ${text}\n\n(Sent from the web UI's New-cron pane: create it now with your scheduling API, use a calendar schedule with timezone for daily/weekly/monthly timing, give it a 2-5 word title naming what the cron is for and distinctive in a list, like "Gmail unread digest" or "GitLab CI watch", not the command and not a generic word, and confirm what you created.)`,
    ),
  );
}
