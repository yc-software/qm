import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import {
  Bot,
  Building2,
  GitFork,
  Hash,
  KeyRound,
  Lock,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide";
import "./bots.css";
import { api, ApiError, isSharedScopeId, type CoreSession, type ProjectIcon } from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { appState } from "./shell-state";
import { ensureContexts, personalScopeId, scopeGlyph, scopeTitle } from "./contexts";
import { openSession, renderList, replacePendingSession, sessionsState, sessionTitle, startNewChat } from "./sessions";
import { newChatDraftKey, saveDraft } from "./drafts";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { renderSidebarTop, switchView } from "./shell";
import { openProjectIconPicker, projectIconTpl } from "./project-icon";
import { contextModelSection, loadContextModel, resetContextModel } from "./context-model";
import { loadPersonaSlack, personaSlackSection, resetPersonaSlack } from "./persona-slack";
import { can } from "./shell-state";
import { rememberThreadPick } from "./composer";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { avatarTpl, menuSelect } from "./ui";
import { tip } from "./tooltip";
import { openSkillById, startSkillCreateIn } from "./skills";
import { cronTitle, openCronById } from "./crons";
import { cronScheduleSummary } from "./cron-format";
import { historySectionTpl } from "./persona-history";
import {
  BOT_STATE_LABELS,
  botAvatarTpl,
  botTintStyle,
  botStatus,
  botStatusText,
  botStatusTpl,
  compareBotStatus,
  elapsedLabel,
  nextRunLabel,
  type BotCron,
  type BotState,
  type BotStatus,
} from "./bot-presence";
import { relTime } from "./ui";

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
  crons?: BotCron[];
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
  pinned?: boolean;
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

function setPersonaList(list: PersonaView[]): void {
  personasState.list = list;
  renderSidebarTop();
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
  void openPersona(personaId, "", { edit: focusEditor }).then(() => {
    if (focusEditor) focusInstructions();
  });
}

function focusInstructions(): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>(".persona-form textarea[name=instructions]")?.focus(),
  );
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
    notice = errMessage(e, "Couldn't load bots.");
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
  rosterOrder = null;
  if (pending) await openPersona(pending);
  else drawPersonasPage();
}

function backToList(): void {
  rosterOrder = null;
  drawPersonasPage();
  void loadPersonas().then(() => {
    rosterOrder = null;
    if (pageHost?.isConnected) drawPersonasPage();
  });
}

function statusOf(persona: Pick<PersonaView, "id" | "crons">): BotStatus {
  return botStatus(persona.id, sessionsState.list, persona.crons);
}

const statusTextOf = (status: BotStatus) => botStatusText(status, sessionTitle, cronTitle);

const PRESENCE_REFRESH_TICKS = 8;
let presenceTimer: ReturnType<typeof setInterval> | undefined;
let presence: { key: () => string; last: string; redraw: () => void; refresh: () => Promise<void> } | null = null;
let presenceTicks = 0;
let presenceRefreshing = false;

function watchPresence(key: () => string, redraw: () => void, refresh: () => Promise<void>): void {
  presence = { key, last: key(), redraw, refresh };
  presenceTimer ??= setInterval(() => {
    const watched = presence;
    if (appState.currentView !== "personas" || !watched) {
      clearInterval(presenceTimer);
      presenceTimer = undefined;
      presence = null;
      return;
    }
    if (
      ++presenceTicks % PRESENCE_REFRESH_TICKS === 0 &&
      !presenceRefreshing &&
      document.visibilityState === "visible"
    ) {
      presenceRefreshing = true;
      void watched
        .refresh()
        .catch((e: unknown) => swallow("web-ui: refresh bot presence", e))
        .finally(() => {
          presenceRefreshing = false;
        });
    }
    const next = watched.key();
    if (next === watched.last) return;
    watched.last = next;
    watched.redraw();
  }, 1000);
}

function presenceKeyOf(personas: readonly Pick<PersonaView, "id" | "crons">[]): string {
  return personas
    .map((persona) => {
      const status = statusOf(persona);
      const text = statusTextOf(status);
      return [
        persona.id,
        status.state,
        text.lead,
        text.subject,
        text.time,
        status.recent.map((s) => s.id).join(","),
        status.note?.at ?? "",
      ].join("|");
    })
    .join("\n");
}

function drawPersonasPage(): void {
  if (appState.currentView !== "personas" || !appState.mainEl) return;
  viewSeq++;
  syncPersonaUrl(null);
  resetPicker();
  resetContextModel();
  if (!pageHost || pageHost.parentElement !== appState.mainEl) {
    pageHost = document.createElement("div");
    pageHost.className = "pane personas-page";
    appState.mainEl.replaceChildren(pageHost);
  }
  const term = query.trim().toLowerCase();
  const rank = rosterRank();
  const visible = personasState.list
    .filter((persona) => !term || `${persona.name} ${persona.description}`.toLowerCase().includes(term))
    .map((persona) => ({ persona, status: statusOf(persona) }))
    .sort((a, b) => (rank.get(a.persona.id) ?? Infinity) - (rank.get(b.persona.id) ?? Infinity));
  let empty = "No bots yet. Create one to give QM a reusable role you can chat with anywhere.";
  if (loading && !personasState.list.length) empty = "Loading bots…";
  else if (!personasState.enabled) empty = "Bots aren't turned on for you.";
  else if (term && personasState.list.length) empty = "No bots match your search.";
  const rows = notice ? [html`<div class="action-notice" role="alert">${notice}</div>`] : [];
  if (visible.length)
    rows.push(
      html`<div class="bot-grid">
        ${repeat(
          visible,
          ({ persona }) => persona.id,
          ({ persona, status }) => botCard(persona, status),
        )}
      </div>`,
    );
  render(
    listPageTpl({
      title: "Bots",
      ...(personasState.enabled
        ? {
            action: { label: "New bot", onClick: showNewPersonaForm },
            search: {
              value: query,
              placeholder: "Search bots",
              onInput: (value: string) => {
                query = value;
                drawPersonasPage();
              },
            },
          }
        : {}),
      filters: rosterSummary(personasState.list.map(statusOf)),
      rows,
      empty,
    }),
    pageHost,
  );
  watchPresence(() => presenceKeyOf(personasState.list), drawPersonasPage, loadPersonas);
}

let rosterOrder: string[] | null = null;
let rosterSettled = false;

function rosterRank(): Map<string, number> {
  const known = new Set(rosterOrder ?? []);
  if (!rosterOrder || !rosterSettled || personasState.list.some((persona) => !known.has(persona.id))) {
    rosterOrder = personasState.list
      .map((persona) => ({ persona, status: statusOf(persona) }))
      .sort((a, b) => compareBotStatus(a.status, b.status) || a.persona.name.localeCompare(b.persona.name))
      .map(({ persona }) => persona.id);
    rosterSettled = sessionsState.loaded;
  }
  return new Map(rosterOrder.map((id, index) => [id, index]));
}

function rosterSummary(statuses: readonly BotStatus[]): TemplateResult {
  const states: BotState[] = ["working", "waiting", "scheduled", "resting"];
  const counts = states
    .map((state) => ({ state, count: statuses.filter((status) => status.state === state).length }))
    .filter((entry) => entry.count);
  if (!counts.length) return html``;
  return html`<div class="bot-roster" aria-label="Bots by status">
    ${counts.map(
      ({ state, count }) =>
        html`<span class="bot-roster-item" data-state=${state}
          ><span class="bot-roster-dot" aria-hidden="true"></span
          ><b>${count}</b> ${BOT_STATE_LABELS[state].toLowerCase()}</span
        >`,
    )}
  </div>`;
}

function rowAction(label: string, glyph: Parameters<typeof icon>[0], run: () => void): TemplateResult {
  return html`<button class="btn persona-action" type="button" ?disabled=${busyId !== null} @click=${run}>
    ${icon(glyph, 14)}<span>${label}</span>
  </button>`;
}

function personaActions(persona: PersonaView): TemplateResult {
  return html`
    ${rowAction("Fork", GitFork, () => forkPersona(persona))}
    ${canSharePersona(persona.role) ? rowAction("Share", Share2, () => void openGranteePicker(persona.id, "people")) : nothing}
  `;
}

function noteTpl(note: NonNullable<BotStatus["note"]>): TemplateResult {
  return html`<blockquote class="bot-note" dir="auto">
    <span class="bot-note-text">${note.text}</span>
    <span class="bot-note-when">Last run ${relTime(note.at)}</span>
  </blockquote>`;
}

function botCard(persona: PersonaView, status: BotStatus): TemplateResult {
  return html`
    <article class="bot-card" data-state=${status.state} style=${botTintStyle(persona)}>
      <button
        class="bot-card-open"
        type="button"
        aria-label=${`Open ${persona.name}`}
        @click=${() => void openPersona(persona.id, "", { push: true })}
      ></button>
      <div class="bot-card-head">
        ${botAvatarTpl(persona, 48, status.state)}
        <div class="bot-card-identity">
          <span class="bot-card-name" dir="auto">${persona.name}</span>
          ${persona.role === "owner" ? nothing : html`<span class="bot-card-role">${ROLE_LABELS[persona.role]}</span>`}
        </div>
        <button
          class="btn bot-card-chat"
          type="button"
          ?disabled=${busyId !== null}
          @click=${() => void chatWithPersona(persona)}
        >
          ${icon(MessageSquare, 14)}<span>Chat</span>
        </button>
      </div>
      <p class="bot-card-description" dir="auto">${persona.description}</p>
      <div class="bot-card-foot">
        ${botStatusTpl(statusTextOf(status), status.state, { stacked: true })}
        ${status.note ? noteTpl(status.note) : nothing}
      </div>
    </article>
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
  const { persona } = await api<{ persona: { sessionModelId?: string } | null }>(
    `/api/sessions/${encodeURIComponent(session.id)}/persona`,
    { method: "PUT", body: JSON.stringify({ personaId }) },
  );
  if (persona?.sessionModelId) rememberThreadPick(session.threadRef, persona.sessionModelId);
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
  saveDraft(newChatDraftKey(appState.me?.user), `Fork the ${persona.name} bot for me.`);
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

function syncPersonaUrl(personaId: string | null, push = false): void {
  if (appState.currentView !== "personas") return;
  const next = deepLinkPath(UI_BASE, "personas", null, null, personaId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

async function fetchPersona(id: string): Promise<PersonaDetail> {
  return (await api<{ persona: PersonaDetail }>(`/api/personas/${encodeURIComponent(id)}`)).persona;
}

async function openPersona(id: string, flash = "", opts: { push?: boolean; edit?: boolean } = {}): Promise<void> {
  const seq = ++viewSeq;
  try {
    const persona = await fetchPersona(id);
    if (seq !== viewSeq || appState.currentView !== "personas") return;
    showPersonaDetail(persona, flash, opts.push, opts.edit);
  } catch (e) {
    if (seq !== viewSeq) return;
    notice = errMessage(e, "Couldn't open that bot.");
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
  return scopeId;
}

const isMe = (grant: Pick<PersonaGrant, "scopeId">): boolean => grant.scopeId === `personal:${appState.me?.user ?? ""}`;

function grantLabel(grant: PersonaGrant): string {
  if (isMe(grant)) return "You";
  if (isSharedScopeId(grant.scopeId)) return scopeTitle(grant.scopeId, grant.label ?? null);
  return grant.label ?? granteeLabel(grant.scopeId);
}

const LAST_OWNER = "The only owner. Make someone else an owner before changing this.";

function flagOffNote(grant: PersonaGrant): string {
  return grant.scopeId.startsWith("personal:")
    ? "Can't use bots until an admin turns on the Bots feature flag for them in Admin → Customize → Feature flags."
    : "Bots is off for the organization, so only people with the flag on can use this. An admin can turn it on for everyone in Admin → Customize → Feature flags.";
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
  action: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`<div class="persona-item">
    ${glyph}
    <span class="persona-item-text">
      <span class="persona-skill-name" dir="auto">${name}</span>
      ${detail ? html`<span class="hint" dir="auto">${detail}</span>` : nothing}
    </span>
    ${action}
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
        () => void chatWithPrompt(persona, `Write a skill for the ${persona.name} bot that `),
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
  const channels = persona.access.filter((grant) => isSharedScopeId(grant.scopeId));
  const flagNotes = new Set(channels.filter((grant) => !grant.personasEnabled).map(flagOffNote));
  const flagNote = [...flagNotes].map((note) => html`<p class="permission-note">${note}</p>`);
  const list = channels.length
    ? html`<div class="persona-skill-list">
        ${channels.map((grant) =>
          removableRow(
            html`<span class="persona-channel-glyph"
              >${icon(scopeGlyph(grant.scopeId, grant.label ?? null), 14)}</span
            >`,
            grantLabel(grant),
            grant.pinned ? `Pinned: QM answers as ${persona.name} here` : "",
            owner ? `Remove ${grantLabel(grant)}` : null,
            () => void removeGrantee(persona, grant),
            owner
              ? html`<button
                  class="btn persona-action"
                  type="button"
                  ?disabled=${busyId !== null}
                  aria-pressed=${grant.pinned ? "true" : "false"}
                  @click=${() => void togglePin(persona, grant)}
                >
                  ${icon(Pin, 14)}<span>${grant.pinned ? "Unpin" : "Pin"}</span>
                </button>`
              : nothing,
          ),
        )}
      </div>`
    : emptyTpl("No channels or groups.");
  return sectionTpl(
    "Channels and groups",
    owner ? rowAction("Add channel", Plus, () => void openGranteePicker(persona.id, "channels")) : nothing,
    html`${list}${flagNote}${granteePickerTpl(persona, "channels")}`,
    `People in these channels and groups can ask QM to use ${persona.name} in a thread there; they can't edit ${persona.name}. Pin it in one to make every conversation there ${persona.name}; in Slack it posts under its name and icon. Pinned channels and groups share one memory: what QM remembers in one, it recalls wherever ${persona.name} is used.`,
  );
}

function accessSection(persona: PersonaDetail): TemplateResult {
  const owner = canSharePersona(persona.role);
  const people = persona.access.filter((grant) => !isSharedScopeId(grant.scopeId));
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
  change: (access: PersonaGrant[]) => Array<Pick<PersonaGrant, "scopeId" | "role" | "pinned">>,
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
      body: JSON.stringify({
        access: change(access).map(({ scopeId, role, pinned }) => ({ scopeId, role, ...(pinned ? { pinned } : {}) })),
      }),
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
    access.map((g) => (g.scopeId === grant.scopeId ? { ...g, role } : g)),
  );
  if (saved) await openPersona(persona.id, "Access saved.");
}

async function togglePin(persona: PersonaDetail, grant: PersonaGrant): Promise<void> {
  const label = grantLabel(grant);
  const pinned = !grant.pinned;
  const saved = await saveAccess(persona, (access) =>
    access.map((g) => (g.scopeId === grant.scopeId ? { ...g, pinned } : g)),
  );
  if (saved) await openPersona(persona.id, pinned ? `Pinned in ${label}.` : `Unpinned from ${label}.`);
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
  else await openPersona(personaId, "", { push: true });
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
      state.error = errMessage(err, "Couldn't save this bot.");
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
  const submitLabel = persona ? "Save" : "Create bot";
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
  presence = null;
  resetContextModel();
  resetPersonaSlack();
  const state: FormState = { icon: null, iconChanged: false, error: "", saving: false };
  const draw = () =>
    render(
      html`<div class="resource-detail persona-detail">
        ${listBackLink("Bots", backToList)}
        <h2>New bot</h2>
        ${personaFormTpl(null, state, draw)}
      </div>`,
      host,
    );
  draw();
  host.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

function activityRow(
  state: BotState | "chat",
  verb: string,
  title: string,
  when: string,
  open: () => void,
): TemplateResult {
  return html`<button class="bot-activity-row" type="button" data-state=${state} @click=${open}>
    <span class="bot-activity-mark" aria-hidden="true"></span>
    <span class="bot-activity-main" dir="auto"
      ><span class="bot-activity-verb">${verb}</span><span class="bot-activity-title">${title}</span></span
    >
    <span class="bot-activity-when">${when}</span>
  </button>`;
}

function statusTarget(status: BotStatus): (() => void) | null {
  const session = status.working[0] ?? status.waiting[0];
  if (session) return () => void openSession(session);
  const next = status.running[0] ?? status.upcoming[0];
  if (next) return () => openPersonaCron(next.cron.id);
  const last = status.recent[0];
  return last ? () => void openSession(last) : null;
}

function activitySection(persona: PersonaDetail, status: BotStatus): TemplateResult | typeof nothing {
  const now = Date.now();
  const open = (session: (typeof status.working)[number]) => () => void openSession(session);
  const headline = (state: BotState): number => (status.state === state ? 1 : 0);
  const rows = [
    ...status.upcoming
      .slice(headline("scheduled"), 4)
      .reverse()
      .map(({ cron, at }) =>
        activityRow("scheduled", "Up next", cronTitle(cron), nextRunLabel(at, cron, now), () =>
          openPersonaCron(cron.id),
        ),
      ),
    ...[
      ...status.working.map((session) => ({
        title: sessionTitle(session),
        since: session.workingSince ?? session.lastActivityAt ?? session.createdAt,
        open: open(session),
      })),
      ...status.running.map(({ cron, since }) => ({
        title: cronTitle(cron),
        since,
        open: () => openPersonaCron(cron.id),
      })),
    ]
      .slice(headline("working"))
      .map((job) => activityRow("working", "Now", job.title, elapsedLabel(job.since, now), job.open)),
    ...status.waiting
      .slice(headline("waiting"))
      .map((session) => activityRow("waiting", "Needs you", sessionTitle(session), "", open(session))),
    ...status.recent
      .filter((session) => !status.waiting.includes(session))
      .slice(0, 5)
      .map((session) =>
        activityRow(
          "chat",
          "Chat",
          sessionTitle(session),
          relTime(session.lastActivityAt ?? session.createdAt),
          open(session),
        ),
      ),
  ];
  if (!rows.length && (status.lastActiveAt || status.upcoming.length)) return nothing;
  return html`<section class="persona-section bot-activity" aria-label="Activity">
    <div class="persona-section-head"><h3>Activity</h3></div>
    ${
      rows.length
        ? html`<div class="bot-activity-list">${rows}</div>`
        : emptyTpl(`Nothing yet. Start a chat or set up a cron to put ${persona.name} to work.`)
    }
  </section>`;
}

function showPersonaDetail(persona: PersonaDetail, flash: string, push = false, edit = false): void {
  const host = paneHost(persona.id);
  if (!host) return;
  syncPersonaUrl(persona.id, push);
  actionError = "";
  const state: FormState = { icon: persona.icon ?? null, iconChanged: false, error: "", saving: false };
  const editable = canEditPersona(persona.role);
  const canManageSlack = persona.role === "owner" || can("admin") || can("owner");
  let editing = editable && (edit || !persona.instructions.trim());
  const profile = () =>
    editing
      ? html`<section class="persona-section bot-profile">
          <div class="persona-section-head">
            <h3>Edit bot</h3>
            <div class="persona-section-actions">
              ${rowAction("Cancel", X, () => {
                editing = false;
                Object.assign(state, { icon: persona.icon ?? null, iconChanged: false, error: "" });
                draw();
              })}
            </div>
          </div>
          ${personaFormTpl(persona, state, draw)}
        </section>`
      : html`<section class="persona-section bot-profile">
          <div class="persona-section-head">
            <h3>Instructions</h3>
            <div class="persona-section-actions">
              ${
                editable
                  ? rowAction("Edit", Pencil, () => {
                      editing = true;
                      draw();
                      focusInstructions();
                    })
                  : nothing
              }
            </div>
          </div>
          <div class="bot-instructions" dir="auto">${persona.instructions || "—"}</div>
        </section>`;
  const draw = (): void => {
    const status = statusOf(persona);
    render(
      html`<div class="resource-detail persona-detail bot-detail">
        ${listBackLink("Bots", backToList)}
        <header class="bot-hero" data-state=${status.state} style=${botTintStyle(persona)}>
          ${botAvatarTpl(persona, 84, status.state)}
          <div class="bot-hero-text">
            <div class="bot-hero-top">
              <h2 class="bot-hero-name" dir="auto">${persona.name}</h2>
              <span class="bot-hero-meta"
                >${ROLE_LABELS[persona.role]}${persona.version ? ` · v${persona.version}` : ""}</span
              >
            </div>
            ${persona.description ? html`<p class="bot-hero-description" dir="auto">${persona.description}</p>` : nothing}
            <div class="bot-hero-status">
              ${botStatusTpl(statusTextOf(status), status.state, { open: statusTarget(status) })}
            </div>
            ${status.note ? noteTpl(status.note) : nothing}
            <div class="bot-hero-actions">
              <button
                class="btn primary bot-hero-chat"
                type="button"
                ?disabled=${busyId !== null}
                @click=${() => void chatWithPersona(persona)}
              >
                ${icon(MessageSquare, 15)}<span>Chat</span>
              </button>
              ${personaActions(persona)}
            </div>
          </div>
        </header>
        ${flash ? html`<div class="action-notice" role="status">${flash}</div>` : nothing}
        ${actionError ? html`<div class="form-error persona-action-error" role="alert">${actionError}</div>` : nothing}
        ${activitySection(persona, status)} ${profile()}
        ${editable ? contextModelSection(`persona:${persona.id}`) : nothing}
        ${canManageSlack ? personaSlackSection(persona.id, draw) : nothing}
        ${personaFactsTpl(persona, (message) => void openPersona(persona.id, message), draw)}
        ${
          canSharePersona(persona.role)
            ? html`<div class="bot-danger">${rowAction("Delete bot", Trash2, () => void deletePersona(persona))}</div>`
            : nothing
        }
      </div>`,
      host,
    );
  };
  redrawDetail = draw;
  draw();
  watchPresence(
    () => presenceKeyOf([persona]),
    draw,
    async () => {
      persona.crons = (await fetchPersona(persona.id)).crons;
    },
  );
  if (editable) void loadContextModel(`persona:${persona.id}`, draw);
  else resetContextModel();
  if (canManageSlack) void loadPersonaSlack(persona.id, draw);
  else resetPersonaSlack();
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
  return personasState.list.find((p) => p.id === personaId)?.name ?? "Bot";
}

export function sessionPersonaChip(
  session: Pick<CoreSession, "id" | "personaId"> | null | undefined,
): TemplateResult | typeof nothing {
  const personaId = session?.personaId;
  if (!session?.id || !personaId) return nothing;
  const persona = personasState.list.find((p) => p.id === personaId);
  const name = personaName(personaId);
  return html`<span class="session-fork-badge session-persona-badge">
    <button
      class="session-persona-open"
      type="button"
      aria-label=${`View ${name}`}
      ${tip(`Chatting as ${name}. Open bot`)}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        viewPersona(personaId);
      }}
    >
      ${personaIconTpl(persona?.icon, 13)}<span dir="auto">${name}</span>
    </button>
  </span>`;
}
