import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Search, UserPlus, X } from "lucide";
import { api, forkSession, type CoreContext } from "./core-bridge";
import { contextsState, ensureContexts, projectFromResponse, upsertProject } from "./contexts";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { appState } from "./shell-state";
import { tip } from "./tooltip";
import { avatarTpl } from "./ui";

interface Member {
  principalId: string;
  displayName: string;
  avatarUrl?: string;
}

interface ChatRoom {
  context: CoreContext | null;
  members: Member[];
}

let contextsRequested = false;

function chatRoom(scopeId: string | null, redraw: () => void): ChatRoom | null {
  const me = appState.me;
  if (!me) return null;
  if (!scopeId || scopeId === me.personalScope) {
    return { context: null, members: [{ principalId: me.user, displayName: me.displayName || me.user }] };
  }
  const context = contextsState.list.find((c) => c.scopeId === scopeId);
  if (!context && !contextsRequested && !contextsState.loaded) {
    contextsRequested = true;
    void ensureContexts().then(redraw);
  }
  if (context?.project) return { context, members: context.project.members };
  if (context?.groupMembers?.length) return { context, members: context.groupMembers };
  return null;
}

function canAdd(room: ChatRoom, sessionId: string | null): boolean {
  if (room.context?.project) return room.context.project.ownerId === appState.me?.user;
  return !room.context && Boolean(sessionId);
}

export function membersButtonTpl(
  scopeId: string | null,
  chat: { sessionId: string | null; title: string },
  redraw: () => void,
): TemplateResult | typeof nothing {
  const room = chatRoom(scopeId, redraw);
  if (!room || (!room.context && !chat.sessionId)) return nothing;
  const count = room.members.length;
  const label = count === 1 ? "1 member" : `${count} members`;
  return html`<button
    class="members-button"
    type="button"
    aria-label=${`${label}. View members and add people`}
    aria-haspopup="dialog"
    ${tip("View members and add people")}
    @click=${() => openMembersDialog(scopeId, chat, redraw)}
  >
    <span class="group-avatar-stack">
      ${room.members
        .slice(0, 3)
        .map((m) => avatarTpl({ key: m.principalId, name: m.displayName, avatarUrl: m.avatarUrl }))}
    </span>
    <span class="members-count">${count}</span>
    ${count === 1 && canAdd(room, chat.sessionId) ? icon(UserPlus, 15) : nothing}
  </button>`;
}

function openMembersDialog(
  scopeId: string | null,
  chat: { sessionId: string | null; title: string },
  redraw: () => void,
): void {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog members-dialog";
  dialog.setAttribute("aria-labelledby", "members-heading");
  document.body.append(dialog);
  let adding = false;
  let query = "";
  let matches: DirectoryMatch[] = [];
  let picked: DirectoryMatch[] = [];
  let searching = false;
  let busy = false;
  let error = "";
  let searchSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  const search = async () => {
    const q = query.trim();
    const seq = ++searchSeq;
    if (q.length < 2) {
      matches = [];
      searching = false;
      draw();
      return;
    }
    searching = true;
    draw();
    try {
      const r = await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      matches = (r.matches ?? []).filter((m) => m.type === "internal");
      error = "";
    } catch (e) {
      if (seq !== searchSeq) return;
      error = errMessage(e, "Couldn't search for people.");
    } finally {
      if (seq === searchSeq) {
        searching = false;
        draw();
      }
    }
  };
  const resetSearch = () => {
    query = "";
    matches = [];
    searchSeq++;
  };
  const addMember = async (projectId: string, person: DirectoryMatch) => {
    const updated = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: "POST",
        body: JSON.stringify({ memberId: person.principalId }),
      }),
    );
    if (!updated) throw new Error("Core returned an invalid project");
    upsertProject(updated);
    return updated;
  };
  const addToProject = async (projectId: string, person: DirectoryMatch) => {
    busy = true;
    error = "";
    draw();
    try {
      await addMember(projectId, person);
      resetSearch();
      redraw();
    } catch (e) {
      error = errMessage(e, "Couldn't add that person.");
    } finally {
      busy = false;
      draw();
    }
  };
  const startSharedChat = async () => {
    if (!chat.sessionId || !picked.length) return;
    busy = true;
    error = "";
    draw();
    try {
      const project = projectFromResponse(
        await api("/api/projects", { method: "POST", body: JSON.stringify({ name: chat.title || "Shared chat" }) }),
      );
      if (!project) throw new Error("Core returned an invalid project");
      for (const person of picked) await addMember(project.id, person);
      const forked = await forkSession(chat.sessionId, undefined, undefined, project.id);
      close();
      const { openSession, refreshSessions } = await import("./sessions");
      void refreshSessions();
      await openSession(forked.session);
    } catch (e) {
      error = errMessage(e, "Couldn't start the shared chat.");
      busy = false;
      draw();
    }
  };
  const draw = () => {
    const room = chatRoom(scopeId, draw);
    if (!room) return close();
    const project = room.context?.project;
    const addable = canAdd(room, chat.sessionId);
    const present = new Set([...room.members, ...picked].map((m) => m.principalId));
    const fresh = matches.filter((m) => !present.has(m.principalId)).slice(0, 8);
    let sub = "Only you can see this chat.";
    if (project) sub = "Everyone here can see and join this project's chats.";
    else if (room.context) sub = "Members of this Slack conversation.";
    const pick = (person: DirectoryMatch) => {
      if (project) return void addToProject(project.id, person);
      picked = [...picked, person];
      resetSearch();
      draw();
      dialog.querySelector<HTMLInputElement>("#members-search")?.focus();
    };
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="members-heading" dir="auto">${project?.name || room.context?.name || chat.title || "This chat"}</h2>
            <p class="members-sub">${sub}</p>
          </div>
          <button class="project-icon-button" type="button" aria-label="Close" ${tip("Close")} @click=${close}>
            ${icon(X, 16)}
          </button>
        </div>
        ${
          adding
            ? html`<form
                class="members-add"
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  clearTimeout(timer);
                  void search();
                }}
              >
                <div class="project-member-search-row">
                  ${icon(Search, 16)}<input
                    id="members-search"
                    type="search"
                    aria-label="Add people"
                    placeholder="Search by name or handle"
                    autocomplete="off"
                    maxlength="80"
                    .value=${live(query)}
                    ?disabled=${busy}
                    @input=${(event: Event) => {
                      query = (event.currentTarget as HTMLInputElement).value;
                      clearTimeout(timer);
                      timer = setTimeout(() => void search(), 200);
                    }}
                  />
                </div>
                ${peopleResults(fresh, busy, pick)}
                ${searching ? html`<div class="project-member-status">Searching…</div>` : nothing}
              </form>`
            : nothing
        }
        ${
          picked.length
            ? html`<div class="members-picked">
                  ${picked.map(
                    (person) =>
                      html`<span class="members-chip">
                        ${avatarTpl({ key: person.principalId, name: person.displayName, avatarUrl: person.avatarUrl })}
                        <span dir="auto">${person.displayName}</span>
                        <button
                          class="chip-x"
                          type="button"
                          aria-label=${`Remove ${person.displayName}`}
                          ?disabled=${busy}
                          @click=${() => {
                            picked = picked.filter((p) => p.principalId !== person.principalId);
                            draw();
                          }}
                        >
                          ${icon(X, 12)}
                        </button>
                      </span>`,
                  )}
                </div>
                <p class="members-sub">
                  They'll get a copy of this chat in a new shared project. Your original stays private.
                </p>
                <div class="project-dialog-actions">
                  <button class="btn primary" type="button" ?disabled=${busy} @click=${() => void startSharedChat()}>
                    ${busy ? "Starting…" : "Start shared chat"}
                  </button>
                </div>`
            : nothing
        }
        <div class="project-member-list members-list">
          ${
            addable && !adding
              ? html`<button
                  class="project-member-row members-add-row"
                  type="button"
                  @click=${() => {
                    adding = true;
                    draw();
                    dialog.querySelector<HTMLInputElement>("#members-search")?.focus();
                  }}
                >
                  <span class="members-add-glyph">${icon(UserPlus, 18)}</span>
                  <span class="project-member-name">Add people</span>
                </button>`
              : nothing
          }
          ${room.members.map(
            (m) =>
              html`<div class="project-member-row">
                ${avatarTpl({ key: m.principalId, name: m.displayName, avatarUrl: m.avatarUrl })}
                <span class="project-member-name" dir="auto"
                  >${m.displayName}${m.principalId === appState.me?.user ? html` <span class="members-you">(you)</span>` : nothing}</span
                >
                ${project?.ownerId === m.principalId ? html`<span class="badge">Owner</span>` : nothing}
              </div>`,
          )}
        </div>
        ${error ? html`<div class="project-member-status error" aria-live="polite">${error}</div>` : nothing}
      `,
      dialog,
    );
  };
  draw();
  dialog.showModal();
}
