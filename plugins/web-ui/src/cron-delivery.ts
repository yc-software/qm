import { html, nothing, type TemplateResult } from "lit";
import { Plus } from "lucide";
import type { CronView } from "./crons";
import { friendlyPrincipal } from "./app-view";
import { avatarTpl } from "./ui";
import { icon } from "./icons";
import { scopeChip } from "./contexts";
import { scopePerson } from "./scope-labels";
import { sessionsState, sessionTitle } from "./sessions";
import { deepLinkPath, UI_BASE } from "./deep-link";

function destinationLabel(c: CronView, mine: boolean): TemplateResult | string {
  const d = c.destination;
  if (!d) return mine ? "This chat" : "Its owner's chat";
  if (d.type === "web") {
    const session = sessionsState.list.find((s) => s.threadRef === d.target);
    if (!session) return mine ? "Your chat" : "A chat";
    const link = html`<a href=${deepLinkPath(UI_BASE, "chats", session.id)}>${sessionTitle(session)}</a>`;
    return mine ? html`Your chat: ${link}` : link;
  }
  if (d.type === "principal") return `${friendlyPrincipal(d.target)}'s DM`;
  if (d.audienceScopeId) return scopeChip(d.audienceScopeId);
  if (d.type === "slack") return d.target.startsWith("D") ? "A Slack DM" : "A Slack channel";
  return d.type === "group" ? "A group DM" : "Somewhere else";
}

function deliveryRow(
  who: TemplateResult | string,
  where: TemplateResult | string,
  status?: { label: string; tone: string },
): TemplateResult {
  return html`<div class="cron-delivery-row">
    ${typeof who === "string" ? avatarTpl({ key: who, name: who }) : nothing}
    <span class="cron-delivery-who">${who}</span>
    <span class="cron-delivery-where">${where}</span>
    ${status ? html`<span class="cron-pill ${status.tone}">${status.label}</span>` : nothing}
  </div>`;
}

export const COPY_STATUS = {
  on: { label: "On", tone: "on" },
  paused: { label: "Paused", tone: "" },
  edited: { label: "Edited their copy", tone: "" },
};

function copyDestinationLabel(type: string | undefined): string {
  if (type === "web") return "Their own chat";
  if (type === "principal") return "Their DM";
  if (type === "slack" || type === "group") return "A Slack conversation of theirs";
  return "Nowhere yet";
}

function granteeName(scope: string): TemplateResult | string {
  return scope.startsWith("personal:") ? friendlyPrincipal(scopePerson(scope)) : scopeChip(scope);
}

export function cronDeliveryList(
  c: CronView,
  mine: boolean,
  shares: Array<{ scope: string; permission: "read" | "write" }>,
  onAdd: () => void,
): TemplateResult {
  let ownStatus = { label: "Paused", tone: "" };
  if (c.archived) ownStatus = { label: "Archived", tone: "" };
  else if (c.enabled) ownStatus = { label: "On", tone: "on" };
  return html`<div class="cron-card cron-delivery-list">
    ${deliveryRow(mine ? "You" : friendlyPrincipal(c.owner), destinationLabel(c, mine), ownStatus)}
    ${(c.copies ?? []).map((copy) =>
      deliveryRow(friendlyPrincipal(copy.owner), copyDestinationLabel(copy.deliversTo), COPY_STATUS[copy.status]),
    )}
    ${shares.map((g) => deliveryRow(granteeName(g.scope), g.permission === "write" ? "Can view and edit" : "Can view"))}
    ${
      mine
        ? html`<button class="cron-delivery-add" type="button" @click=${onAdd}>
            ${icon(Plus, 15)}<span>Add people</span>
          </button>`
        : nothing
    }
  </div>`;
}
