import { html, nothing, type TemplateResult } from "lit";
import { Plus } from "lucide";
import type { CronView } from "./crons";
import { friendlyPrincipal } from "./app-view";
import { avatarTpl } from "./ui";
import { icon } from "./icons";
import { scopeChip } from "./contexts";
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

function copyStatus(copy: NonNullable<CronView["copies"]>[number]): { label: string; tone: string } {
  if (copy.forkedAt) return { label: "Edited their copy", tone: "" };
  return copy.enabled ? { label: "On", tone: "on" } : { label: "Pending", tone: "wait" };
}

function copyDestinationLabel(type: string | undefined): string {
  if (type === "web") return "Their own chat";
  if (type === "principal") return "Their DM";
  if (type === "slack" || type === "group") return "A Slack conversation of theirs";
  return "Nowhere yet";
}

function granteeName(scope: string): TemplateResult | string {
  return scope.startsWith("personal:") ? friendlyPrincipal(scope.slice("personal:".length)) : scopeChip(scope);
}

export function cronDeliveryList(
  c: CronView,
  mine: boolean,
  shares: Array<{ scope: string; permission: "read" | "write" }>,
  onAdd: () => void,
): TemplateResult {
  const ownStatus = c.archived
    ? { label: "Archived", tone: "" }
    : c.enabled
      ? { label: "On", tone: "on" }
      : { label: "Paused", tone: "" };
  return html`<div class="cron-card cron-delivery-list">
      ${deliveryRow(mine ? "You" : friendlyPrincipal(c.owner), destinationLabel(c, mine), ownStatus)}
      ${(c.copies ?? []).map((copy) =>
      deliveryRow(friendlyPrincipal(copy.owner), copyDestinationLabel(copy.deliversTo), copyStatus(copy)),
    )}
      ${shares.map((g) => deliveryRow(granteeName(g.scope), g.permission === "write" ? "Can view and edit" : "Can view"))}
      ${
      mine
        ? html`<button class="cron-delivery-add" type="button" @click=${onAdd}>
            ${icon(Plus, 15)}<span>Add people</span>
          </button>`
        : nothing
    }
    </div>
    ${c.copies?.length ? html`<div class="cron-section-note">Each person gets a linked copy that runs as them.</div>` : nothing}`;
}
