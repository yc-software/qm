import { html, nothing, render } from "lit";
import { copyText, relTime } from "../ui.ts";
import { formatMessageTime } from "../message-time.ts";
import type { AdminPage } from "./sections.ts";
import { pageHeader, table, card, badge, subline, matches } from "./shared.ts";
import { keychain } from "./keychain.ts";
import { detail, labelRole, userHref } from "./user-detail.ts";

const failure = (r: any, fallback: string) =>
  r.status === 403 ? "You don't administer this scope." : r.data?.message || `${fallback} (${r.status}).`;

export async function mount(page: AdminPage) {
  if (page.view === "user") return detail(page);
  const r = await page.api("GET", page.view === "keychain" ? "/api/keychain" : "/api/users");
  if (!page.current()) return;
  if (!r.ok) return render(html`<p class="empty">${failure(r, "Failed to load")}</p>`, page.host);
  if (page.view === "keychain") return keychain(page, r.data || {});
  users(page, r.data || {});
}

function users(page: AdminPage, initial: any) {
  let data = initial;
  let filter = "";
  let showOffboarded = false;
  let [email, role, message, inviteLink, inviteWarning] = ["", "member", "", "", ""];
  let busy = false;
  const confirmGrant = (id: string, targetRole: string) =>
    window.confirm(
      targetRole === "owner"
        ? "Make " + id + " an org owner?\n\nThey will be able to manage organization settings and members."
        : "Make " + id + " an org admin?\n\nThey will be able to manage users, permissions, and organization settings.",
    );
  async function act(work: () => Promise<any>, fallback: string, done?: (r: any) => void) {
    if (busy) return;
    [busy, message] = [true, ""];
    draw();
    const r = await work();
    if (r.ok) {
      done?.(r);
      const fresh = await page.api("GET", "/api/users");
      if (fresh.ok) data = fresh.data;
    } else message = failure(r, fallback);
    busy = false;
    if (page.current()) draw();
  }
  const grantRole = page.fullAdmin ? "org_admin" : "owner";
  const admin = (u: any) => {
    const revoke = u.admin?.isAdmin;
    const revokeLabel = u.admin?.role === "owner" ? "owner" : "admin";
    if (
      !(revoke
        ? window.confirm(`Revoke ${revokeLabel} access for ${u.principalId}?`)
        : confirmGrant(u.principalId, grantRole))
    )
      return;
    void act(
      () =>
        revoke
          ? page.api(
              "DELETE",
              `/api/grants/${encodeURIComponent(u.principalId)}?scope=${encodeURIComponent(u.admin.scopeId)}&role=${encodeURIComponent(u.admin.role)}`,
            )
          : page.api("POST", "/api/grants", { principalId: u.principalId, role: grantRole, scopeId: page.orgScope }),
      "Could not update admin access",
    );
  };
  const removeMember = (u: any) => {
    if (
      !window.confirm(
        `Remove ${u.principalId} from this instance? Their access will be revoked and they will be signed out.`,
      )
    )
      return;
    void act(
      () => page.api("POST", `/api/users/${encodeURIComponent(u.principalId)}/offboard`, { apply: true }),
      "Remove failed",
    );
  };
  const reactivateMember = (u: any) => {
    if (!window.confirm(`Turn sign-in back on for ${u.principalId}?`)) return;
    void act(() => page.api("POST", `/api/users/${encodeURIComponent(u.principalId)}/reactivate`), "Reactivate failed");
  };
  const revokeExternal = (m: any) => {
    const question =
      m.status === "active"
        ? 'Revoke access for "' + m.email + '"? They will no longer be able to sign in.'
        : 'Remove "' + m.email + '" from the list?';
    if (window.confirm(question))
      void act(() => page.api("DELETE", "/api/external-users/" + encodeURIComponent(m.email)), "Revoke failed");
  };
  const invite = (event: Event) => {
    event.preventDefault();
    const body = { email: email.trim(), role };
    if ((body.role === "org_admin" || body.role === "owner") && !confirmGrant(body.email, body.role)) return;
    [inviteLink, inviteWarning] = ["", ""];
    void act(
      () => page.api("POST", "/api/users/invite", body),
      "Invite failed",
      (r) => {
        email = "";
        message = r.data.emailSent ? "Invite sent to " + r.data.member.email : "Added " + r.data.member.email + ".";
        if (r.data.emailSent || !r.data.signInUrl) return;
        inviteLink = r.data.signInUrl;
        inviteWarning =
          data.inviteEmail?.configured === false
            ? "You'll need to configure RESEND_API_KEY to send magic link emails. Otherwise, share the link directly:"
            : "Email couldn't be sent. Share the invite link directly.";
      },
    );
  };
  function draw() {
    const offboarded = (data.users || []).filter((u: any) => u.offboarded).length;
    const roster = (data.users || []).filter(
      (u: any) =>
        (showOffboarded || !u.offboarded) &&
        matches(
          filter,
          ...(u.aliases?.length ? u.aliases : [u.principalId]),
          u.displayName || "",
          u.admin?.role || "",
          u.admin?.scopeId || "member",
          u.kind === "app" ? "app" : "",
        ),
    );
    const hidden = showOffboarded ? 0 : offboarded;
    const admins = (data.grants || []).filter((g: any) => g.role === "org_admin").length;
    const owners = (data.grants || []).filter((g: any) => g.role === "owner").length;
    const makeLabel = page.fullAdmin ? "Make admin" : "Make owner";
    const lastGovernor = (u: any) =>
      (u.admin?.role === "org_admin" && admins <= 1) || (u.admin?.role === "owner" && admins === 0 && owners <= 1);
    const lastGovernorTitle = (u: any) => {
      if (!lastGovernor(u)) return "";
      return u.admin?.role === "owner" ? "The last owner cannot be revoked." : "The last admin cannot be revoked.";
    };
    const ownerRowAction = (u: any) => {
      if (u.admin?.role === "org_admin") return "";
      if (u.offboarded || u.deactivated) {
        if (u.kind === "app") return "";
        return {
          node: html`<button
            type="button"
            class="btn compact rowbtn"
            ?disabled=${busy}
            @click=${() => reactivateMember(u)}
          >
            Reactivate
          </button>`,
        };
      }
      const roleBtn = html`<button
        type="button"
        class=${"btn compact rowbtn" + (u.admin?.isAdmin ? " danger" : "")}
        ?disabled=${busy || lastGovernor(u)}
        title=${lastGovernorTitle(u)}
        @click=${() => admin(u)}
      >
        ${u.admin?.isAdmin ? "Revoke" : makeLabel}
      </button>`;
      const removeBtn =
        u.kind === "app"
          ? nothing
          : html`<button
              type="button"
              class="btn compact rowbtn danger"
              ?disabled=${busy || lastGovernor(u)}
              title=${lastGovernor(u) ? "The last owner cannot be removed." : ""}
              @click=${() => removeMember(u)}
            >
              Remove
            </button>`;
      return { node: html`${roleBtn}${removeBtn}` };
    };
    render(
      html`${pageHeader({
          count: `${roster.length} users · ${admins} admins${owners ? ` · ${owners} owners` : ""}${hidden ? ` · ${hidden} offboarded hidden` : ""}`,
          actions: offboarded
            ? html`<button class="btn" type="button" @click=${() => ((showOffboarded = !showOffboarded), draw())}>
                ${showOffboarded ? "Hide offboarded" : `Show offboarded (${offboarded})`}
              </button>`
            : nothing,
          tabs: page.fullAdmin
            ? [
                { label: "Users", href: page.href("users"), active: true },
                { label: "Keychain", href: page.href("keychain") },
              ]
            : undefined,
          search: {
            value: filter,
            placeholder: "sign-in, role, scope, or app",
            onInput: (v) => ((filter = v), draw()),
          },
        })}
        <div class="list-root">
          ${card(
            "Users",
            "",
            html`<form class="grant-form" @submit=${invite}>
                <div class="f grow">
                  <label for="users-email">Email</label>
                  <input
                    id="users-email"
                    type="email"
                    required
                    placeholder="name@example.com"
                    .value=${email}
                    @input=${(e: Event) => (email = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div class="f">
                  <label for="users-role">Role</label>
                  <select
                    id="users-role"
                    .value=${role}
                    @change=${(e: Event) => (role = (e.target as HTMLSelectElement).value)}
                  >
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                    ${page.fullAdmin ? html`<option value="org_admin">Admin</option>` : nothing}
                  </select>
                </div>
                <button class="btn primary" ?disabled=${busy}>Send invite</button>
              </form>
              <p class="status" role="status">${message}</p>
              ${
                inviteLink
                  ? html`<p class="flag-warn">${inviteWarning}</p>
                      <button class="btn" type="button" @click=${() => copyText(inviteLink)}>Copy invite link</button>`
                  : ""
              }
              ${table(
                ["Principal", "Role", "Last seen", "Sessions", "Turns", ""],
                roster.map((u: any) => [
                  {
                    node: html`${
                      page.fullAdmin
                        ? html`<a href=${userHref(page, u)} title=${u.principalId}
                            >${u.displayName || html`<span class="mono">${u.principalId}</span>`}</a
                          >`
                        : html`<span title=${u.principalId}
                            >${u.displayName || html`<span class="mono">${u.principalId}</span>`}</span
                          >`
                    }
                    ${u.kind === "app" ? badge("app") : ""}
                    ${u.offboarded || u.deactivated ? badge(u.offboarded ? "offboarded" : "deactivated", "warn") : ""}
                    ${u.aliases?.length > 1 ? subline(u.aliases.filter((a: string) => a !== u.principalId).join(", ")) : ""}`,
                  },
                  { node: subline(u.admin?.isAdmin ? labelRole(u.admin.role) : "member") },
                  { text: u.lastSeenAt ? relTime(u.lastSeenAt) : "-", cls: "num" },
                  { text: String(u.sessionCount), cls: "num" },
                  { text: String(u.turnCount), cls: "num" },
                  page.fullAdmin
                    ? {
                        action: {
                          label: u.admin?.isAdmin ? "Revoke" : makeLabel,
                          danger: !!u.admin?.isAdmin,
                          disabled: busy || lastGovernor(u),
                          title: lastGovernorTitle(u),
                          run: () => admin(u),
                        },
                      }
                    : ownerRowAction(u),
                ]),
                "No users match.",
              )}`,
          )}
          ${card(
            "Invitations",
            "Access granted by email. Revoking ends access to this instance.",
            table(
              ["Email", "Role", "Expires", "Invited by", "Status", ""],
              (data.externalUsers || [])
                .filter((m: any) => matches(filter, m.email, m.role, m.invitedBy || "", m.status))
                .map((m: any) => [
                  { text: m.email, cls: "mono" },
                  { node: subline(labelRole(m.role)) },
                  m.expiresAt === null ? "No expiration" : formatMessageTime(m.expiresAt),
                  m.invitedBy || "-",
                  { node: badge(m.status === "active" ? "Active" : "Expired", m.status === "active" ? "ok" : "warn") },
                  (page.fullAdmin || m.role !== "org_admin") &&
                  (m.status === "active" || (m.kind !== "teammate" && Date.now() - m.expiresAt >= 86400000))
                    ? {
                        action: {
                          label: m.status === "active" ? "Revoke" : "Remove",
                          danger: m.status === "active",
                          disabled: busy,
                          run: () => revokeExternal(m),
                        },
                      }
                    : "",
                ]),
              "No invitations yet.",
            ),
          )}
        </div>`,
      page.host,
    );
  }
  draw();
}
