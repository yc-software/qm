import { html, nothing, render, type TemplateResult } from "lit";
import { Box } from "lucide";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState } from "./shell";
import { skillActions } from "./skill-actions";
import {
  createReviewMatches,
  isSharedSkillScope,
  reviewMatches,
  shouldBlockRepeatedPublishClick,
  type SkillCreateReview,
  type SkillEditReview,
} from "./skill-edit-review";
import {
  filterSkillGroups,
  groupSkills,
  isArchivedSkill,
  skillEmptyState,
  statusCounts,
  type SkillStatusFilter,
} from "./skill-registry";
import { listBackLink, listPageTpl } from "./list-page";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { SkillsRefreshSequence } from "./skills-refresh";
import { SkillsMutationSequence } from "./skills-mutation";
import { t } from "./i18n.ts";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
let skillSearch = "";
let scopeFilter = "all";
let sourceFilter = "all";
let statusFilter: SkillStatusFilter = "active";
let createScopes: Array<{ scopeId: string; name: string }> = [];
let skillsPageHost: HTMLElement | null = null;

let editing: {
  id: string;
  description: string;
  body: string;
  originalDescription: string;
  originalBody: string;
  scopeId?: string;
  name: string;
  review: SkillEditReview | null;
} | null = null;
let editingTarget: SkillItem | null = null;
let saving = false;
let editError = "";

let creating: {
  name: string;
  description: string;
  body: string;
  scopeId: string;
  review: SkillCreateReview | null;
} | null = null;
let creatingSaving = false;
let createError = "";

let deleting: string | null = null;
let archiveConfirmation: SkillItem | null = null;
let editRequestSeq = 0;
const skillsRefreshes = new SkillsRefreshSequence();
const skillMutations = new SkillsMutationSequence();
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;

function scopeLabel(scope: string): string {
  return scope ? t(scope.charAt(0).toUpperCase() + scope.slice(1)) : "";
}

async function startEdit(s: SkillItem): Promise<void> {
  if (!s.id) return;
  const request = ++editRequestSeq;
  skillMutations.invalidate();
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  creating = null;
  editing = null;
  editingTarget = s;
  editError = "";
  skillsNotice = t("Loading skill instructions…");
  drawSkills();
  queueMicrotask(() => skillsPageHost?.querySelector<HTMLElement>(".context-back")?.focus());
  try {
    const r = await api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(s.id)}`);
    if (request !== editRequestSeq) return;
    editing = {
      id: s.id,
      description: r.skill.description,
      body: r.skill.body ?? "",
      originalDescription: r.skill.description,
      originalBody: r.skill.body ?? "",
      scopeId: r.skill.scopeId,
      name: r.skill.name,
      review: null,
    };
    editingTarget = r.skill;
    skillsNotice = "";
  } catch (e) {
    if (request !== editRequestSeq) return;
    editError = errMessage(e, t("Failed to load skill details."));
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>("#skill-edit-description") ??
      skillsPageHost?.querySelector<HTMLElement>(".context-back");
    target?.focus();
  });
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const skillId = target?.dataset.skillId;
    const matchingEdit = skillId
      ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-edit-trigger") ?? [])].find(
          (element) => element.dataset.skillId === skillId,
        )
      : null;
    const search = skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null;
    const create = skillsPageHost?.querySelector<HTMLElement>(".list-page-action") ?? null;
    const fallback = skillId ? (matchingEdit ?? search ?? create) : (create ?? search);
    restoreDialogFocus(target, () => fallback ?? null);
  });
}

function closeFocusedFlow(): void {
  editRequestSeq += 1;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  creating = null;
  editError = "";
  createError = "";
  skillsNotice = "";
  saving = false;
  creatingSaving = false;
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawSkills();
  restoreFocusedFlow(target);
}

function startCreate(): void {
  if (creating) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  editRequestSeq += 1;
  creating = { name: "", description: "", body: "", scopeId: createScopes[0]?.scopeId ?? "", review: null };
  createError = "";
  creatingSaving = false;
  drawSkills();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#skill-create-name")?.focus());
}

function skillMeta(s: SkillItem): string {
  const source =
    s.source === "pack" ? t("Pack {name}", { name: s.pack?.upstreamName ?? t("source") }) : t("Created here");
  return `${scopeLabel(s.scope)} · v${s.version ?? 1} · ${source}`;
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const actions = skillActions(s);
  const archived = isArchivedSkill(s);
  let state = t("Active");
  if (archived) state = t("Archived");
  else if (hasScopeVariants) state = t("Scope variant");
  let archiveLabel = t("Archive");
  if (deleting === s.id) archiveLabel = t("Working…");
  else if (archived) archiveLabel = t("Restore");
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      <span class="skill-variant-icon">${icon(Box, 16)}</span>
      <div class="skill-variant-copy">
        <div class="skill-variant-description" title=${s.description}>${s.description}</div>
        <div class="skill-variant-meta">
          ${skillMeta(s)}${s.assetCount ? ` · ${t(s.assetCount === 1 ? "{count} asset" : "{count} assets", { count: s.assetCount })}` : ""}
        </div>
        <details class="skill-variant-details">
          <summary>${t("Details")}</summary>
          <p>${s.description}</p>
          <dl>
            <div>
              <dt>${t("Scope")}</dt>
              <dd>${s.scopeId ?? scopeLabel(s.scope)}</dd>
            </div>
            <div>
              <dt>${t("Capabilities")}</dt>
              <dd>${s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : t("None required")}</dd>
            </div>
          </dl>
        </details>
      </div>
      <div class="skill-variant-state">
        <span class="badge ${archived ? "" : "skill-active"}">${state}</span>
        ${actions.edit && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${() => void startEdit(s)}>${t("Edit")}</button>` : nothing}
        ${
          actions.delete
            ? html`<button
                class="btn skill-archive-trigger"
                data-skill-id=${s.id ?? ""}
                type="button"
                ?disabled=${deleting === s.id}
                @click=${(event: Event) => void deleteSkill(s, event.currentTarget as HTMLElement)}
              >
                ${archiveLabel}
              </button>`
            : nothing
        }
      </div>
    </div>
  `;
}

function skillGroup(name: string, skills: SkillItem[]): TemplateResult {
  const activeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length;
  const hasScopeVariants = activeVariants > 1;
  return html`<section class="skill-group">
    <div class="skill-group-head">
      <h2 class="skill-group-name">
        <code>/${name}</code
        >${skills.length > 1 ? html`<span>${t("{count} variants", { count: skills.length })}</span>` : nothing}
      </h2>
      ${hasScopeVariants ? html`<span class="skill-precedence">${t("Narrower scope takes precedence where both apply")}</span>` : nothing}
    </div>
    ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
  </section>`;
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${listBackLink(t("Back to skills"), closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">${t("Edit /{name}", { name: editingTarget?.name ?? t("skill") })}</h1>
          <p>${t(editError ? "Instructions unavailable." : "Loading instructions…")}</p>
        </div>
      </div>
      ${editError ? html`<div class="form-error" role="alert">${editError}</div>` : nothing}
    </section>`;
  }
  const reviewed = reviewMatches(e.review, e.description, e.body);
  let saveLabel = t("Save");
  if (saving) saveLabel = t("Saving…");
  else if (reviewed) saveLabel = t("Publish change");
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveEdit();
      }}
    >
      ${listBackLink(t("Back to skills"), closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">${t("Edit /{name}", { name: e.name })}</h1>
          <p>
            ${t("Available to {audience}", { audience: e.scopeId?.startsWith("personal:") ? t("only you") : (e.scopeId ?? t("this context")) })}
          </p>
        </div>
        <span class="badge">${t("Editing")}</span>
      </div>
      <label class="skill-field">
        <span>${t("Description")}</span>
        <input
          id="skill-edit-description"
          class="skill-desc-input"
          type="text"
          .value=${e.description}
          data-focus-key="skill-edit-description"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>${t("Instructions")}</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          data-focus-key="skill-edit-body"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${e.body}
        ></textarea>
      </label>
      ${editError ? html`<div class="card-meta skill-shadowed">${editError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>${t("Publish this change to {scope}?", { scope: e.scopeId ?? t("this context") })}</strong>
              <div class="card-meta">
                ${t(
                  "Everyone in this context can invoke the updated instructions. Description {description}; instructions {instructions}.",
                  {
                    description: t(e.description === e.originalDescription ? "unchanged" : "changed"),
                    instructions: t(e.body === e.originalBody ? "unchanged" : "changed"),
                  },
                )}
              </div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${saving}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${saveLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${saving}
                @click=${() => {
                  e.review = null;
                  drawSkills();
                }}
              >
                ${t("Review again")}
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>${t("Cancel")}</button>
      </div>
    </form>
  `;
}

function creatorPane() {
  const c = creating!;
  const ready = c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "";
  const reviewed = createReviewMatches(c.review, c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId);
  let createLabel = t("Create skill");
  if (creatingSaving) createLabel = t("Saving…");
  else if (reviewed) createLabel = t("Publish skill");
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveCreate();
      }}
    >
      ${listBackLink(t("Back to skills"), closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">${t("New skill")}</h1>
          <p>${t("Create a reusable procedure for yourself or a shared context.")}</p>
        </div>
        <span class="badge">${t("New")}</span>
      </div>
      <label class="skill-field">
        <span>${t("Name")}</span>
        <input
          id="skill-create-name"
          class="skill-desc-input"
          type="text"
          placeholder="watch-pipeline"
          data-focus-key="skill-create-name"
          .value=${c.name}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.name = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>${t("Available to")}</span>
        <select
          class="skill-desc-input"
          .value=${c.scopeId}
          ?disabled=${creatingSaving}
          @change=${(ev: Event) => {
            c.scopeId = (ev.target as HTMLSelectElement).value;
            c.review = null;
            drawSkills();
          }}
        >
          ${createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`)}
        </select>
        <small class="card-meta">${t("Everyone in a shared context can invoke and edit this skill.")}</small>
      </label>
      <label class="skill-field">
        <span>${t("Description")}</span>
        <input
          class="skill-desc-input"
          type="text"
          placeholder=${t("One line: what it does / when to use it")}
          data-focus-key="skill-create-description"
          .value=${c.description}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>${t("Instructions")}</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder=${t("The SKILL.md contents — the steps to follow when this skill is used.")}
          data-focus-key="skill-create-body"
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${c.body}
        ></textarea>
      </label>
      ${createError ? html`<div class="card-meta skill-shadowed">${createError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>${t("Publish /{name} to {scope}?", { name: c.name.trim(), scope: c.scopeId })}</strong>
              <div class="card-meta">${t("Everyone in this context can invoke and edit these instructions.")}</div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${creatingSaving || !ready}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${createLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${creatingSaving}
                @click=${() => {
                  c.review = null;
                  drawSkills();
                }}
              >
                ${t("Review again")}
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${creatingSaving} @click=${closeFocusedFlow}>${t("Cancel")}</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  if (appState.currentView !== "skills" || !appState.mainEl) return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    skillsPageHost = document.createElement("div");
    skillsPageHost.className = "pane skills-page";
    appState.mainEl.replaceChildren(skillsPageHost);
  }
  if (creating || editingTarget) {
    render(creating ? creatorPane() : editorPane(), skillsPageHost);
    return;
  }
  const filters = { query: skillSearch, scope: scopeFilter, source: sourceFilter, status: statusFilter };
  const groups = filterSkillGroups(groupSkills(skillRows), filters);
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows: TemplateResult[] = groups.map((group) => skillGroup(group.name, group.skills));
  const clearFilters = () => {
    skillSearch = "";
    scopeFilter = "all";
    sourceFilter = "all";
    statusFilter = "all";
    drawSkills();
  };
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = t("No skills available yet.");
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>${t("No skills match these filters.")}</span
      ><button class="btn" type="button" @click=${clearFilters}>${t("Clear filters")}</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = t("Loading skills…");
  }
  render(
    html`${listPageTpl({
      title: t("Skills"),
      onRefresh: () => void renderSkills(),
      action: { label: t("New skill"), onClick: startCreate },
      search: {
        value: skillSearch,
        placeholder: t("Search skills…"),
        onInput: (value) => {
          skillSearch = value;
          drawSkills();
        },
      },
      filters: html`<div class="skill-registry-controls">
          <div class="resource-tabs" role="group" aria-label=${t("Filter by skill status")}>
            ${(
              [
                ["active", "Active", counts.active],
                ["archived", "Archived", counts.archived],
                ["all", "All", counts.all],
              ] as const
            ).map(
              ([value, label, count]) =>
                html`<button
                  type="button"
                  aria-pressed=${statusFilter === value}
                  class=${statusFilter === value ? "active" : ""}
                  @click=${() => {
                    statusFilter = value;
                    drawSkills();
                  }}
                >
                  ${t(label)}<span>${count}</span>
                </button>`,
            )}
          </div>
          <div class="skill-filter-fields">
            <label class="list-select"
              ><span>${t("Scope")}</span
              ><select
                aria-label=${t("Filter skills by scope")}
                .value=${scopeFilter}
                @change=${(e: Event) => {
                  scopeFilter = (e.currentTarget as HTMLSelectElement).value;
                  drawSkills();
                }}
              >
                <option value="all">${t("All scopes")}</option>
                <option value="personal">${t("Personal")}</option>
                <option value="channel">${t("Channel")}</option>
                <option value="group">${t("Project / group")}</option>
                <option value="team">${t("Team")}</option>
                <option value="org">${t("Organization")}</option>
              </select></label
            >
            <label class="list-select"
              ><span>${t("Source")}</span
              ><select
                aria-label=${t("Filter skills by source")}
                .value=${sourceFilter}
                @change=${(e: Event) => {
                  sourceFilter = (e.currentTarget as HTMLSelectElement).value;
                  drawSkills();
                }}
              >
                <option value="all">${t("All sources")}</option>
                <option value="native">${t("Created here")}</option>
                <option value="pack">${t("Skill packs")}</option>
                <option value="overrides">${t("Overrides")}</option>
              </select></label
            >
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${
            loading
              ? t("Loading…")
              : t(
                  filtered.length === 1
                    ? "{skills} skill in {groups} {groupLabel}"
                    : "{skills} skills in {groups} {groupLabel}",
                  {
                    skills: filtered.length,
                    groups: groups.length,
                    groupLabel: t(groups.length === 1 ? "group" : "groups"),
                  },
                )
          }
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    skillsPageHost,
  );
}

function setSkillsBackgroundInert(inert: boolean): void {
  skillsPageHost?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "skills") return;
    const fallback = target?.dataset.skillId
      ? [...document.querySelectorAll<HTMLElement>(".skill-archive-trigger")].find(
          (element) => element.dataset.skillId === target.dataset.skillId,
        )
      : null;
    restoreDialogFocus(target, () => fallback);
  });
}

function archiveDialog(skill: SkillItem): TemplateResult {
  const audience =
    skill.scope === "personal"
      ? t("you")
      : t("everyone in {scope}", { scope: skill.scopeId ?? t("this {scope}", { scope: t(skill.scope) }) });
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
  >
    <div
      class="project-dialog skill-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-archive-title"
      aria-describedby="skill-archive-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
    >
      <div class="project-dialog-head">
        <div><h2 id="skill-archive-title">${t("Archive /{name}?", { name: skill.name })}</h2></div>
      </div>
      <p id="skill-archive-impact">
        ${t(
          "This version will stop being available to {audience}. If it overrides a broader /{name}, that version becomes effective. Its history and assets are kept, and you can restore it later.",
          {
            audience,
            name: skill.name,
          },
        )}
      </p>
      <div class="project-dialog-actions actions">
        <button
          class="btn"
          type="button"
          data-dialog-cancel
          ?disabled=${deleting === skill.id}
          @click=${closeArchiveDialog}
        >
          ${t("Cancel")}</button
        ><button
          class="btn danger skill-archive-confirm"
          type="button"
          ?disabled=${deleting === skill.id}
          @click=${() => void performArchive(skill)}
        >
          ${t(deleting === skill.id ? "Archiving…" : "Archive skill")}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveEdit(): Promise<void> {
  if (!editing || saving) return;
  if (isSharedSkillScope(editing.scopeId) && !reviewMatches(editing.review, editing.description, editing.body)) {
    editing.review = { description: editing.description, body: editing.body };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  saving = true;
  editError = "";
  drawSkills();
  try {
    await api(`/api/skills/${encodeURIComponent(editing.id)}`, {
      method: "PUT",
      body: JSON.stringify({ description: editing.description, body: editing.body }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    editing = null;
    editingTarget = null;
    saving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    editError = errMessage(e, t("Failed to save skill."));
    saving = false;
    drawSkills();
  }
}

async function saveCreate(): Promise<void> {
  if (!creating || creatingSaving) return;
  const name = creating.name.trim();
  const description = creating.description.trim();
  const body = creating.body.trim();
  if (!name || !description || !body) {
    createError = t("Name, description, and instructions are all required.");
    drawSkills();
    return;
  }
  if (
    isSharedSkillScope(creating.scopeId) &&
    !createReviewMatches(creating.review, name, description, body, creating.scopeId)
  ) {
    creating.review = { name, description, body, scopeId: creating.scopeId };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  creatingSaving = true;
  createError = "";
  drawSkills();
  try {
    await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body, scopeId: creating.scopeId }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    creating = null;
    creatingSaving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    createError = errMessage(e, t("Failed to create skill."));
    creatingSaving = false;
    drawSkills();
  }
}

async function deleteSkill(s: SkillItem, trigger?: HTMLElement): Promise<void> {
  if (!s.id || deleting) return;
  if (s.status === "archived") {
    deleting = s.id;
    try {
      await api(`/api/skills/${encodeURIComponent(s.id)}/restore`, { method: "POST", body: "{}" });
      deleting = null;
      return void renderSkills();
    } catch (e) {
      deleting = null;
      skillsNotice = errMessage(e, t("Failed to restore skill."));
      return drawSkills();
    }
  }
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (skillsPageHost) focusDialogCancel(skillsPageHost);
  });
}

async function performArchive(s: SkillItem): Promise<void> {
  if (!s.id || deleting) return;
  const focusTarget = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  deleting = s.id;
  skillsNotice = "";
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>(".list-search input") ??
      skillsPageHost?.querySelector<HTMLElement>(".list-page-action");
    target?.focus();
  });
  try {
    await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    deleting = null;
    await renderSkills();
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, t("Failed to archive skill."));
    drawSkills();
    requestAnimationFrame(() => {
      const fallback = focusTarget?.dataset.skillId
        ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-archive-trigger") ?? [])].find(
            (element) => element.dataset.skillId === focusTarget.dataset.skillId,
          )
        : null;
      restoreDialogFocus(
        focusTarget,
        () => fallback ?? skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null,
      );
    });
  }
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    setSkillsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = skillsRefreshes.begin();
  skillsNotice = "";
  drawSkills(true);
  try {
    const [r, contexts] = await Promise.all([
      api<{ skills: SkillItem[] }>("/api/skills?includeShadowed=1"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch(() => ({ contexts: [] })),
    ]);
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillRows = (r.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const personal = appState.me ? `personal:${appState.me.user}` : "";
    createScopes = [
      { scopeId: personal, name: t("Personal — only you") },
      ...(contexts.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
  } catch (e) {
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillsNotice = errMessage(e, t("Failed to load skills."));
  }
  if (skillsRefreshes.isCurrent(request)) drawSkills(false);
}
