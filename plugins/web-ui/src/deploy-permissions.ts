import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { Search, X } from "lucide";
import { api } from "./core-bridge";
import { closeFormMenus, icon, initials, menuSelect } from "./ui";
import { scopeChip } from "./contexts";
import { friendlyPrincipal } from "./deploy-view";
import { errMessage } from "../../chassis/src/errors";
import { peopleResults, type DirectoryMatch } from "./people-results";

interface Grant {
  scope: string;
  permission: "read" | "write";
}

export async function openDeploymentPermissions(id: string, title: string, owner: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog deployment-permissions-dialog";
  dialog.setAttribute("aria-labelledby", "deployment-permissions-heading");
  document.body.append(dialog);
  let grantees: Grant[] = [];
  let matches: DirectoryMatch[] = [];
  let query = "";
  let access = "view";
  let selected: DirectoryMatch | null = null;
  let searchSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searching = false;
  const names = new Map<string, string>();
  let busy = true;
  let loaded = false;
  let error = "";
  let searched = false;
  const endpoint = `/api/deployments/${encodeURIComponent(id)}/share`;
  const close = () => {
    clearTimeout(timer);
    searchSequence++;
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
  const change = async (scope: string, value: string) => {
    if (busy) return;
    closeFormMenus();
    busy = true;
    error = "";
    draw();
    try {
      const response = await api<{ grantees: Grant[] }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ scope, access: value }),
      });
      grantees = response.grantees;
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
      const response = await api<{ matches?: DirectoryMatch[] }>(
        `/api/directory/resolve?q=${encodeURIComponent(term)}`,
      );
      if (sequence !== searchSequence || !dialog.isConnected) return;
      matches = (response.matches ?? [])
        .filter(
          (person) =>
            `personal:${person.principalId}` !== owner &&
            !grantees.some((grant) => grant.scope === `personal:${person.principalId}`),
        )
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
  const permissionMenu = (value: string, label: string, update: (value: string) => void, removable = false) =>
    html`<fieldset class="permission-control" ?disabled=${busy}>
      ${menuSelect({
        value,
        ariaLabel: label,
        options: [
          { value: "view", label: "Can view" },
          { value: "manage", label: "Can manage" },
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
            <h2 id="deployment-permissions-heading">App permissions</h2>
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
                          <span class="project-member-avatar">${initials(selected.displayName)}</span
                          ><span class="permission-person-label"
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
                          ${permissionMenu(access, "New person's access", (value) => {
                            access = value;
                            draw();
                          })}<button
                            class="btn primary"
                            ?disabled=${busy}
                            @click=${() => {
                              if (selected) {
                                names.set(`personal:${selected.principalId}`, selected.displayName);
                                void change(`personal:${selected.principalId}`, access);
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
                            placeholder="Add people by name or handle"
                            type="search"
                            autocomplete="off"
                            maxlength="80"
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
                        ${searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
                        ${!searching && searched && !matches.length ? html`<p class="permission-note">No additional people found.</p>` : nothing}
                      </form>`
                }
              </div>`
            : nothing
        }
        <div class="permission-section-label">People with access</div>
        <div class="project-member-list">
          <div class="permission-row">
            <span class="project-member-avatar" aria-hidden="true">${initials(owner.replace("personal:", ""))}</span
            ><span class="permission-person-label"
              >${owner.startsWith("personal:") ? friendlyPrincipal(owner.slice(9)) : scopeChip(owner)}</span
            ><span class="permission-owner">Owner</span>
          </div>
          ${grantees.map((grant) => html`<div class="permission-row"><span class="project-member-avatar" aria-hidden="true">${initials(grant.scope.replace("personal:", ""))}</span><span class="permission-person-label">${names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? grant.scope.slice(9) : scopeChip(grant.scope))}${names.has(grant.scope) ? html`<small>${grant.scope.replace("personal:", "")}</small>` : nothing}</span>${permissionMenu(grant.permission === "write" ? "manage" : "view", `Access for ${grant.scope}`, (value) => void change(grant.scope, value), true)}</div>`)}
        </div>
        ${busy ? html`<p role="status">Loading…</p>` : nothing}
        ${error ? html`<p class="composer-error" role="alert">${error}</p>` : nothing}
        <div class="project-dialog-actions actions"><button class="btn" @click=${close}>Done</button></div>
      `,
      dialog,
    );
  draw();
  dialog.showModal();
  try {
    grantees = (await api<{ grantees: Grant[] }>(endpoint)).grantees;
    loaded = true;
  } catch (e) {
    error = errMessage(e, "Could not load permissions.");
  } finally {
    busy = false;
    if (dialog.isConnected) draw();
  }
}
