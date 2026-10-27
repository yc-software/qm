import { html, nothing, type TemplateResult } from "lit";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
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
import {
  artifactPage,
  confirmDialogTpl,
  detailTpl,
  fieldTpl,
  listBackLink,
  listPageTpl,
  listSelect,
  listTabs,
  showPane,
} from "./list-page";
import { fieldSelect } from "./ui";
import { scopeTitle } from "./contexts";
import { focusDialogCancel, restoreDialogFocus } from "./dialog-focus";
import { SkillsRefreshSequence } from "./skills-refresh";
import { SkillsMutationSequence } from "./skills-mutation";
import { tip } from "./tooltip";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
let skillSearch = "";
let scopeFilter = "all";
let sourceFilter = "all";
let statusFilter: SkillStatusFilter = "active";
let createScopes: Array<{ scopeId: string; name: string }> = [];
const page = artifactPage("skills", "skills-page", "skills");

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

export function openSkillById(id: string): void {
  page.pending = id;
}

export function routeSkillsHistory(skillId: string | null): void {
  page.route(
    skillId,
    (id) => skillRows.find((candidate) => candidate.id === id),
    openSkill,
    () => drawSkills(),
  );
}

function scopeLabel(scope: string): string {
  return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
}

function editAudience(scopeId: string | undefined): string {
  if (scopeId?.startsWith("personal:")) return "only you";
  return scopeId ? scopeTitle(scopeId) : "this context";
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
  skillsNotice = "Loading skill instructions…";
  drawSkills();
  queueMicrotask(() => page.host?.querySelector<HTMLElement>(".context-back")?.focus());
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
    editError = errMessage(e, "Failed to load skill details.");
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => {
    const target =
      page.host?.querySelector<HTMLElement>("#skill-edit-description") ??
      page.host?.querySelector<HTMLElement>(".context-back");
    target?.focus();
  });
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const skillId = target?.dataset.skillId;
    const matchingEdit = skillId
      ? [...(page.host?.querySelectorAll<HTMLElement>(".skill-edit-trigger") ?? [])].find(
          (element) => element.dataset.skillId === skillId,
        )
      : null;
    const search = page.host?.querySelector<HTMLElement>(".list-search input") ?? null;
    const create = page.host?.querySelector<HTMLElement>(".list-page-action") ?? null;
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

function skillScopeTitle(s: SkillItem): string {
  if (s.scopeId && (s.scope === "personal" || s.scope === "channel" || s.scope === "group")) {
    return scopeTitle(s.scopeId);
  }
  return scopeLabel(s.scope);
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const actions = skillActions(s);
  const archived = isArchivedSkill(s);
  let archiveLabel = "Archive";
  if (deleting === s.id) archiveLabel = "Working…";
  else if (archived) archiveLabel = "Restore";
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      <a
        class="skill-variant-main"
        href=${deepLinkPath(UI_BASE, "skills", null, null, s.id ?? null)}
        aria-label=${`Open /${s.name}`}
        @click=${(event: MouseEvent) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          openSkill(s, { push: true });
        }}
      >
        <code class="skill-variant-name" dir="auto">/${s.name}</code>
        <span class="skill-variant-description" ${tip(s.description)}>${s.description}</span>
      </a>
      <div class="skill-variant-state">
        ${archived ? html`<span class="badge">Archived</span>` : nothing}
        ${!archived && hasScopeVariants ? html`<span class="badge">Scope variant</span>` : nothing}
        ${actions.edit && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${() => void startEdit(s)}>Edit</button>` : nothing}
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

function openSkill(s: SkillItem, opts: { push?: boolean } = {}): void {
  page.syncUrl(s.id ?? null, opts.push);
  showPane(
    "skill-pane",
    detailTpl({
      back: "Skills",
      onBack: () => drawSkills(),
      title: `/${s.name}`,
      heading: isArchivedSkill(s) ? html`<span class="badge">Archived</span>` : undefined,
      body: html`
        ${fieldTpl("Description", s.description)} ${fieldTpl("Scope", skillScopeTitle(s))}
        ${fieldTpl("Version", s.version ?? 1)}
        ${fieldTpl("Source", s.source === "pack" ? `Pack ${s.pack?.upstreamName ?? "source"}` : "Local")}
        ${fieldTpl("Capabilities", s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : "None required")}
        ${fieldTpl("Assets", s.assetCount ?? 0)}
      `,
    }),
  );
}

function skillGroup(skills: SkillItem[]): TemplateResult {
  const activeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length;
  const hasScopeVariants = activeVariants > 1;
  return html`<section class="skill-group" aria-label=${`/${skills[0]?.name ?? "skill"}`}>
    ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
  </section>`;
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit <bdi>/${editingTarget?.name ?? "skill"}</bdi></h1>
          <p>${editError ? "Instructions unavailable." : "Loading instructions…"}</p>
        </div>
      </div>
      ${editError ? html`<div class="form-error" role="alert">${editError}</div>` : nothing}
    </section>`;
  }
  const reviewed = reviewMatches(e.review, e.description, e.body);
  let saveLabel = "Save";
  if (saving) saveLabel = "Saving…";
  else if (reviewed) saveLabel = "Publish change";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveEdit();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit <bdi>/${e.name}</bdi></h1>
          <p>Available to ${editAudience(e.scopeId)}</p>
        </div>
        <span class="badge">Editing</span>
      </div>
      <label class="skill-field">
        <span>Description</span>
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
        <span>Instructions</span>
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
              <strong>Publish this change to <bdi>${scopeTitle(e.scopeId ?? null)}</bdi>?</strong>
              <div class="card-meta">
                Everyone in this context can invoke the updated instructions. Description
                ${e.description === e.originalDescription ? "unchanged" : "changed"}; instructions
                ${e.body === e.originalBody ? "unchanged" : "changed"}.
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
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function creatorPane() {
  const c = creating!;
  const ready = c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "";
  const reviewed = createReviewMatches(c.review, c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId);
  let createLabel = "Create skill";
  if (creatingSaving) createLabel = "Saving…";
  else if (reviewed) createLabel = "Publish skill";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveCreate();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">New skill</h1>
          <p>Create a reusable procedure for yourself or a shared context.</p>
        </div>
        <span class="badge">New</span>
      </div>
      <label class="skill-field">
        <span>Name</span>
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
        <span>Available to</span>
        ${fieldSelect({
          className: "skill-scope-select",
          value: c.scopeId,
          disabled: creatingSaving,
          onChange: (value) => {
            c.scopeId = value;
            c.review = null;
            drawSkills();
          },
          options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
        })}
        <small class="card-meta">Everyone in a shared context can invoke and edit this skill.</small>
      </label>
      <label class="skill-field">
        <span>Description</span>
        <input
          class="skill-desc-input"
          type="text"
          placeholder="One line: what it does / when to use it"
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
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder="The SKILL.md contents: the steps to follow when this skill is used."
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
              <strong>Publish <bdi>/${c.name.trim()}</bdi> to <bdi>${scopeTitle(c.scopeId)}</bdi>?</strong>
              <div class="card-meta">Everyone in this context can invoke and edit these instructions.</div>
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
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${creatingSaving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  page.syncUrl(null);
  if (creating || editingTarget) {
    page.paint(creating ? creatorPane() : editorPane(), () => drawSkills());
    return;
  }
  const filters = { query: skillSearch, scope: scopeFilter, source: sourceFilter, status: statusFilter };
  const scopedScope = page.scope;
  let groups = filterSkillGroups(groupSkills(skillRows), filters);
  if (scopedScope)
    groups = groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => skill.scopeId === scopedScope),
      }))
      .filter((group) => group.skills.length > 0);
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows: TemplateResult[] = groups.map((group) => skillGroup(group.skills));
  const clearFilters = () => {
    skillSearch = "";
    scopeFilter = "all";
    sourceFilter = "all";
    statusFilter = "all";
    drawSkills();
  };
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = scopedScope ? "No skills in this context." : "No skills available yet.";
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>No skills match these filters.</span
      ><button class="btn" type="button" @click=${clearFilters}>Clear filters</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = "Loading skills…";
  }
  page.paint(
    html`${listPageTpl({
      title: "Skills",
      action: { label: "New skill", onClick: startCreate },
      search: {
        value: skillSearch,
        placeholder: "Search skills…",
        onInput: (value) => {
          skillSearch = value;
          drawSkills();
        },
      },
      filters: html`<div class="skill-registry-controls">
          ${listTabs(
            "Filter by skill status",
            [
              { value: "active" as const, label: "Active", count: counts.active },
              { value: "archived" as const, label: "Archived", count: counts.archived },
              { value: "all" as const, label: "All", count: counts.all },
            ],
            statusFilter,
            (value) => {
              statusFilter = value;
              drawSkills();
            },
          )}
          <div class="skill-filter-fields">
            ${listSelect(
              "Scope",
              scopeFilter,
              [
                ["all", "All scopes"],
                ["personal", "Personal"],
                ["channel", "Channel"],
                ["group", "Project / group"],
                ["team", "Team"],
                ["org", "Organization"],
              ],
              (value) => {
                scopeFilter = value;
                drawSkills();
              },
            )}
            ${listSelect(
              "Source",
              sourceFilter,
              [
                ["all", "All sources"],
                ["native", "Local"],
                ["pack", "Skill packs"],
                ["overrides", "Overrides"],
              ],
              (value) => {
                sourceFilter = value;
                drawSkills();
              },
            )}
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${loading ? "Loading…" : `${filtered.length} skill${filtered.length === 1 ? "" : "s"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    () => drawSkills(),
  );
}

function setSkillsBackgroundInert(inert: boolean): void {
  page.host?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
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
      ? "you"
      : `everyone in ${skill.scopeId ? scopeTitle(skill.scopeId) : `this ${skill.scope}`}`;
  return confirmDialogTpl({
    id: "skill-archive",
    title: html`Archive <bdi>/${skill.name}</bdi>?`,
    body: html`This version will stop being available to ${audience}. If it overrides a broader
      <bdi>/${skill.name}</bdi>, that version becomes effective. Its history and assets are kept, and you can restore it
      later.`,
    confirm: deleting === skill.id ? "Archiving…" : "Archive skill",
    busy: deleting === skill.id,
    onCancel: closeArchiveDialog,
    onConfirm: () => void performArchive(skill),
  });
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
    editError = errMessage(e, "Failed to save skill.");
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
    createError = "Name, description, and instructions are all required.";
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
    createError = errMessage(e, "Failed to create skill.");
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
      skillsNotice = errMessage(e, "Failed to restore skill.");
      return drawSkills();
    }
  }
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (page.host) focusDialogCancel(page.host);
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
      page.host?.querySelector<HTMLElement>(".list-search input") ??
      page.host?.querySelector<HTMLElement>(".list-page-action");
    target?.focus();
  });
  try {
    await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    deleting = null;
    await renderSkills();
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, "Failed to archive skill.");
    drawSkills();
    requestAnimationFrame(() => {
      const fallback = focusTarget?.dataset.skillId
        ? [...(page.host?.querySelectorAll<HTMLElement>(".skill-archive-trigger") ?? [])].find(
            (element) => element.dataset.skillId === focusTarget.dataset.skillId,
          )
        : null;
      restoreDialogFocus(
        focusTarget,
        () => fallback ?? page.host?.querySelector<HTMLElement>(".list-search input") ?? null,
      );
    });
  }
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  page.adoptScope();
  if (!page.host || page.host.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    setSkillsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = skillsRefreshes.begin();
  const wanted = page.pending;
  page.pending = null;
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
      { scopeId: personal, name: "Personal (only you)" },
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
    skillsNotice = errMessage(e, "Failed to load skills.");
  }
  if (!skillsRefreshes.isCurrent(request)) return;
  const skill = wanted ? skillRows.find((candidate) => candidate.id === wanted) : undefined;
  if (wanted && !skill) skillsNotice = "That skill wasn't found, or you don't have access to it.";
  if (skill) openSkill(skill);
  else drawSkills(false);
}
