import { html, render } from "lit";
import { copyText, relTime } from "../ui.ts";
import { formatMessageTime } from "../message-time.ts";
import type { AdminPage } from "./sections.ts";
import { pageHeader, table, card, badge, subline, matches } from "./shared.ts";
import { keychain } from "./keychain.ts";
import { detail, labelRole } from "./user-detail.ts";

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
  let [email, role, message, inviteLink, inviteWarning] = ["", "member", "", "", ""];
  let busy = false;
  const userHref = (principal: string) => page.href("user", { principal });
  const confirmAdmin = (id: string) =>
    window.confirm(
      "Make " + id + " an org admin?\n\nThey will be able to manage users, permissions, and organization settings.",
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
  const admin = (u: any) => {
    const revoke = u.admin?.isAdmin;
    if (!(revoke ? window.confirm("Revoke admin access for " + u.principalId + "?") : confirmAdmin(u.principalId)))
      return;
    void act(
      () =>
        revoke
          ? page.api(
              "DELETE",
              `/api/grants/${encodeURIComponent(u.principalId)}?scope=${encodeURIComponent(u.admin.scopeId)}&role=${encodeURIComponent(u.admin.role)}`,
            )
          : page.api("POST", "/api/grants", { principalId: u.principalId, role: "org_admin", scopeId: page.orgScope }),
      "Could not update admin access",
    );
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
    if (body.role === "org_admin" && !confirmAdmin(body.email)) return;
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
    const roster = (data.users || []).filter((u: any) =>
      matches(filter, u.principalId, u.admin?.role || "", u.admin?.scopeId || "member"),
    );
    const admins = (data.grants || []).filter((g: any) => g.role === "org_admin").length;
    const lastAdmin = (u: any) => u.admin?.isAdmin && admins <= 1;
    render(
      html`${pageHeader({
          count: `${(data.users || []).length} users · ${admins} admins`,
          tabs: [
            { label: "Users", href: page.href("users"), active: true },
            { label: "Keychain", href: page.href("keychain") },
          ],
          search: { value: filter, placeholder: "principal, role, or scope", onInput: (v) => ((filter = v), draw()) },
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
                    <option value="org_admin">Admin</option>
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
                  { node: html`<a href=${userHref(u.principalId)}>${u.principalId}</a>`, cls: "mono" },
                  { node: subline(u.admin?.isAdmin ? labelRole(u.admin.role) : "member") },
                  { text: u.lastSeenAt ? relTime(u.lastSeenAt) : "-", cls: "num" },
                  { text: String(u.sessionCount), cls: "num" },
                  { text: String(u.turnCount), cls: "num" },
                  {
                    action: {
                      label: u.admin?.isAdmin ? "Revoke" : "Make admin",
                      danger: !!u.admin?.isAdmin,
                      disabled: busy || lastAdmin(u),
                      title: lastAdmin(u) ? "The last admin cannot be revoked." : "",
                      run: () => admin(u),
                    },
                  },
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
                  m.status === "active" || (m.kind !== "teammate" && Date.now() - m.expiresAt >= 86400000)
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
