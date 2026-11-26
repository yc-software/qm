import {
  generalAccessOf,
  isOrgScope,
  orgAccessNote,
  orgDisplayName,
  PUBLIC_ACCESS_NOTE,
  type GeneralAccess,
} from "../../chassis/src/app-access.ts";
import { html, render, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Building2, Globe, Lock, Search, Share2, X } from "lucide";
import { api } from "./core-bridge";
import { avatarTpl, closeFormMenus, menuSelect } from "./ui";
import { icon } from "./icons";
import { ensureContexts, scopeChip } from "./contexts";
import { friendlyPrincipal } from "./app-view";
import { rememberScopeLabels, scopePerson } from "./scope-labels";
import { errMessage } from "../../chassis/src/errors";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { appState } from "./shell-state";
import { COPY_STATUS } from "./cron-delivery";

interface Grant {
  scope: string;
  permission: "read" | "write";
  status?: "on" | "paused" | "edited";
}

const isOrgGrant = (grant: Grant): boolean => isOrgScope(grant.scope);

interface Shareable {
  type: "deploy" | "cron" | "skill" | "file";
  id: string;
  title: string;
  owner: string;
}

const NOUN = { deploy: "app", cron: "cron", skill: "skill", file: "file" };

export async function openShare(
  { type, id, title, owner }: Shareable,
  hooks: { onChange?: () => void; onClose?: () => void } = {},
): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog share-dialog";
  dialog.setAttribute("aria-labelledby", "share-heading");
  document.body.append(dialog);
  let grantees: Grant[] = [];
  let publicAccess = false;
  let externalSharing = true;
  let offers = { org: true, manage: true, email: true, public: true };
  let matches: DirectoryMatch[] = [];
  let query = "";
  let access = "view";
  let selected: (DirectoryMatch & { email?: string }) | null = null;
  let searchSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searching = false;
  const names = new Map<string, string>();
  const person = (scope: string): string => (scope.startsWith("personal:") ? scopePerson(scope) : scope);
  let busy = true;
  let loaded = false;
  let error = "";
  let searched = false;
  const endpoint = `/api/shares/${type}/${encodeURIComponent(id)}`;
  const close = () => {
    clearTimeout(timer);
    searchSequence++;
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
    hooks.onClose?.();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (closeFormMenus()) return;
    close();
  });
  const change = async (scope: string, value: string, email?: string) => {
    if (busy) return;
    closeFormMenus();
    busy = true;
    error = "";
    draw();
    try {
      const response = await api<{
        public?: boolean;
        grantees: Grant[];
        labels?: Record<string, string>;
        target?: { scope: string };
        invitation?: { emailProblem?: string };
      }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ ...(email ? { email } : { scope }), access: value }),
      });
      publicAccess = response.public === true;
      grantees = response.grantees;
      rememberScopeLabels(response.labels);
      const named = names.get(scope);
      if (named && response.target) names.set(response.target.scope, named);
      hooks.onChange?.();
      if (response.invitation?.emailProblem)
        error = `Access granted, but no invitation email was sent: ${response.invitation.emailProblem}`;
      selected = null;
      query = "";
      searched = false;
      searchSequence++;
      matches = [];
    } catch (e) {
      error = errMessage(e, "Could not update permissions.");
    } finally {
      busy = false;
      if (dialog.isConnected) draw();
    }
  };
  const orgGrant = (): Grant | undefined => grantees.find(isOrgGrant);
  const generalAccess = (): GeneralAccess => generalAccessOf({ public: publicAccess, grantees });
  const post = async (body: Record<string, unknown>) => {
    const response = await api<{ public?: boolean; grantees: Grant[]; labels?: Record<string, string> }>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
    publicAccess = response.public === true;
    grantees = response.grantees;
    rememberScopeLabels(response.labels);
    hooks.onChange?.();
  };
  const changeGeneral = async (next: GeneralAccess) => {
    if (busy || next === generalAccess() || (next === "public" && !externalSharing)) return;
    closeFormMenus();
    busy = true;
    error = "";
    draw();
    try {
      if (next === "public") await post({ public: true });
      else {
        if (publicAccess) await post({ public: false });
        const grant = orgGrant();
        if (next === "org" && !grant) await post({ scope: "org", access: "view" });
        if (next === "restricted" && grant) await post({ scope: grant.scope, access: "none" });
      }
    } catch (e) {
      error = errMessage(e, "Could not update general access.");
    } finally {
      busy = false;
      if (dialog.isConnected) draw();
    }
  };
  const search = async () => {
    const sequence = ++searchSequence;
    const term = query.trim();
    if (!term) {
      matches = [];
      searched = false;
      searching = false;
      draw();
      return;
    }
    searching = true;
    error = "";
    draw();
    try {
      const [response, contexts] = await Promise.all([
        api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(term)}`),
        ensureContexts(),
      ]);
      if (sequence !== searchSequence || !dialog.isConnected) return;
      const places = contexts
        .filter((c) => c.kind !== "personal" && c.name?.toLowerCase().includes(term.toLowerCase()))
        .map((c) => ({ principalId: c.scopeId, scopeId: c.scopeId, displayName: c.name!, type: "context" }));
      matches = [...(response.matches ?? []), ...places]
        .filter((match) => match.scopeId !== owner && !grantees.some((grant) => grant.scope === match.scopeId))
        .slice(0, 8);
      searched = true;
    } catch (e) {
      if (sequence === searchSequence) error = errMessage(e, "Could not find people.");
    } finally {
      if (sequence === searchSequence && dialog.isConnected) {
        searching = false;
        draw();
      }
    }
  };
  const orgName = (): string => orgDisplayName(appState.me?.companyName);
  const generalAccessNote = (): string => {
    const level = generalAccess();
    if (level === "public") return `${PUBLIC_ACCESS_NOTE}. No sign-in required`;
    if (level === "org") return orgAccessNote(appState.me?.companyName);
    return "Only people with access can open";
  };
  const emailCandidate = (): string | null => {
    const email = query.trim().toLowerCase();
    if (!externalSharing || !offers.email) return null;
    if (email.length > 254 || !/^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(email)) return null;
    if (person(owner).toLowerCase() === email || grantees.some((g) => person(g.scope).toLowerCase() === email))
      return null;
    if (matches.some((m) => m.principalId.toLowerCase() === email)) return null;
    return email;
  };
  const permissionMenu = (value: string, label: string, update: (value: string) => void, removable = false) =>
    html`<fieldset class="permission-control" ?disabled=${busy}>
      ${menuSelect({
        value,
        ariaLabel: label,
        options: [
          { value: "view", label: "Can view" },
          ...(offers.manage ? [{ value: "manage", label: "Can manage" }] : []),
          ...(removable ? [{ value: "none", label: "Remove access" }] : []),
        ],
        onSelect: (next) => {
          if (next) update(next);
        },
      })}
    </fieldset>`;
  const draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="share-heading">Share ${NOUN[type]}</h2>
            <p>${title}</p>
          </div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        ${
          loaded
            ? html` <div class="permission-search">
                ${
                  selected
                    ? html`<div class="permission-invite">
                        <div class="permission-person">
                          ${avatarTpl({
                            key: selected.principalId,
                            name: selected.displayName,
                            avatarUrl: selected.avatarUrl,
                          })}<span class="permission-person-label"
                            >${selected.displayName}<small>${selected.principalId}</small></span
                          >
                        </div>
                        <button
                          class="chip-x"
                          aria-label="Cancel selection"
                          ?disabled=${busy}
                          @click=${() => {
                            selected = null;
                            draw();
                          }}
                        >
                          ${icon(X, 14)}
                        </button>
                        <div class="permission-invite-actions">
                          ${
                            selected.email
                              ? html`<span class="permission-note">Can view</span>`
                              : permissionMenu(access, "New person's access", (value) => {
                                  access = value;
                                  draw();
                                })
                          }<button
                            class="btn primary"
                            ?disabled=${busy}
                            @click=${() => {
                              if (selected) {
                                names.set(selected.scopeId, selected.displayName);
                                void change(selected.scopeId, selected.email ? "view" : access, selected.email);
                              }
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>`
                    : html`<form
                        @submit=${(event: SubmitEvent) => {
                          event.preventDefault();
                          clearTimeout(timer);
                          void search();
                        }}
                      >
                        <div class="project-member-search-row">
                          ${icon(Search, 16)}<input
                            id="app-people-query"
                            aria-label="Add people"
                            placeholder=${offers.email ? "Add people or channels by name or email" : "Add people or channels by name"}
                            type="search"
                            autocomplete="off"
                            maxlength="254"
                            .value=${live(query)}
                            ?disabled=${busy}
                            @input=${(event: Event) => {
                              query = (event.currentTarget as HTMLInputElement).value;
                              searchSequence++;
                              matches = [];
                              searched = false;
                              clearTimeout(timer);
                              timer = setTimeout(() => void search(), 200);
                            }}
                          />
                        </div>
                        ${peopleResults(matches, busy, (person) => {
                          selected = person;
                          closeFormMenus();
                          draw();
                        })}
                        ${
                          !searching && searched && emailCandidate()
                            ? html`
                                <button
                                  class="project-member-result"
                                  type="button"
                                  ?disabled=${busy}
                                  @click=${() => {
                                    const email = emailCandidate();
                                    if (!email) return;
                                    selected = {
                                      principalId: email,
                                      scopeId: email,
                                      displayName: email,
                                      type: "guest",
                                      email,
                                    };
                                    access = "view";
                                    closeFormMenus();
                                    draw();
                                  }}
                                >
                                  Add ${emailCandidate()} with view access
                                </button>
                                <p class="permission-note">
                                  They receive an app link by email and sign in with this address. This does not add
                                  them to your organization.
                                </p>
                              `
                            : nothing
                        }
                        ${searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
                        ${!searching && searched && !matches.length && !emailCandidate() ? html`<p class="permission-note">No additional people found.</p>` : nothing}
                      </form>`
                }
              </div>`
            : nothing
        }
        <div class="permission-section-label">People with access</div>
        <div class="project-member-list">
          <div class="permission-row">
            ${avatarTpl({ key: owner, name: person(owner) })}<span class="permission-person-label"
              >${owner.startsWith("personal:") ? friendlyPrincipal(person(owner)) : scopeChip(owner)}</span
            ><span class="permission-owner">Owner</span>
          </div>
          ${grantees.filter((grant) => generalAccess() !== "org" || !isOrgGrant(grant)).map((grant) => html`<div class="permission-row">${avatarTpl({ key: grant.scope, name: isOrgGrant(grant) ? orgName() : person(grant.scope) })}<span class="permission-person-label">${isOrgGrant(grant) ? orgName() : (names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? person(grant.scope) : scopeChip(grant.scope)))}${names.has(grant.scope) ? html`<small>${person(grant.scope)}</small>` : nothing}</span>${grant.status ? html`<span class="badge">${COPY_STATUS[grant.status].label}</span>` : nothing}${permissionMenu(grant.permission === "write" ? "manage" : "view", `Access for ${grant.scope}`, (value) => void change(grant.scope, value), true)}</div>`)}
        </div>
        ${
          offers.org
            ? html`<div class="permission-section-label permission-general-label">General access</div>
                <div class="project-member-list">
                  <div class="permission-row">
                    <span class="project-member-avatar" aria-hidden="true"
                      >${icon({ public: Globe, org: Building2, restricted: Lock }[generalAccess()], 16)}</span
                    >
                    <span class="permission-person-label">
                      <fieldset class="permission-control general-access-control" ?disabled=${busy}>
                        ${menuSelect({
                          value: generalAccess(),
                          ariaLabel: "General access",
                          className: "general-access-menu",
                          options: [
                            { value: "restricted", label: "Restricted" },
                            { value: "org", label: orgName() },
                            ...(offers.public
                              ? [
                                  {
                                    value: "public",
                                    label: "Anyone with the link",
                                    ...(externalSharing
                                      ? {}
                                      : { disabledHint: "An org admin must turn on external app sharing first." }),
                                  },
                                ]
                              : []),
                          ],
                          onSelect: (next) => {
                            if (next === "restricted" || next === "org" || next === "public") void changeGeneral(next);
                          },
                        })}
                      </fieldset>
                      <small>${generalAccessNote()}</small>
                    </span>
                    ${(() => {
                      const grant = generalAccess() === "org" ? orgGrant() : undefined;
                      return grant
                        ? permissionMenu(
                            grant.permission === "write" ? "manage" : "view",
                            `Access for ${orgName()}`,
                            (value) => void change(grant.scope, value),
                          )
                        : nothing;
                    })()}
                  </div>
                </div>`
            : nothing
        }
        ${
          publicAccess
            ? html`<p class="share-external-warning" role="status">⚠️ Public. Anyone can open this app.</p>`
            : nothing
        }
        ${busy ? html`<p role="status">Loading…</p>` : nothing}
        ${error ? html`<p class="composer-error" role="alert">${error}</p>` : nothing}
        <div class="project-dialog-actions actions"><button class="btn" @click=${close}>Done</button></div>
      `,
      dialog,
    );
  draw();
  dialog.showModal();
  try {
    const response = await api<{
      public?: boolean;
      externalSharing?: boolean;
      offers: typeof offers;
      grantees: Grant[];
      labels?: Record<string, string>;
    }>(endpoint);
    publicAccess = response.public === true;
    externalSharing = response.externalSharing !== false;
    offers = response.offers;
    grantees = response.grantees;
    rememberScopeLabels(response.labels);
    loaded = true;
  } catch (e) {
    error = errMessage(e, "Could not load permissions.");
  } finally {
    busy = false;
    if (dialog.isConnected) draw();
  }
}

export const shareButton = (target: Shareable): TemplateResult =>
  html`<button class="btn" type="button" @click=${() => void openShare(target)}>
    ${icon(Share2, 15)}<span>Share</span>
  </button>`;
