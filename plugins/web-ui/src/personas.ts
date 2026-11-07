import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  Bot,
  Building2,
  GitFork,
  Hash,
  KeyRound,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide";
import { api, ApiError, type CoreSession, type ProjectIcon } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { appState } from "./shell-state";
import { ensureContexts, personalScopeId } from "./contexts";
import { openSession, renderList, replacePendingSession, sessionsState, startNewChat } from "./sessions";
import { newChatDraftKey, saveDraft } from "./drafts";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { switchView } from "./shell";
import { openProjectIconPicker, projectIconTpl } from "./project-icon";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { avatarTpl, menuSelect } from "./ui";
import { canvasToast } from "./split";
import { tip } from "./tooltip";
import { openSkillById, startSkillCreateIn } from "./skills";
import { cronTitle, openCronById, type CronView } from "./crons";
import { cronScheduleSummary } from "./cron-format";
import { historySectionTpl } from "./persona-history";

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
  version: number;
  role: PersonaRole;
}

interface OwnCredential {
  id: string;
  service: string;
  accountLabel?: string;
}

interface PersonaGrant {
  scopeId: string;
  role: PersonaRole;
  grantedBy?: string;
  grantedAt?: number | string;
  label?: string;
  personasEnabled: boolean;
}

interface PersonaDetail extends PersonaView {
  access: PersonaGrant[];
  credentials: Array<{ grantId: string; service: string; ownerId: string }>;
  skills?: Array<{ id: string; name: string; description: string }>;
  crons?: Array<Pick<CronView, "id" | "title" | "action" | "message" | "schedule" | "enabled">>;
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

function openPersonaCron(cronId: string): void {
  openCronById(cronId);
  switchView("crons");
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
  const pending = pendingPersonaId;
  pendingPersonaId = null;
  await loadPersonas();
  loading = false;
  if (seq !== viewSeq) return;
  if (pending) await openPersona(pending);
  else drawPersonasPage();
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
  syncPersonaUrl(null);
  resetPicker();
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
    ${canSharePersona(persona.role) ? rowAction("Share", Share2, () => void openGranteePicker(persona.id, "people")) : nothing}
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

function paneHost(personaId = ""): HTMLElement | null {
  if (!appState.mainEl) return null;
  viewSeq++;
  const current = appState.mainEl.firstElementChild;
  if (personaId && current instanceof HTMLElement && current.dataset.persona === personaId) return current;
  const host = document.createElement("div");
  host.className = "resource-pane persona-pane";
  host.dataset.persona = personaId;
  appState.mainEl.replaceChildren(host);
  return host;
}

let pendingPersonaId: string | null = null;

export function openPersonaById(id: string): void {
  pendingPersonaId = id;
}

export function routePersonasHistory(personaId: string | null): void {
  if (appState.currentView !== "personas") return;
  if (personaId) void openPersona(personaId);
  else drawPersonasPage();
}

function syncPersonaUrl(personaId: string | null): void {
  if (appState.currentView !== "personas") return;
  const next = deepLinkPath(UI_BASE, "personas", null, null, personaId);
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
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

const orgName = (): string => appState.me?.companyName?.trim() || "your organization";

function granteeLabel(scopeId: string): string {
  const [kind, ...rest] = scopeId.split(":");
  const ref = rest.join(":");
  if (kind === "personal") return ref === appState.me?.user ? "You" : ref;
  if (kind === "org") return `Everyone at ${orgName()}`;
  if (kind === "team") return `Team ${ref}`;
  if (kind === "channel") return `#${ref}`;
  return scopeId;
}

const isMe = (grant: Pick<PersonaGrant, "scopeId">): boolean => grant.scopeId === `personal:${appState.me?.user ?? ""}`;

function grantLabel(grant: PersonaGrant): string {
  if (isMe(grant)) return "You";
  return grant.label ?? granteeLabel(grant.scopeId);
}

const LAST_OWNER = "The only owner. Make someone else an owner before changing this.";

function flagOffNote(grant: PersonaGrant): string {
  return grant.scopeId.startsWith("personal:")
    ? "Can't use personas until an admin turns on the Personas feature flag for them in Admin → Customize → Feature flags."
    : "Personas is off for the organization, so only people with the flag on can use this. An admin can turn it on for everyone in Admin → Customize → Feature flags.";
}

function accessRowTpl(persona: PersonaDetail, grant: PersonaGrant, lastOwner: boolean): TemplateResult {
  const label = grantLabel(grant);
  const manage = canSharePersona(persona.role);
  const blocked = manage && lastOwner ? { disabledHint: LAST_OWNER } : {};
  return html`<div class="permission-row project-member-row" data-scope=${grant.scopeId}>
    ${
      grant.scopeId.startsWith("org:")
        ? html`<span class="project-member-avatar" aria-hidden="true">${icon(Building2, 16)}</span>`
        : avatarTpl({ key: grant.scopeId, name: label })
    }
    <span class="permission-person-label" dir="auto"
      >${label}${manage && lastOwner ? html`<small>${LAST_OWNER}</small>` : nothing}${
        grant.personasEnabled ? nothing : html`<small>${flagOffNote(grant)}</small>`
      }</span
    >
    ${
      manage
        ? html`<fieldset class="permission-control" ?disabled=${busyId !== null}>
            ${menuSelect({
              value: grant.role,
              ariaLabel: `Access for ${label}`,
              options: [
                ...ROLE_ORDER.map((role) => ({
                  value: role,
                  label: ROLE_LABELS[role],
                  ...(role === "owner" ? {} : blocked),
                })),
                { value: "none", label: "Remove access", ...blocked },
              ],
              onSelect: (value) => void changeRole(persona, grant, value),
            })}
          </fieldset>`
        : html`<span class="permission-owner">${ROLE_LABELS[grant.role]}</span>`
    }
  </div>`;
}

function sectionTpl(
  title: string,
  actions: TemplateResult | typeof nothing,
  body: TemplateResult,
  hint?: string,
): TemplateResult {
  return html`<section class="persona-section">
    <div class="persona-section-head">
      <h3>${title}</h3>
      <div class="persona-section-actions">${actions}</div>
    </div>
    ${body} ${hint ? html`<div class="hint">${hint}</div>` : nothing}
  </section>`;
}

function emptyTpl(text: string): TemplateResult {
  return html`<div class="persona-empty hint">${text}</div>`;
}

function removableRow(
  glyph: TemplateResult,
  name: string,
  detail: string,
  removeLabel: string | null,
  onRemove: () => void,
): TemplateResult {
  return html`<div class="persona-item">
    ${glyph}
    <span class="persona-item-text">
      <span class="persona-skill-name" dir="auto">${name}</span>
      ${detail ? html`<span class="hint" dir="auto">${detail}</span>` : nothing}
    </span>
    ${
      removeLabel
        ? html`<button class="chip-x persona-item-remove" type="button" aria-label=${removeLabel} @click=${onRemove}>
            ${icon(X, 14)}
          </button>`
        : nothing
    }
  </div>`;
}

function skillsSection(persona: PersonaDetail): TemplateResult {
  const scopeId = `persona:${persona.id}`;
  const actions = canEditPersona(persona.role)
    ? html`${rowAction("New skill", Plus, () => startSkillCreateIn(scopeId, persona.name))}
      ${rowAction(
        "Ask QM",
        Sparkles,
        () => void chatWithPrompt(persona, `Write a skill for the ${persona.name} persona that `),
      )}`
    : nothing;
  const body = persona.skills?.length
    ? html`<div class="persona-skill-list">
        ${persona.skills.map(
          (skill) =>
            html`<button class="persona-skill" type="button" @click=${() => openPersonaSkill(skill.id)}>
              <span class="persona-skill-name">${skill.name}</span>
              <span class="persona-skill-description hint" dir="auto">${skill.description}</span>
            </button>`,
        )}
      </div>`
    : emptyTpl("No skills yet.");
  return sectionTpl("Skills", actions, body);
}

function cronsSection(persona: PersonaDetail): TemplateResult {
  const body = persona.crons?.length
    ? html`<div class="persona-skill-list">
        ${persona.crons.map(
          (cron) =>
            html`<button class="persona-skill" type="button" @click=${() => openPersonaCron(cron.id)}>
              <span class="persona-skill-name" dir="auto">${cronTitle(cron)}</span>
              <span class="persona-skill-description hint"
                >${cronScheduleSummary(cron)}${cron.enabled ? "" : " · paused"}</span
              >
            </button>`,
        )}
      </div>`
    : emptyTpl("No crons yet.");
  return sectionTpl(
    "Crons",
    rowAction("New cron", Plus, () => void chatWithPrompt(persona, "Set up a cron that ")),
    body,
    `A cron set up in a chat with ${persona.name} runs as ${persona.name}.`,
  );
}

function credentialsSection(persona: PersonaDetail, reload: (flash: string) => void): TemplateResult {
  const owner = canSharePersona(persona.role);
  const body = persona.credentials.length
    ? html`<div class="persona-skill-list">
        ${persona.credentials.map((credential) =>
          removableRow(
            html`<span class="persona-channel-glyph">${icon(KeyRound, 14)}</span>`,
            credential.service,
            credential.ownerId === appState.me?.user ? "Yours" : `From ${credential.ownerId}`,
            owner ? `Detach ${credential.service}` : null,
            () => void detachCredential(persona, credential, reload),
          ),
        )}
      </div>`
    : emptyTpl("None attached.");
  return sectionTpl(
    "Credentials",
    owner ? rowAction("Attach", Plus, () => void openCredentialPicker(persona, reload)) : nothing,
    body,
    `Everyone who can chat with ${persona.name} uses attached credentials through it, but never sees them.`,
  );
}

function channelsSection(persona: PersonaDetail): TemplateResult {
  const owner = canSharePersona(persona.role);
  const channels = persona.access.filter((grant) => grant.scopeId.startsWith("channel:"));
  const flagNotes = new Set(channels.filter((grant) => !grant.personasEnabled).map(flagOffNote));
  const flagNote = [...flagNotes].map((note) => html`<p class="permission-note">${note}</p>`);
  const list = channels.length
    ? html`<div class="persona-skill-list">
        ${channels.map((grant) =>
          removableRow(
            html`<span class="persona-channel-glyph">${icon(Hash, 14)}</span>`,
            grantLabel(grant),
            "",
            owner ? `Remove ${grantLabel(grant)}` : null,
            () => void removeGrantee(persona, grant),
          ),
        )}
      </div>`
    : emptyTpl("No channels.");
  return sectionTpl(
    "Slack channels",
    owner ? rowAction("Add channel", Plus, () => void openGranteePicker(persona.id, "channels")) : nothing,
    html`${list}${flagNote}${granteePickerTpl(persona, "channels")}`,
    `People in these channels can ask QM to use ${persona.name} in a thread there. QM stays the default; they can't edit ${persona.name}.`,
  );
}

function accessSection(persona: PersonaDetail): TemplateResult {
  const owner = canSharePersona(persona.role);
  const people = persona.access.filter((grant) => !grant.scopeId.startsWith("channel:"));
  const owners = persona.access.filter((grant) => grant.role === "owner");
  return sectionTpl(
    "Who has access",
    owner ? rowAction("Add people", Plus, () => void openGranteePicker(persona.id, "people")) : nothing,
    html`<div class="project-member-list persona-access-list">
        ${people.map((grant) => accessRowTpl(persona, grant, owners.length === 1 && grant.role === "owner"))}
      </div>
      ${granteePickerTpl(persona, "people")}`,
    owner
      ? "Owners manage access and credentials, editors change its instructions and skills, and everyone else can chat with it."
      : `Only owners can change who has access: ask ${new Intl.ListFormat("en", { type: "disjunction" }).format(owners.map(grantLabel))}.`,
  );
}

function personaFactsTpl(persona: PersonaDetail, reload: (flash: string) => void, redraw: () => void): TemplateResult {
  return html`
    ${skillsSection(persona)} ${cronsSection(persona)} ${credentialsSection(persona, reload)}
    ${channelsSection(persona)} ${accessSection(persona)}
    ${historySectionTpl({
      persona,
      canEdit: canEditPersona(persona.role),
      action: rowAction,
      redraw,
      restored: (updated, flash) => {
        const view = updated as PersonaView;
        setPersonaList([...personasState.list.filter((p) => p.id !== view.id), view]);
        reload(flash);
      },
      failed: showActionError,
    })}
  `;
}

async function chatWithPrompt(persona: PersonaView, prompt: string): Promise<void> {
  await busy(
    persona,
    async () => {
      const session = await startPersonaChat(persona.id);
      saveDraft(session.threadRef, prompt);
      replacePendingSession(session.threadRef, session);
      await openSession(session);
    },
    `Couldn't start a chat with ${persona.name}.`,
  );
}

async function saveAccess(
  persona: PersonaDetail,
  change: (access: PersonaGrant[]) => Array<Pick<PersonaGrant, "scopeId" | "role">>,
): Promise<boolean> {
  if (busyId) return false;
  busyId = persona.id;
  actionError = "";
  clearTimeout(pickerTimer);
  pickerSeq++;
  if (picker) picker.searching = false;
  redrawDetail();
  try {
    const { access } = await fetchPersona(persona.id);
    await api(`/api/personas/${encodeURIComponent(persona.id)}/access`, {
      method: "PUT",
      body: JSON.stringify({ access: change(access).map(({ scopeId, role }) => ({ scopeId, role })) }),
    });
    busyId = null;
    return true;
  } catch (e) {
    busyId = null;
    showActionError(errMessage(e, "Couldn't save access."));
    return false;
  }
}

async function addGrantee(persona: PersonaDetail, scopeId: string, label: string): Promise<void> {
  const added = await saveAccess(persona, (access) =>
    access.some((grant) => grant.scopeId === scopeId) ? access : [...access, { scopeId, role: "read" }],
  );
  if (!added) return;
  if (picker) Object.assign(picker, { query: "", people: [], channels: [], searched: false, error: "" });
  await openPersona(persona.id, `Added ${label}.`);
  focusPicker();
}

async function changeRole(persona: PersonaDetail, grant: PersonaGrant, value: string | null): Promise<void> {
  if (value === "none") return removeGrantee(persona, grant);
  const role = ROLE_ORDER.find((r) => r === value);
  if (!role || role === grant.role) return;
  if (isMe(grant) && !window.confirm(`Change your own role on ${persona.name} to ${ROLE_LABELS[role]}?`)) return;
  const saved = await saveAccess(persona, (access) =>
    access.map((g) => (g.scopeId === grant.scopeId ? { scopeId: g.scopeId, role } : g)),
  );
  if (saved) await openPersona(persona.id, "Access saved.");
}

async function removeGrantee(persona: PersonaDetail, grant: PersonaGrant): Promise<void> {
  const label = grantLabel(grant);
  const question = isMe(grant)
    ? `Remove yourself from ${persona.name}? You may lose access to it.`
    : `Remove ${label} from ${persona.name}?`;
  if (!window.confirm(question)) return;
  if (!(await saveAccess(persona, (access) => access.filter((g) => g.scopeId !== grant.scopeId)))) return;
  if (isMe(grant)) backToList();
  else await openPersona(persona.id, `Removed ${label}.`);
}

async function detachCredential(
  persona: PersonaDetail,
  credential: PersonaDetail["credentials"][number],
  reload: (flash: string) => void,
): Promise<void> {
  if (!window.confirm(`Detach ${credential.service} from ${persona.name}?`)) return;
  try {
    await api(`/api/personas/${encodeURIComponent(persona.id)}/credentials/${encodeURIComponent(credential.grantId)}`, {
      method: "DELETE",
    });
    reload(`Detached ${credential.service}.`);
  } catch (e) {
    showActionError(errMessage(e, "Couldn't detach that credential."));
  }
}

async function openCredentialPicker(persona: PersonaDetail, reload: (flash: string) => void): Promise<void> {
  const heading = `Attach a credential to ${persona.name}`;
  const intro = "Pick one of your own. You can detach it any time.";
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog persona-picker-dialog";
  dialog.setAttribute("aria-label", heading);
  document.body.append(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  let credentials: OwnCredential[] | null = null;
  let error = "";
  let busyNow = false;
  const attached = new Set(persona.credentials.filter((c) => c.ownerId === appState.me?.user).map((c) => c.service));
  const attach = async (credential: OwnCredential) => {
    if (busyNow) return;
    busyNow = true;
    draw();
    try {
      await api(`/api/personas/${encodeURIComponent(persona.id)}/credentials`, {
        method: "POST",
        body: JSON.stringify({ credentialId: credential.id }),
      });
      close();
      reload(`Attached ${credential.service}.`);
    } catch (e) {
      error = errMessage(e, "Couldn't attach that credential.");
      busyNow = false;
      if (dialog.isConnected) draw();
    }
  };
  const credentialChoices = (): TemplateResult | TemplateResult[] => {
    if (credentials === null) return html`<p class="permission-note" role="status">Loading your credentials…</p>`;
    if (!credentials.length) return html`<p class="permission-note">You have no saved credentials yet.</p>`;
    return credentials.map(
      (credential) =>
        html`<button
          class="project-member-result"
          type="button"
          ?disabled=${busyNow || attached.has(credential.service)}
          @click=${() => void attach(credential)}
        >
          <span class="persona-channel-glyph">${icon(KeyRound, 15)}</span>
          <span class="project-member-name" dir="auto"
            >${credential.service}${credential.accountLabel ? html` <span class="hint">${credential.accountLabel}</span>` : nothing}</span
          >${attached.has(credential.service) ? html`<span class="hint">Attached</span>` : icon(Plus, 15)}
        </button>`,
    );
  };
  const draw = () =>
    render(
      html`<div class="project-dialog-head">
          <div>
            <h2>${heading}</h2>
            <p>${intro}</p>
          </div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        <div class="project-member-results persona-picker-list">${credentialChoices()}</div>
        ${error ? html`<p class="composer-error" role="alert">${error}</p>` : nothing}`,
      dialog,
    );
  draw();
  dialog.showModal();
  try {
    const overview = await api<{ credentials?: OwnCredential[] }>("/api/keychain/overview");
    credentials = (overview.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
  } catch (e) {
    credentials = [];
    error = errMessage(e, "Couldn't load your credentials.");
  }
  if (dialog.isConnected) draw();
}

interface ChannelMatch {
  scopeId: string;
  channelId: string;
  name: string;
  isPrivate: boolean;
}

type PickerKind = "people" | "channels";

interface GranteePicker {
  personaId: string;
  kind: PickerKind;
  query: string;
  people: DirectoryMatch[];
  channels: ChannelMatch[];
  searching: boolean;
  searched: boolean;
  error: string;
}

let picker: GranteePicker | null = null;
let pickerSeq = 0;
let pickerTimer: ReturnType<typeof setTimeout> | undefined;
let redrawDetail: () => void = () => {};
let actionError = "";

function showActionError(message: string): void {
  actionError = message;
  redrawDetail();
}

function resetPicker(): void {
  clearTimeout(pickerTimer);
  pickerSeq++;
  picker = null;
}

function focusPicker(): void {
  document.querySelector<HTMLInputElement>("#persona-grantee-search")?.focus();
}

async function openGranteePicker(personaId: string, kind: PickerKind): Promise<void> {
  resetPicker();
  picker = { personaId, kind, query: "", people: [], channels: [], searching: false, searched: false, error: "" };
  const shown = appState.mainEl?.firstElementChild;
  if (shown instanceof HTMLElement && shown.dataset.persona === personaId) redrawDetail();
  else await openPersona(personaId);
  focusPicker();
}

async function searchGrantees(): Promise<void> {
  const current = picker;
  if (!current) return;
  clearTimeout(pickerTimer);
  const seq = ++pickerSeq;
  const term = current.query.trim();
  Object.assign(current, { searching: Boolean(term), searched: false, error: "" });
  if (!term) Object.assign(current, { people: [], channels: [] });
  redrawDetail();
  if (!term) return;
  const q = encodeURIComponent(term);
  try {
    const found =
      current.kind === "people"
        ? { people: (await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${q}`)).matches ?? [] }
        : { channels: (await api<{ channels?: ChannelMatch[] }>(`/api/directory/channels?q=${q}`)).channels ?? [] };
    if (seq !== pickerSeq) return;
    Object.assign(current, found, { searched: true });
  } catch (e) {
    if (seq !== pickerSeq) return;
    current.error = errMessage(e, "Couldn't search.");
  }
  current.searching = false;
  redrawDetail();
}

function granteePickerTpl(persona: PersonaDetail, kind: PickerKind): TemplateResult | typeof nothing {
  const current = picker;
  if (current?.personaId !== persona.id || current.kind !== kind || !canSharePersona(persona.role)) return nothing;
  const granted = new Set(persona.access.map((grant) => grant.scopeId));
  const people = current.people.filter((person) => !granted.has(`personal:${person.principalId}`));
  const channels = current.channels.filter((channel) => !granted.has(channel.scopeId));
  const orgScope = `org:${appState.me?.org ?? ""}`;
  const saving = busyId !== null;
  let status = current.error;
  if (current.searching) status = "Searching…";
  else if (!status && current.searched && !people.length && !channels.length)
    status = kind === "people" ? "No one else matches that." : "No other channels you're in match that.";
  return html`<form
    class="project-member-picker persona-grantee-picker"
    @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      void searchGrantees();
    }}
  >
    <label for="persona-grantee-search">${kind === "people" ? "Add people" : "Add a Slack channel"}</label>
    <div class="project-member-search-row">
      ${icon(Search, 16)}
      <input
        id="persona-grantee-search"
        name="query"
        type="search"
        autocomplete="off"
        placeholder=${kind === "people" ? "Search by name or handle" : "Search channels you're in"}
        .value=${live(current.query)}
        ?disabled=${saving}
        @input=${(e: Event) => {
          current.query = (e.currentTarget as HTMLInputElement).value;
          clearTimeout(pickerTimer);
          pickerSeq++;
          pickerTimer = setTimeout(() => void searchGrantees(), 200);
        }}
      />
      <button
        class="project-icon-button"
        type="button"
        aria-label="Close"
        ${tip("Close")}
        @click=${() => {
          resetPicker();
          redrawDetail();
        }}
      >
        ${icon(X, 15)}
      </button>
    </div>
    ${
      kind === "people"
        ? peopleResults(
            people,
            saving,
            (person) => void addGrantee(persona, `personal:${person.principalId}`, person.displayName),
          )
        : html`<div class="project-member-results">
            ${channels.map(
              (channel) =>
                html`<button
                  class="project-member-result"
                  type="button"
                  ?disabled=${saving}
                  @click=${() => void addGrantee(persona, channel.scopeId, `#${channel.name}`)}
                >
                  <span class="persona-channel-glyph">${icon(channel.isPrivate ? Lock : Hash, 15)}</span>
                  <span class="project-member-name" dir="auto">${channel.name}</span>${icon(Plus, 15)}
                </button>`,
            )}
          </div>`
    }
    <div class=${`project-member-status${current.error ? " error" : ""}`} aria-live="polite">${status}</div>
    ${
      kind === "people" && !granted.has(orgScope)
        ? html`<button
            class="btn persona-share-org"
            type="button"
            ?disabled=${saving}
            @click=${() => void addGrantee(persona, orgScope, granteeLabel(orgScope))}
          >
            ${icon(Building2, 15)}<span>Add everyone at ${orgName()}</span>
          </button>`
        : nothing
    }
  </form>`;
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
  const host = paneHost(persona.id);
  if (!host) return;
  syncPersonaUrl(persona.id);
  actionError = "";
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
        <div class="persona-role hint">
          Your role: ${ROLE_LABELS[persona.role]}${persona.version ? ` · version ${persona.version}` : ""}
        </div>
        ${flash ? html`<div class="action-notice" role="status">${flash}</div>` : nothing}
        ${actionError ? html`<div class="form-error persona-action-error" role="alert">${actionError}</div>` : nothing}
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
        ${personaFactsTpl(persona, (message) => void openPersona(persona.id, message), draw)}
      </div>`,
      host,
    );
  redrawDetail = draw;
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
