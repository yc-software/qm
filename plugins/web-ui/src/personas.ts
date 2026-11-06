import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Bot, Building2, GitFork, Hash, Lock, MessageSquare, Pencil, Plus, Search, Share2, Trash2, X } from "lucide";
import { api, ApiError, type CoreSession, type ProjectIcon } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { appState } from "./shell-state";
import { ensureContexts, personalScopeId } from "./contexts";
import { openSession, renderList, replacePendingSession, sessionsState, startNewChat } from "./sessions";
import { newChatDraftKey, saveDraft } from "./drafts";
import { switchView } from "./shell";
import { openProjectIconPicker, projectIconTpl } from "./project-icon";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { avatarTpl, closeFormMenus, menuSelect } from "./ui";
import { canvasToast } from "./split";
import { tip } from "./tooltip";
import { openSkillById } from "./skills";

type PersonaRole = "owner" | "write" | "read";

interface PersonaView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon?: ProjectIcon;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
  role: PersonaRole;
}

interface PersonaGrant {
  scopeId: string;
  role: PersonaRole;
  grantedBy?: string;
  grantedAt?: number | string;
  label?: string;
}

interface PersonaDetail extends PersonaView {
  access: PersonaGrant[];
  credentials: Array<{ grantId: string; service: string; ownerId: string }>;
  skills?: Array<{ id: string; name: string; description: string }>;
}

const ROLE_LABELS: Record<PersonaRole, string> = { owner: "Owner", write: "Can edit", read: "Can chat" };
const ROLE_ORDER: PersonaRole[] = ["owner", "write", "read"];

export const personasState = { enabled: false, list: [] as PersonaView[] };

let loading = false;
let notice = "";
let query = "";
let busyId: string | null = null;
let pageHost: HTMLElement | null = null;
let refreshSeq = 0;
let viewSeq = 0;

const canEditPersona = (role: PersonaRole): boolean => role !== "read";
const canSharePersona = (role: PersonaRole): boolean => role === "owner";

function groupPersonasByRole(
  personas: readonly PersonaView[],
): Array<{ role: PersonaRole; label: string; personas: PersonaView[] }> {
  return ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    personas: personas.filter((persona) => persona.role === role),
  })).filter((group) => group.personas.length);
}

function setPersonaList(list: PersonaView[]): void {
  personasState.list = list;
  renderList();
}

export function personaGlyph(personaId: string, size: number): TemplateResult {
  return personaIconTpl(personasState.list.find((p) => p.id === personaId)?.icon, size);
}

export function personaSeeds(): Array<{ scopeId: string; name: string; kind: "persona" }> {
  return personasState.list.map((p) => ({ scopeId: `persona:${p.id}`, name: p.name, kind: "persona" }));
}

function openPersonaSkill(skillId: string): void {
  openSkillById(skillId);
  switchView("skills");
}

export function viewPersona(personaId: string, focusEditor = false): void {
  switchView("personas");
  void openPersona(personaId).then(() => {
    if (!focusEditor) return;
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".persona-form textarea[name=instructions]")?.focus(),
    );
  });
}

export function personaEditable(personaId: string): boolean {
  const persona = personasState.list.find((p) => p.id === personaId);
  return persona ? canEditPersona(persona.role) : false;
}

export async function chatWithPersonaId(personaId: string): Promise<void> {
  const persona = personasState.list.find((p) => p.id === personaId);
  if (persona) await chatWithPersona(persona);
}

function personaIconTpl(value: ProjectIcon | null | undefined, size = 18): TemplateResult {
  return projectIconTpl(value ?? undefined, size) ?? icon(Bot, size);
}

function isPersonasDisabled(e: unknown): boolean {
  return (
    e instanceof ApiError && e.status === 404 && (e.body as { error?: unknown } | null)?.error === "personas_disabled"
  );
}

export async function loadPersonas(): Promise<void> {
  const seq = ++refreshSeq;
  try {
    const r = await api<{ personas?: PersonaView[] }>("/api/personas");
    if (seq !== refreshSeq) return;
    personasState.enabled = true;
    setPersonaList(r.personas ?? []);
    notice = "";
  } catch (e) {
    if (seq !== refreshSeq) return;
    if (isPersonasDisabled(e)) {
      personasState.enabled = false;
      setPersonaList([]);
      notice = "";
      return;
    }
    notice = errMessage(e, "Couldn't load personas.");
  }
}

export async function renderPersonasPage(): Promise<void> {
  if (appState.currentView !== "personas") return;
  loading = true;
  drawPersonasPage();
  const seq = viewSeq;
  await loadPersonas();
  loading = false;
  if (seq === viewSeq) drawPersonasPage();
}

function backToList(): void {
  drawPersonasPage();
  void loadPersonas().then(() => {
    if (pageHost?.isConnected) drawPersonasPage();
  });
}

function drawPersonasPage(): void {
  if (appState.currentView !== "personas" || !appState.mainEl) return;
  viewSeq++;
  if (!pageHost || pageHost.parentElement !== appState.mainEl) {
    pageHost = document.createElement("div");
    pageHost.className = "pane personas-page";
    appState.mainEl.replaceChildren(pageHost);
  }
  const term = query.trim().toLowerCase();
  const visible = personasState.list.filter(
    (persona) => !term || `${persona.name} ${persona.description}`.toLowerCase().includes(term),
  );
  let empty = "No personas yet. Create one to give QM a reusable role you can chat with anywhere.";
  if (loading && !personasState.list.length) empty = "Loading personas…";
  else if (!personasState.enabled) empty = "Personas aren't turned on for you.";
  else if (term && personasState.list.length) empty = "No personas match your search.";
  render(
    listPageTpl({
      title: "Personas",
      ...(personasState.enabled
        ? {
            action: { label: "New persona", onClick: showNewPersonaForm },
            search: {
              value: query,
              placeholder: "Search personas",
              onInput: (value: string) => {
                query = value;
                drawPersonasPage();
              },
            },
          }
        : {}),
      rows: notice ? [html`<div class="action-notice" role="alert">${notice}</div>`] : [],
      groups: groupPersonasByRole(visible).map((group) => ({
        label: group.label,
        rows: group.personas.map(personaRow),
      })),
      empty,
    }),
    pageHost,
  );
}

function rowAction(label: string, glyph: Parameters<typeof icon>[0], run: () => void): TemplateResult {
  return html`<button class="btn persona-action" type="button" ?disabled=${busyId !== null} @click=${run}>
    ${icon(glyph, 14)}<span>${label}</span>
  </button>`;
}

function personaActions(persona: PersonaView, opts: { edit: boolean }): TemplateResult {
  return html`
    ${rowAction("Chat", MessageSquare, () => void chatWithPersona(persona))}
    ${rowAction("Fork", GitFork, () => forkPersona(persona))}
    ${opts.edit && canEditPersona(persona.role) ? rowAction("Edit", Pencil, () => void openPersona(persona.id)) : nothing}
    ${canSharePersona(persona.role) ? rowAction("Share", Share2, () => void sharePersona(persona.id)) : nothing}
  `;
}

function personaRow(persona: PersonaView): TemplateResult {
  return html`
    <div class="list-row persona-row">
      <button
        class="persona-row-main"
        type="button"
        aria-label=${`Open ${persona.name}`}
        @click=${() => void openPersona(persona.id)}
      >
        <span class="persona-icon">${personaIconTpl(persona.icon, 18)}</span>
        <span class="persona-row-text">
          <span class="list-row-title" dir="auto">${persona.name}</span>
          ${persona.description ? html`<span class="persona-row-description" dir="auto">${persona.description}</span>` : nothing}
        </span>
      </button>
      <div class="deploy-row-actions persona-row-actions" aria-label=${`${persona.name} actions`}>
        ${personaActions(persona, { edit: true })}
      </div>
    </div>
  `;
}

async function busy(persona: PersonaView, work: () => Promise<void>, fallback: string): Promise<void> {
  if (busyId) return;
  busyId = persona.id;
  if (pageHost?.isConnected) drawPersonasPage();
  try {
    await work();
  } catch (e) {
    notice = errMessage(e, fallback);
    if (appState.currentView === "personas") drawPersonasPage();
  } finally {
    busyId = null;
  }
}

async function startPersonaChat(personaId: string): Promise<CoreSession> {
  await ensureContexts();
  const scopeId = personalScopeId() ?? `personal:${appState.me?.user ?? ""}`;
  const { session } = await api<{ session: CoreSession }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ scopeId }),
  });
  await api(`/api/sessions/${encodeURIComponent(session.id)}/persona`, {
    method: "PUT",
    body: JSON.stringify({ personaId }),
  });
  return { ...session, personaId };
}

function chatWithPersona(persona: PersonaView): Promise<void> {
  return busy(
    persona,
    async () => {
      const session = await startPersonaChat(persona.id);
      replacePendingSession(session.threadRef, session);
      await openSession(session);
    },
    `Couldn't start a chat with ${persona.name}.`,
  );
}

function forkPersona(persona: PersonaView): void {
  saveDraft(newChatDraftKey(appState.me?.user), `Fork the ${persona.name} persona for me.`);
  switchView("chats");
  startNewChat();
}

function paneHost(): HTMLElement | null {
  if (!appState.mainEl) return null;
  viewSeq++;
  const host = document.createElement("div");
  host.className = "resource-pane persona-pane";
  appState.mainEl.replaceChildren(host);
  return host;
}

async function fetchPersona(id: string): Promise<PersonaDetail> {
  return (await api<{ persona: PersonaDetail }>(`/api/personas/${encodeURIComponent(id)}`)).persona;
}

async function openPersona(id: string, flash = ""): Promise<void> {
  const seq = ++viewSeq;
  try {
    const persona = await fetchPersona(id);
    if (seq !== viewSeq || appState.currentView !== "personas") return;
    showPersonaDetail(persona, flash);
  } catch (e) {
    if (seq !== viewSeq) return;
    notice = errMessage(e, "Couldn't open that persona.");
    drawPersonasPage();
  }
}

function granteeLabel(scopeId: string, names: ReadonlyMap<string, string> = new Map()): string {
  const named = names.get(scopeId);
  if (named) return named;
  const [kind, ...rest] = scopeId.split(":");
  const ref = rest.join(":");
  if (kind === "personal") return ref === appState.me?.user ? "You" : ref;
  if (kind === "org") return `Everyone at ${appState.me?.companyName?.trim() || "your organization"}`;
  if (kind === "team") return `Team ${ref}`;
  if (kind === "channel") return `#${ref}`;
  return scopeId;
}

function grantLabel(grant: PersonaGrant): string {
  if (grant.scopeId === `personal:${appState.me?.user ?? ""}`) return "You";
  return grant.label ?? granteeLabel(grant.scopeId);
}

function accessListTpl(access: readonly PersonaGrant[]): TemplateResult {
  return html`<div class="project-member-list persona-access-list">
    ${access.map(
      (grant) =>
        html`<div class="permission-row">
          ${avatarTpl({ key: grant.scopeId, name: grantLabel(grant) })}
          <span class="permission-person-label" dir="auto">${grantLabel(grant)}</span>
          <span class="permission-owner">${ROLE_LABELS[grant.role]}</span>
        </div>`,
    )}
  </div>`;
}

function personaFactsTpl(persona: PersonaDetail): TemplateResult {
  return html`
    <div class="field">
      <label>Skills</label>
      ${
        persona.skills?.length
          ? html`<div class="persona-skill-list">
              ${persona.skills.map(
                (skill) =>
                  html`<button class="persona-skill" type="button" @click=${() => openPersonaSkill(skill.id)}>
                    <span class="persona-skill-name">${skill.name}</span>
                    <span class="persona-skill-description hint" dir="auto">${skill.description}</span>
                  </button>`,
              )}
            </div>`
          : html`<div class="value"><span class="hint">None yet.</span></div>`
      }
      ${
        canEditPersona(persona.role)
          ? html`<div class="hint">Ask QM to write a skill for ${persona.name}, or move one of yours into it.</div>`
          : nothing
      }
    </div>
    <div class="field">
      <label>Credentials</label>
      <div class="value persona-credentials">
        ${
          persona.credentials.length
            ? persona.credentials.map((credential) => html`<span class="badge">${credential.service}</span>`)
            : html`<span class="hint">None attached.</span>`
        }
      </div>
      ${
        canSharePersona(persona.role)
          ? html`<div class="hint">Ask QM to attach one of your credentials to ${persona.name}.</div>`
          : nothing
      }
    </div>
    <div class="field">
      <label>Who has access</label>
      ${accessListTpl(persona.access)}
    </div>
  `;
}

interface ChannelMatch {
  scopeId: string;
  channelId: string;
  name: string;
  isPrivate: boolean;
}

interface FormState {
  icon: ProjectIcon | null;
  iconChanged: boolean;
  error: string;
  saving: boolean;
}

function personaFormTpl(persona: PersonaDetail | null, state: FormState, redraw: () => void): TemplateResult {
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (state.saving) return;
    const form = e.currentTarget as HTMLFormElement;
    const field = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
    const name = field("name").trim();
    if (!name) {
      state.error = "A name is required.";
      redraw();
      return;
    }
    const body: Record<string, unknown> = {
      name,
      description: field("description").trim(),
      instructions: field("instructions"),
    };
    if (persona ? state.iconChanged : state.icon) body.icon = state.icon;
    state.saving = true;
    state.error = "";
    redraw();
    try {
      const saved = await api<{ persona: PersonaView }>(
        persona ? `/api/personas/${encodeURIComponent(persona.id)}` : "/api/personas",
        { method: persona ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      setPersonaList([...personasState.list.filter((p) => p.id !== saved.persona.id), saved.persona]);
      await openPersona(saved.persona.id, persona ? "Saved." : "");
    } catch (err) {
      state.error = errMessage(err, "Couldn't save this persona.");
      state.saving = false;
      redraw();
    }
  };
  const pickIcon = (e: Event) =>
    openProjectIconPicker({
      anchor: e.currentTarget as HTMLElement,
      current: state.icon ?? undefined,
      onPick: async (value) => {
        state.icon = value;
        state.iconChanged = true;
        redraw();
        return null;
      },
    });
  const submitLabel = persona ? "Save" : "Create persona";
  return html`
    <form class="resource-form persona-form" @submit=${submit}>
      <div class="persona-form-identity">
        <button class="persona-icon-button" type="button" aria-label="Choose an icon" @click=${pickIcon}>
          ${personaIconTpl(state.icon, 22)}
        </button>
        <label class="persona-form-name"
          >Name
          <input name="name" required autocomplete="off" .value=${persona?.name ?? ""} />
        </label>
      </div>
      <label
        >Description <span class="hint">(what it's for, in a line)</span>
        <input name="description" autocomplete="off" .value=${persona?.description ?? ""} />
      </label>
      <label
        >Instructions <span class="hint">(how it should work and sound)</span>
        <textarea
          name="instructions"
          rows="12"
          placeholder="You review contracts for the legal team. Flag unusual terms and cite the clause."
          .value=${persona?.instructions ?? ""}
        ></textarea>
      </label>
      <div class="form-error" role="alert">${state.error}</div>
      <div class="actions">
        <button class="btn primary" type="submit" ?disabled=${state.saving}>
          ${state.saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  `;
}

function showNewPersonaForm(): void {
  const host = paneHost();
  if (!host) return;
  const state: FormState = { icon: null, iconChanged: false, error: "", saving: false };
  const draw = () =>
    render(
      html`<div class="resource-detail persona-detail">
        ${listBackLink("Personas", backToList)}
        <h2>New persona</h2>
        ${personaFormTpl(null, state, draw)}
      </div>`,
      host,
    );
  draw();
  host.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

function showPersonaDetail(persona: PersonaDetail, flash: string): void {
  const host = paneHost();
  if (!host) return;
  const state: FormState = { icon: persona.icon ?? null, iconChanged: false, error: "", saving: false };
  const editable = canEditPersona(persona.role);
  const draw = () =>
    render(
      html`<div class="resource-detail persona-detail">
        ${listBackLink("Personas", backToList)}
        <div class="resource-heading">
          <h2 class="persona-heading">
            <span class="persona-icon">${personaIconTpl(persona.icon, 22)}</span><span dir="auto">${persona.name}</span>
          </h2>
          <div class="persona-detail-actions">
            ${personaActions(persona, { edit: false })}
            ${canSharePersona(persona.role) ? rowAction("Delete", Trash2, () => void deletePersona(persona)) : nothing}
          </div>
        </div>
        <div class="persona-role hint">Your role: ${ROLE_LABELS[persona.role]}</div>
        ${flash ? html`<div class="action-notice" role="status">${flash}</div>` : nothing}
        ${
          editable
            ? personaFormTpl(persona, state, draw)
            : html`
                <div class="field">
                  <label>Description</label>
                  <div class="value" dir="auto">${persona.description || "—"}</div>
                </div>
                <div class="field">
                  <label>Instructions</label>
                  <div class="value pre" dir="auto">${persona.instructions || "—"}</div>
                </div>
              `
        }
        ${personaFactsTpl(persona)}
      </div>`,
      host,
    );
  draw();
}

async function deletePersona(persona: PersonaView): Promise<void> {
  if (!window.confirm(`Delete ${persona.name}? Conversations using it will continue without it.`)) return;
  await busy(
    persona,
    async () => {
      await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: "DELETE", body: "{}" });
      setPersonaList(personasState.list.filter((p) => p.id !== persona.id));
      notice = "";
      drawPersonasPage();
    },
    `Couldn't delete ${persona.name}.`,
  );
}

async function sharePersona(id: string): Promise<void> {
  try {
    const persona = await fetchPersona(id);
    openPersonaShare(persona, () => {
      if (appState.currentView !== "personas") return;
      if (pageHost?.isConnected) backToList();
      else void openPersona(id);
    });
  } catch (e) {
    notice = errMessage(e, "Couldn't load who has access.");
    drawPersonasPage();
  }
}

function openPersonaShare(persona: PersonaDetail, onSaved: () => void): void {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog persona-share-dialog";
  dialog.setAttribute("aria-labelledby", "persona-share-heading");
  document.body.append(dialog);
  let grants: Array<{ scopeId: string; role: PersonaRole }> = persona.access.map(({ scopeId, role }) => ({
    scopeId,
    role,
  }));
  const names = new Map<string, string>(
    persona.access.flatMap((grant) => (grant.label ? [[grant.scopeId, grantLabel(grant)] as const] : [])),
  );
  let search = "";
  let people: DirectoryMatch[] = [];
  let channels: ChannelMatch[] = [];
  let searching = false;
  let searched = false;
  let searchSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busyNow = false;
  let error = "";
  const granted = (scopeId: string) => grants.some((grant) => grant.scopeId === scopeId);
  const close = () => {
    clearTimeout(timer);
    searchSeq++;
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (closeFormMenus()) return;
    close();
  });
  const add = (scopeId: string, label?: string) => {
    if (label) names.set(scopeId, label);
    if (!granted(scopeId)) grants = [...grants, { scopeId, role: "read" }];
    search = "";
    people = [];
    channels = [];
    searched = false;
    error = "";
    draw();
  };
  const setRole = (scopeId: string, value: string | null) => {
    grants =
      value === "none"
        ? grants.filter((grant) => grant.scopeId !== scopeId)
        : grants.map((grant) =>
            grant.scopeId === scopeId && value && value in ROLE_LABELS
              ? { scopeId, role: value as PersonaRole }
              : grant,
          );
    draw();
  };
  const runSearch = async () => {
    const seq = ++searchSeq;
    const term = search.trim();
    if (!term) {
      people = [];
      channels = [];
      searched = false;
      searching = false;
      draw();
      return;
    }
    searching = true;
    draw();
    try {
      const q = encodeURIComponent(term);
      const [found, rooms] = await Promise.all([
        api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${q}`),
        api<{ channels?: ChannelMatch[] }>(`/api/directory/channels?q=${q}`),
      ]);
      if (seq !== searchSeq || !dialog.isConnected) return;
      people = (found.matches ?? []).filter((person) => !granted(`personal:${person.principalId}`));
      channels = (rooms.channels ?? []).filter((channel) => !granted(channel.scopeId));
      searched = true;
    } catch (e) {
      if (seq === searchSeq) error = errMessage(e, "Couldn't search.");
    } finally {
      if (seq === searchSeq && dialog.isConnected) {
        searching = false;
        draw();
      }
    }
  };
  const save = async () => {
    if (busyNow) return;
    busyNow = true;
    error = "";
    draw();
    try {
      await api(`/api/personas/${encodeURIComponent(persona.id)}/access`, {
        method: "PUT",
        body: JSON.stringify({ access: grants }),
      });
      close();
      onSaved();
    } catch (e) {
      error = errMessage(e, "Couldn't save access.");
      busyNow = false;
      if (dialog.isConnected) draw();
    }
  };
  const orgScope = `org:${appState.me?.org ?? ""}`;
  const draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="persona-share-heading">Share ${persona.name}</h2>
            <p>Owners manage access, editors change it, and everyone else can chat with it.</p>
          </div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        <form
          class="permission-search"
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            clearTimeout(timer);
            void runSearch();
          }}
        >
          <div class="project-member-search-row">
            ${icon(Search, 16)}<input
              aria-label="Add people or Slack channels"
              placeholder="Add people or Slack channels"
              type="search"
              autocomplete="off"
              .value=${live(search)}
              @input=${(e: Event) => {
                search = (e.currentTarget as HTMLInputElement).value;
                searchSeq++;
                searched = false;
                clearTimeout(timer);
                timer = setTimeout(() => void runSearch(), 200);
              }}
            />
          </div>
          ${peopleResults(people, busyNow, (person) => add(`personal:${person.principalId}`, person.displayName))}
          <div class="project-member-results">
            ${channels.map(
              (channel) =>
                html`<button
                  class="project-member-result"
                  type="button"
                  ?disabled=${busyNow}
                  @click=${() => add(channel.scopeId, `#${channel.name}`)}
                >
                  <span class="persona-channel-glyph">${icon(channel.isPrivate ? Lock : Hash, 15)}</span>
                  <span class="project-member-name" dir="auto">${channel.name}</span>${icon(Plus, 15)}
                </button>`,
            )}
          </div>
          ${searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
          ${
            !searching && searched && !people.length && !channels.length
              ? html`<p class="permission-note">No people or channels you're in match that.</p>`
              : nothing
          }
          ${
            granted(orgScope)
              ? nothing
              : html`<button class="btn persona-share-org" type="button" @click=${() => add(orgScope)}>
                  ${icon(Building2, 15)}<span>Add ${granteeLabel(orgScope).toLowerCase()}</span>
                </button>`
          }
          <p class="permission-note">Channel members can chat with ${persona.name} only in that channel.</p>
        </form>
        <div class="permission-section-label">Who has access</div>
        <div class="project-member-list">
          ${grants.map(
            (grant) =>
              html`<div class="permission-row" data-scope=${grant.scopeId}>
                ${avatarTpl({ key: grant.scopeId, name: granteeLabel(grant.scopeId, names) })}
                <span class="permission-person-label" dir="auto">${granteeLabel(grant.scopeId, names)}</span>
                <fieldset class="permission-control" ?disabled=${busyNow}>
                  ${menuSelect({
                    value: grant.role,
                    ariaLabel: `Access for ${granteeLabel(grant.scopeId, names)}`,
                    options: [
                      ...ROLE_ORDER.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
                      { value: "none", label: "Remove access" },
                    ],
                    onSelect: (value) => setRole(grant.scopeId, value),
                  })}
                </fieldset>
              </div>`,
          )}
        </div>
        ${error ? html`<p class="composer-error" role="alert">${error}</p>` : nothing}
        <div class="project-dialog-actions actions">
          <button class="btn" type="button" @click=${close}>Cancel</button>
          <button class="btn primary" type="button" ?disabled=${busyNow} @click=${() => void save()}>
            ${busyNow ? "Saving…" : "Save"}
          </button>
        </div>
      `,
      dialog,
    );
  draw();
  dialog.showModal();
}

export function personaName(personaId: string): string {
  return personasState.list.find((p) => p.id === personaId)?.name ?? "Persona";
}

export function sessionPersonaChip(
  session: Pick<CoreSession, "id" | "personaId"> | null | undefined,
  redraw: () => void,
): TemplateResult | typeof nothing {
  const personaId = session?.personaId;
  if (!session?.id || !personaId) return nothing;
  const sessionId = session.id;
  const persona = personasState.list.find((p) => p.id === personaId);
  const name = personaName(personaId);
  return html`<span class="session-fork-badge session-persona-badge">
    <button
      class="session-persona-open"
      type="button"
      aria-label=${`View ${name}`}
      ${tip(`Chatting as ${name}. Open persona`)}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        viewPersona(personaId);
      }}
    >
      ${personaIconTpl(persona?.icon, 13)}<span dir="auto">${name}</span>
    </button>
    <button
      class="session-persona-clear"
      type="button"
      aria-label=${`Stop using ${name}`}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        void clearSessionPersona(sessionId, redraw);
      }}
    >
      ${icon(X, 11)}
    </button>
  </span>`;
}

async function clearSessionPersona(sessionId: string, redraw: () => void): Promise<void> {
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/persona`, {
      method: "PUT",
      body: JSON.stringify({ personaId: null }),
    });
    sessionsState.list = sessionsState.list.map((s) => {
      if (s.id !== sessionId) return s;
      const { personaId: _cleared, ...rest } = s;
      return rest;
    });
    redraw();
  } catch (e) {
    canvasToast(errMessage(e, "Couldn't stop using this persona."));
  }
}
