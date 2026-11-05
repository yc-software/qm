import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Bot, GitFork, MessageSquare, Pencil, Search, Share2, Trash2, X } from "lucide";
import { api, ApiError, type CoreSession, type ProjectIcon } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { appState } from "./shell-state";
import { contextsState, ensureContexts, personalScopeId, scopeTitle } from "./contexts";
import { openSession, replacePendingSession, sessionsState } from "./sessions";
import { openProjectIconPicker, projectIconTpl } from "./project-icon";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { avatarTpl, closeFormMenus, menuSelect } from "./ui";
import { canvasToast } from "./split";
import { tip } from "./tooltip";

type PersonaRole = "owner" | "write" | "read";

interface PersonaIcon {
  kind: "emoji" | "custom";
  value: string;
}

interface PersonaView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon?: PersonaIcon;
  forkedFromId?: string;
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
}

interface PersonaDetail extends PersonaView {
  access: PersonaGrant[];
  credentials: Array<{ grantId: string; service: string; ownerId: string }>;
  forkedFromName?: string;
}

type GranteeKind = "person" | "team" | "org" | "channel";

const ROLE_LABELS: Record<PersonaRole, string> = { owner: "Owner", write: "Can edit", read: "Can chat" };
const ROLE_ORDER: PersonaRole[] = ["owner", "write", "read"];
const NAME_MAX = 200;

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

function forkRequest(persona: PersonaView): Record<string, unknown> {
  const suffix = " (fork)";
  return {
    name: `${persona.name.slice(0, NAME_MAX - suffix.length)}${suffix}`,
    description: persona.description,
    instructions: persona.instructions,
    ...(persona.icon ? { icon: persona.icon } : {}),
    forkedFromId: persona.id,
  };
}

function toProjectIcon(value: PersonaIcon | null | undefined): ProjectIcon | undefined {
  if (!value) return undefined;
  return value.kind === "custom" ? { kind: "custom", name: value.value } : { kind: "emoji", value: value.value };
}

function fromProjectIcon(value: ProjectIcon | null): PersonaIcon | null {
  if (!value) return null;
  return value.kind === "custom" ? { kind: "custom", value: value.name } : { kind: "emoji", value: value.value };
}

function personaIconTpl(value: PersonaIcon | null | undefined, size = 18): TemplateResult {
  return projectIconTpl(toProjectIcon(value), size) ?? icon(Bot, size);
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
    personasState.list = r.personas ?? [];
    notice = "";
  } catch (e) {
    if (seq !== refreshSeq) return;
    if (isPersonasDisabled(e)) {
      personasState.enabled = false;
      personasState.list = [];
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
    ${rowAction("Fork", GitFork, () => void forkPersona(persona))}
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

function forkPersona(persona: PersonaView): Promise<void> {
  return busy(
    persona,
    async () => {
      const { persona: fork } = await api<{ persona: PersonaView }>("/api/personas", {
        method: "POST",
        body: JSON.stringify(forkRequest(persona)),
      });
      personasState.list = [...personasState.list.filter((p) => p.id !== fork.id), fork];
      await openPersona(fork.id, `Forked from ${persona.name}. Credentials aren't copied; attach your own.`);
    },
    `Couldn't fork ${persona.name}.`,
  );
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
  const [kind, ...rest] = scopeId.split(":");
  const ref = rest.join(":");
  if (kind === "personal") return names.get(scopeId) ?? (ref === appState.me?.user ? "You" : ref);
  if (kind === "org") return `Everyone at ${appState.me?.companyName?.trim() || "your organization"}`;
  if (kind === "team") return `Team ${ref}`;
  if (kind === "channel") {
    const title = scopeTitle(scopeId);
    return title && title !== scopeId ? title : `#${ref}`;
  }
  return scopeId;
}

function accessListTpl(access: readonly PersonaGrant[]): TemplateResult {
  return html`<div class="project-member-list persona-access-list">
    ${access.map(
      (grant) =>
        html`<div class="permission-row">
          ${avatarTpl({ key: grant.scopeId, name: granteeLabel(grant.scopeId) })}
          <span class="permission-person-label" dir="auto">${granteeLabel(grant.scopeId)}</span>
          <span class="permission-owner">${ROLE_LABELS[grant.role]}</span>
        </div>`,
    )}
  </div>`;
}

function personaFactsTpl(persona: PersonaDetail): TemplateResult {
  return html`
    ${
      persona.forkedFromName
        ? html`<div class="field">
            <label>Forked from</label>
            <div class="value" dir="auto">${persona.forkedFromName}</div>
          </div>`
        : nothing
    }
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

interface FormState {
  icon: PersonaIcon | null;
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
      personasState.list = [...personasState.list.filter((p) => p.id !== saved.persona.id), saved.persona];
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
      current: toProjectIcon(state.icon),
      onPick: async (value) => {
        state.icon = fromProjectIcon(value);
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
          <input name="name" maxlength=${NAME_MAX} required autocomplete="off" .value=${persona?.name ?? ""} />
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
      personasState.list = personasState.list.filter((p) => p.id !== persona.id);
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
  const names = new Map<string, string>();
  let kind: GranteeKind = "person";
  let search = "";
  let matches: DirectoryMatch[] = [];
  let searching = false;
  let searched = false;
  let searchSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typed = "";
  let busyNow = false;
  let error = "";
  const channels = () => contextsState.list.filter((context) => context.kind === "channel");
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
    if (!grants.some((grant) => grant.scopeId === scopeId)) grants = [...grants, { scopeId, role: "read" }];
    search = "";
    typed = "";
    matches = [];
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
      matches = [];
      searched = false;
      searching = false;
      draw();
      return;
    }
    searching = true;
    draw();
    try {
      const r = await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(term)}`);
      if (seq !== searchSeq || !dialog.isConnected) return;
      matches = (r.matches ?? [])
        .filter((person) => !grants.some((grant) => grant.scopeId === `personal:${person.principalId}`))
        .slice(0, 8);
      searched = true;
    } catch (e) {
      if (seq === searchSeq) error = errMessage(e, "Couldn't find people.");
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
  const typedAdd = (prefix: "team" | "channel", placeholder: string) =>
    html`<form
      class="project-member-search-row persona-share-typed"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        const ref = typed
          .trim()
          .replace(new RegExp(`^${prefix}:`), "")
          .replace(/^#/, "");
        if (ref) add(`${prefix}:${ref}`);
      }}
    >
      <input
        aria-label=${placeholder}
        placeholder=${placeholder}
        autocomplete="off"
        .value=${live(typed)}
        @input=${(e: Event) => {
          typed = (e.currentTarget as HTMLInputElement).value;
        }}
      />
      <button class="btn" type="submit">Add</button>
    </form>`;
  const adder = (): TemplateResult => {
    if (kind === "person")
      return html`<form
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          clearTimeout(timer);
          void runSearch();
        }}
      >
        <div class="project-member-search-row">
          ${icon(Search, 16)}<input
            aria-label="Add people"
            placeholder="Add people by name or email"
            type="search"
            autocomplete="off"
            .value=${live(search)}
            @input=${(e: Event) => {
              search = (e.currentTarget as HTMLInputElement).value;
              searchSeq++;
              matches = [];
              searched = false;
              clearTimeout(timer);
              timer = setTimeout(() => void runSearch(), 200);
            }}
          />
        </div>
        ${peopleResults(matches, busyNow, (person) => add(`personal:${person.principalId}`, person.displayName))}
        ${searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
        ${!searching && searched && !matches.length ? html`<p class="permission-note">No additional people found.</p>` : nothing}
      </form>`;
    if (kind === "team") return typedAdd("team", "Team ID");
    if (kind === "org")
      return html`<div class="persona-share-org">
        <button
          class="btn"
          type="button"
          ?disabled=${grants.some((grant) => grant.scopeId === orgScope)}
          @click=${() => add(orgScope)}
        >
          Add ${granteeLabel(orgScope).toLowerCase()}
        </button>
      </div>`;
    const known = channels().filter((context) => !grants.some((grant) => grant.scopeId === context.scopeId));
    return html`
      ${
        known.length
          ? html`<fieldset class="permission-control persona-share-channel">
              ${menuSelect({
                value: null,
                ariaLabel: "Add a Slack channel",
                options: [
                  { value: null, label: "Choose a channel" },
                  ...known.map((context) => ({
                    value: context.scopeId,
                    label: scopeTitle(context.scopeId, context.name),
                  })),
                ],
                onSelect: (value) => {
                  if (value) add(value);
                },
              })}
            </fieldset>`
          : nothing
      }
      ${typedAdd("channel", "Slack channel ID, like C0123ABCD")}
      <p class="permission-note">Channel members can chat with ${persona.name} only in that channel.</p>
    `;
  };
  const kinds: Array<{ value: GranteeKind; label: string }> = [
    { value: "person", label: "Person" },
    { value: "team", label: "Team" },
    { value: "org", label: "Everyone" },
    { value: "channel", label: "Slack channel" },
  ];
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
        <div class="resource-tabs persona-share-kinds" role="tablist" aria-label="Add access for">
          ${kinds.map(
            (option) =>
              html`<button
                type="button"
                role="tab"
                aria-selected=${kind === option.value}
                class=${kind === option.value ? "active" : ""}
                @click=${() => {
                  kind = option.value;
                  typed = "";
                  error = "";
                  draw();
                }}
              >
                ${option.label}
              </button>`,
          )}
        </div>
        <div class="permission-search">${adder()}</div>
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
  void ensureContexts().then(() => {
    if (dialog.isConnected) draw();
  });
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
  return html`<span class="session-fork-badge session-persona-badge" ${tip(`Chatting as ${name}`)}>
    ${personaIconTpl(persona?.icon, 13)}<span dir="auto">${name}</span>
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
