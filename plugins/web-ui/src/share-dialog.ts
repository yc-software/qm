import {
  generalAccessOf,
  isOrgScope,
  orgAccessNote,
  orgDisplayName,
  PUBLIC_ACCESS_NOTE,
  type GeneralAccess,
} from "../../chassis/src/app-access.ts";
import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { Building2, Check, ChevronDown, Copy, Globe, Link, Lock, Search, Users, X } from "lucide";
import { api, withBase } from "./core-bridge";
import { avatarTpl, closeFormMenus, menuSelect, toggleFormMenu } from "./ui";
import { icon } from "./icons";
import { ensureContexts, scopeChip } from "./contexts";
import { friendlyPrincipal } from "./app-view";
import { errMessage } from "../../chassis/src/errors";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { appState } from "./shell-state";

interface Grant {
  scope: string;
  permission: "read" | "write";
}

interface ShareState {
  share: { token: string; audience: "internal" | "external"; createdAt: number } | null;
}

const isOrgGrant = (grant: Grant): boolean => isOrgScope(grant.scope);

type Shareable =
  | { type: "session"; id: string }
  | { type: "deploy" | "cron" | "skill" | "file"; id: string; title: string; owner: string };

const NOUN = { deploy: "app", cron: "cron", skill: "skill", file: "file" };

const scopeOf = (match: DirectoryMatch): string =>
  match.type === "context" ? match.principalId : `personal:${match.principalId}`;

export async function openShare(
  target: Shareable,
  hooks: { onChange?: () => void; onClose?: () => void } = {},
): Promise<void> {
  if (target.type === "session") return openLinkShare(target.id);
  const { type, id, title, owner } = target;
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
      const response = await api<{ public?: boolean; grantees: Grant[]; invitation?: { emailProblem?: string } }>(
        endpoint,
        {
          method: "POST",
          body: JSON.stringify({ ...(email ? { email } : { scope }), access: value }),
        },
      );
      publicAccess = response.public === true;
      grantees = response.grantees;
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
    const response = await api<{ public?: boolean; grantees: Grant[] }>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
    publicAccess = response.public === true;
    grantees = response.grantees;
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
        .map((c) => ({ principalId: c.scopeId, displayName: c.name!, type: "context" }));
      matches = [...(response.matches ?? []), ...places]
        .filter((match) => scopeOf(match) !== owner && !grantees.some((grant) => grant.scope === scopeOf(match)))
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
    if (
      owner.toLowerCase() === `personal:${email}` ||
      grantees.some((g) => g.scope.toLowerCase() === `personal:${email}`)
    )
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
                                names.set(scopeOf(selected), selected.displayName);
                                void change(scopeOf(selected), selected.email ? "view" : access, selected.email);
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
                                    selected = { principalId: email, displayName: email, type: "guest", email };
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
            ${avatarTpl({ key: owner, name: owner.replace("personal:", "") })}<span class="permission-person-label"
              >${owner.startsWith("personal:") ? friendlyPrincipal(owner.slice(9)) : scopeChip(owner)}</span
            ><span class="permission-owner">Owner</span>
          </div>
          ${grantees.filter((grant) => generalAccess() !== "org" || !isOrgGrant(grant)).map((grant) => html`<div class="permission-row">${avatarTpl({ key: grant.scope, name: isOrgGrant(grant) ? orgName() : grant.scope.replace("personal:", "") })}<span class="permission-person-label">${isOrgGrant(grant) ? orgName() : (names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? grant.scope.slice(9) : scopeChip(grant.scope)))}${names.has(grant.scope) ? html`<small>${grant.scope.replace("personal:", "")}</small>` : nothing}</span>${permissionMenu(grant.permission === "write" ? "manage" : "view", `Access for ${grant.scope}`, (value) => void change(grant.scope, value), true)}</div>`)}
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
    }>(endpoint);
    publicAccess = response.public === true;
    externalSharing = response.externalSharing !== false;
    offers = response.offers;
    grantees = response.grantees;
    loaded = true;
  } catch (e) {
    error = errMessage(e, "Could not load permissions.");
  } finally {
    busy = false;
    if (dialog.isConnected) draw();
  }
}

async function openLinkShare(id: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog session-share-dialog";
  document.body.append(dialog);
  const chat = document.getElementById("main");
  const position = () => {
    const bounds = chat?.getBoundingClientRect();
    const left = Math.max(0, bounds?.left ?? 0);
    const right = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
    dialog.style.left = `${left}px`;
    dialog.style.right = `${window.innerWidth - right}px`;
    dialog.style.setProperty("--share-dialog-space", `${right - left}px`);
  };
  const resize = new ResizeObserver(position);
  if (chat) resize.observe(chat);
  window.addEventListener("resize", position);
  position();
  let state: ShareState = { share: null };
  let busy = false;
  let audience = "internal";
  let error = "";
  let copied = false;
  const endpoint = `/api/shares/session/${encodeURIComponent(id)}`;
  const close = () => {
    resize.disconnect();
    window.removeEventListener("resize", position);
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.querySelector(".form-menu-control.open")) return;
    event.preventDefault();
    event.stopPropagation();
    closeFormMenus();
    dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const change = async () => {
    busy = true;
    error = "";
    copied = false;
    draw();
    try {
      state = await api<ShareState>(endpoint, { method: "POST", body: JSON.stringify({ audience }) });
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not create share.";
    } finally {
      busy = false;
      draw();
    }
  };
  const draw = () => {
    const saveLabel = state.share ? "Create new link" : "Create link";
    const url = state.share
      ? new URL(withBase(`/share/${state.share.audience}/${state.share.token}`), location.origin).href
      : "";
    render(
      html`
        <div class="project-dialog-head">
          <div><h2 id="session-share-heading">Share conversation</h2></div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        <div class="share-access-row">
          <span class="share-access-icon">${icon(audience === "external" ? Globe : Users, 18)}</span>
          <div class="form-menu-control menu-control share-audience" data-drop="down">
            <button
              class="btn menu-button share-audience-button"
              type="button"
              aria-label="Who can view"
              aria-haspopup="menu"
              aria-expanded="false"
              ?disabled=${busy}
              @click=${toggleFormMenu}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const control = (event.currentTarget as HTMLElement).parentElement!;
                if (!control.classList.contains("open")) toggleFormMenu(event);
                const options = control.querySelectorAll<HTMLButtonElement>(".menu-option");
                options[event.key === "ArrowUp" ? options.length - 1 : 0]?.focus();
              }}
            >
              <span>${audience === "external" ? "Anyone with the link" : "Anyone in your organization"}</span
              >${icon(ChevronDown, 14)}
            </button>
            <div
              class="menu-popover share-audience-menu"
              role="menu"
              aria-label="Who can view"
              hidden
              @keydown=${(event: KeyboardEvent) => {
                const options = [
                  ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".menu-option"),
                ];
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  let next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                  if (event.key === "Home") next = 0;
                  if (event.key === "End") next = options.length - 1;
                  options[next]?.focus();
                }
              }}
            >
              ${(["internal", "external"] as const).map(
                (value) =>
                  html`<button
                    type="button"
                    role="menuitemradio"
                    aria-checked=${audience === value}
                    class=${`menu-option ${audience === value ? "active" : ""}`}
                    @click=${() => {
                      audience = value;
                      state = { share: null };
                      copied = false;
                      error = "";
                      closeFormMenus();
                      draw();
                      dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
                    }}
                  >
                    ${icon(value === "external" ? Globe : Users, 16)}<span class="menu-option-label"
                      >${value === "external" ? "Anyone with the link" : "Anyone in your organization"}</span
                    >${audience === value ? icon(Check, 15) : ""}
                  </button>`,
              )}
            </div>
          </div>
          <span class="share-access-label">Can view</span>
        </div>
        ${audience === "external" ? html`<p class="share-external-warning" role="status">⚠️ External. Double-check what you're sharing.</p>` : ""}
        ${
          state.share
            ? html`
                <div class="share-link-row project-name-field">
                  <input
                    aria-label="Share link"
                    readonly
                    .value=${url}
                    @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    class="btn primary"
                    type="button"
                    ?disabled=${busy}
                    @click=${async () => {
                      try {
                        await navigator.clipboard.writeText(url);
                        copied = true;
                      } catch {
                        error = "Could not copy. Select and copy the link above.";
                      }
                      draw();
                    }}
                  >
                    ${icon(copied ? Check : Copy, 14)}${copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              `
            : ""
        }
        <p class="share-privacy-note">
          Subsequent messages will not be visible unless you re-share.
          ${url ? html`<a class="as-link" href=${url} target="_blank" rel="noreferrer">Preview</a>` : ""}
        </p>
        ${error ? html`<div class="composer-error" role="alert">${error}</div>` : ""}
        <div class="project-dialog-actions actions">
          <button
            class=${state.share ? "btn" : "btn primary"}
            type="button"
            ?disabled=${busy}
            @click=${() => void change()}
          >
            ${!state.share ? icon(Link, 14) : ""}${busy ? "Loading…" : saveLabel}
          </button>
        </div>
      `,
      dialog,
    );
  };
  dialog.setAttribute("aria-labelledby", "session-share-heading");
  draw();
  dialog.showModal();
}
