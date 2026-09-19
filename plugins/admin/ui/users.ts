import { html } from "lit";
import { table, card, renderer } from "./shared.ts";

type Services = Record<string, any>;
export class UsersView {
  root: HTMLElement;
  data: any;
  services: Services;
  paint: (template: unknown) => void;
  filter = "";
  inviteOpen = false;
  email = "";
  role = "member";
  expires = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  counts = new Map<string, number[]>();
  pending = new Set<string>();
  refreshRequest = 0;
  message = "";
  tone = "";
  externalMessage = "";
  externalTone = "";
  constructor(root: HTMLElement, data: any, services: Services) {
    this.root = root;
    this.data = data;
    this.services = services;
    this.paint = renderer(root);
    services.defaultShell({
      stats: [
        [(data.users || []).length, "Users"],
        [(data.grants || []).length, "Admins"],
      ],
      search: {
        placeholder: "principal, role, or scope",
        onInput: (value: string) => {
          this.filter = value;
          this.draw();
        },
      },
    });
    this.draw();
    void services
      .api("GET", "/api/keychain")
      .then((r: any) => {
        if (!root.isConnected || !r.ok || r.data?.enabled === false) return;
        this.counts = new Map(
          (r.data?.people || []).map((p: any) => [p.principalId, [p.credentialCount || 0, p.activeGrantCount || 0]]),
        );
        this.draw();
      })
      .catch(() => {});
  }
  async action(key: string, work: () => Promise<void>, external = false) {
    if (this.pending.has(key)) return;
    this.pending.add(key);
    if (external) this.externalMessage = "";
    else this.message = "";
    this.draw();
    try {
      await work();
    } catch {
      this.feedback("Network error. Try again.", "err", external);
    } finally {
      this.pending.delete(key);
      if (this.root.isConnected) this.draw();
    }
  }
  feedback(message: string, tone: string, external = false) {
    if (external) {
      this.externalMessage = message;
      this.externalTone = tone;
    } else {
      this.message = message;
      this.tone = tone;
    }
  }
  async refresh() {
    const request = ++this.refreshRequest;
    const r = await this.services.api("GET", "/api/users");
    if (request !== this.refreshRequest) return;
    if (r.ok) this.data = r.data;
    this.services.clearCache();
  }
  async admin(user: any, event: Event) {
    event.stopPropagation();
    const revoke = user.admin?.isAdmin;
    if (!this.services.confirm((revoke ? "Revoke admin access for " : "Make admin: ") + user.principalId + "?")) return;
    await this.action(user.principalId, async () => {
      const r = revoke
        ? await this.services.api(
            "DELETE",
            "/api/grants/" +
              encodeURIComponent(user.principalId) +
              "?scope=" +
              encodeURIComponent(user.admin.scopeId) +
              "&role=" +
              encodeURIComponent(user.admin.role),
          )
        : await this.services.api("POST", "/api/grants", {
            principalId: user.principalId,
            role: "org_admin",
            scopeId: this.services.orgScope,
          });
      if (r.ok) await this.refresh();
      else this.feedback(r.data?.message || "Could not update admin access.", "err");
    });
  }
  async revoke(member: any) {
    if (
      !this.services.confirm(
        member.status === "active"
          ? 'Revoke access for "' + member.email + '"? They will no longer be able to sign in.'
          : 'Remove "' + member.email + '" from the list?',
      )
    )
      return;
    await this.action(
      member.email,
      async () => {
        const r = await this.services.api("DELETE", "/api/external-users/" + encodeURIComponent(member.email));
        if (r.ok) await this.refresh();
        else
          this.feedback(
            r.status === 403 ? "Only an admin may revoke." : r.data?.message || "Revoke failed.",
            "err",
            true,
          );
      },
      true,
    );
  }
  async invite() {
    const body = { email: this.email.trim(), role: this.role, expiresAt: this.expires };
    if (!body.email || !body.expiresAt) {
      this.feedback(!body.email ? "Email required." : "Expiry date required.", "err", true);
      this.draw();
      return;
    }
    await this.action(
      "invite",
      async () => {
        const r = await this.services.api("POST", "/api/external-users", body);
        if (!r.ok)
          return this.feedback(
            r.status === 403 ? "Only an admin may invite." : r.data?.message || "Invite failed.",
            "err",
            true,
          );
        const member = r.data.member;
        const expiry = " (expires " + this.services.fmtTime(member.expiresAt) + ")";
        await this.refresh();
        let message = "Updated " + member.email + " — " + this.services.labelRole(member.role) + expiry;
        if (r.data.emailSent) message = "Invite sent to " + member.email + expiry;
        else if (r.data.emailProblem)
          message =
            "Added " +
            member.email +
            ", but no invitation email was sent: " +
            r.data.emailProblem +
            "." +
            (r.data.signInUrl ? " Portal: " + r.data.signInUrl + ". A working sign-in method is required." : "");
        this.feedback(message, r.data.emailSent || !r.data.emailProblem ? "ok" : "dirty", true);
        if (this.email.trim() === body.email && this.role === body.role && this.expires === body.expiresAt)
          this.inviteOpen = false;
      },
      true,
    );
  }
  draw() {
    const s = this.services;
    const matches = (parts: unknown[]) => parts.join(" ").toLowerCase().includes(this.filter.trim().toLowerCase());
    const users = (this.data.users || []).filter((u: any) =>
      matches([u.principalId, u.admin?.role || "", u.admin?.scopeId || "member"]),
    );
    const externals = (this.data.externalUsers || []).filter((m: any) =>
      matches([m.email, m.role, m.invitedBy || "", m.status]),
    );
    const admins = (this.data.grants || []).filter((g: any) => g.role === "org_admin").length;
    const inviteEmail = this.data.inviteEmail || {};
    const field = (label: string, input: unknown, cls = "") =>
      html`<div class=${"f" + (cls ? " " + cls : "")}>
        <label for=${"users-" + label.toLowerCase()}>${label}</label>${input}
      </div>`;
    const invite = html`<div class=${this.inviteOpen ? "" : "hidden"} style="margin:0 0 14px">
      <div class="grant-form">
        ${field(
          "Email",
          html`<input
            id="users-email"
            type="email"
            placeholder="name@example.com"
            spellcheck="false"
            autocapitalize="none"
            .value=${this.email}
            @input=${(e: Event) => {
              this.email = (e.target as HTMLInputElement).value;
            }}
          />`,
          "grow",
        )}${field(
          "Role",
          html`<select
            id="users-role"
            .value=${this.role}
            @change=${(e: Event) => {
              this.role = (e.target as HTMLSelectElement).value;
            }}
          >
            <option value="member">Member</option>
            <option value="org_admin">Admin</option>
          </select>`,
        )}${field(
          "Expires",
          html`<input
            id="users-expires"
            type="date"
            min=${new Date().toISOString().slice(0, 10)}
            .value=${this.expires}
            @input=${(e: Event) => {
              this.expires = (e.target as HTMLInputElement).value;
            }}
          />`,
        )}<button type="button" class="primary" ?disabled=${this.pending.has("invite")} @click=${() => this.invite()}>
          ${inviteEmail.configured === false ? "Add user" : "Send invite"}
        </button>
      </div>
      <p class=${inviteEmail.configured === false ? "hint flag-warn" : "hint"}>
        ${inviteEmail.configured === false ? (inviteEmail.problem || "Invitation emails are not configured") + ". Users can still be added, but need a configured sign-in method before they can log in." + (inviteEmail.signInUrl ? " Sign-in link to share: " + inviteEmail.signInUrl : "") : "Invitation emails go out through Resend — core needs RESEND_API_KEY and AUTH_EMAIL_FROM. Without them users can still be added, but need a configured sign-in method before they can log in."}
      </p>
    </div>`;
    const externalTable = table(
      ["Email", "Role", "Expires", "Invited by", "Status", ""],
      externals.map((m: any) => [
        { text: m.email, cls: "mono" },
        { node: html`<span class="subline">${s.labelRole(m.role)}</span>` },
        (m.status === "active" ? "Ends " : "Ended ") + new Date(m.expiresAt).toISOString().slice(0, 10) + " (UTC)",
        m.invitedBy || "-",
        { badge: m.status === "active" ? "Active" : "Expired", kind: m.status === "active" ? "ok" : "warn" },
        m.status === "active" || Date.now() - m.expiresAt >= 86400000
          ? {
              action: {
                label: m.status === "active" ? "Revoke" : "Remove",
                danger: m.status === "active",
                disabled: this.pending.has(m.email),
                run: () => this.revoke(m),
              },
            }
          : "",
      ]),
      this.data.externalUsers?.length
        ? "No external users match."
        : "No external users. Use Invite external user to invite an outside collaborator.",
    );
    const roster = table(
      ["Principal", "Role", "Last seen", "Sessions", "Turns", "Credentials", "Grants", "", ""],
      users.map((u: any) => [
        { text: u.principalId, cls: "mono" },
        { node: html`<span class="subline">${u.admin?.isAdmin ? s.labelRole(u.admin.role) : "member"}</span>` },
        u.lastSeenAt
          ? { node: html`<span title=${s.fmtTime(u.lastSeenAt)}>${s.relTime(u.lastSeenAt)}</span>`, cls: "num" }
          : { text: "-", cls: "num" },
        { text: String(u.sessionCount), cls: "num" },
        { text: String(u.turnCount), cls: "num" },
        ...[0, 1].map((i) => ({
          text: this.counts.has(u.principalId) ? String(this.counts.get(u.principalId)![i]) : "-",
          cls: "num",
        })),
        {
          action: {
            label: "Impersonate ↗",
            run: (event: Event) => {
              event.stopPropagation();
              s.openWebUiAs(u.principalId);
            },
          },
        },
        {
          action: {
            label: u.admin?.isAdmin ? "Revoke" : "Make admin",
            danger: !!u.admin?.isAdmin,
            disabled: this.pending.has(u.principalId) || (u.admin?.isAdmin && admins <= 1),
            title: u.admin?.isAdmin && admins <= 1 ? "The last admin cannot be revoked." : "",
            run: (event: Event) => this.admin(u, event),
          },
        },
      ]),
      "No users match.",
      (i) => s.openUser(users[i].principalId),
    );
    this.paint(
      html`<div class="users-layout">
        <div class="list-root">
          <section class="card users-roster">
            <div class="head">
              <h2>External users</h2>
              <p>
                Outside collaborators invited by email until an expiry date. Org members do not need an external invite.
              </p>
              <button
                type="button"
                class="rowbtn"
                title="Invite external user"
                aria-label="Invite external user"
                aria-expanded=${String(this.inviteOpen)}
                @click=${() => {
                  this.inviteOpen = !this.inviteOpen;
                  this.draw();
                  if (this.inviteOpen) this.root.querySelector<HTMLInputElement>("#users-email")?.focus();
                }}
              >
                Invite external user
              </button>
            </div>
            <div class="body">
              ${invite}${externalTable}
              <p
                id="st-external"
                class=${"status" + (this.externalTone ? " " + this.externalTone : "")}
                style="margin:10px 0 0"
              >
                ${this.externalMessage}
              </p>
            </div>
          </section>
          ${card(
            "Users",
            "Everyone who has used the agent — click a row for their activity, artifacts, and config.",
            html`<p class=${"status" + (this.tone ? " " + this.tone : "")} id="st-users" role="status">
                ${this.message}
              </p>
              ${roster}`,
          )}
        </div>
      </div>`,
    );
  }
}

export function users(root: HTMLElement, data: any, services: Services) {
  return new UsersView(root, data, services);
}
