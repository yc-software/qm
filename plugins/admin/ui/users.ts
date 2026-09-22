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
  inviteLink = "";
  inviteWarning = "";
  copyLabel = "Copy invite link";
  counts = new Map<string, number[]>();
  pending = new Set<string>();
  refreshRequest = 0;
  message = "";
  tone = "";
  externalMessage = "";
  externalTone = "";
  search: HTMLElement | null = null;
  constructor(root: HTMLElement, data: any, services: Services) {
    this.root = root;
    this.data = data;
    this.services = services;
    this.paint = renderer(root);
    this.renderShell();
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
  renderShell() {
    const document = this.root.ownerDocument;
    const previous = this.search;
    if (previous && !previous.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    const focused = !!active && !!previous?.contains(active);
    this.services.defaultShell({
      stats: [
        [(this.data.users || []).length, "Users"],
        [(this.data.grants || []).length, "Admins"],
      ],
      search: {
        value: this.filter,
        placeholder: "principal, role, or scope",
        onInput: (value: string) => {
          this.filter = value;
          this.draw();
        },
      },
    });
    const search = document.querySelector<HTMLElement>("#shellbar .shell-search");
    if (previous && search) {
      search.replaceWith(previous);
      if (focused) active?.focus({ preventScroll: true });
    } else this.search = search;
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
    if (r.ok) {
      this.data = r.data;
      this.renderShell();
    }
    this.services.clearCache();
  }
  confirmAdmin(principalId: string) {
    return this.services.confirm(
      "Make " +
        principalId +
        " an org admin?\n\nThey will be able to manage users, permissions, and organization settings.",
    );
  }
  async admin(user: any, event: Event) {
    event.stopPropagation();
    const revoke = user.admin?.isAdmin;
    if (
      !(revoke
        ? this.services.confirm("Revoke admin access for " + user.principalId + "?")
        : this.confirmAdmin(user.principalId))
    )
      return;
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
    const body = { email: this.email.trim(), role: this.role };
    if (!body.email) {
      this.feedback("Email required.", "err", true);
      this.draw();
      return;
    }
    if (body.role === "org_admin" && !this.confirmAdmin(body.email)) return;
    this.inviteLink = "";
    this.inviteWarning = "";
    this.copyLabel = "Copy invite link";
    await this.action(
      "invite",
      async () => {
        const r = await this.services.api("POST", "/api/users/invite", body);
        if (!r.ok)
          return this.feedback(
            r.status === 403 ? "Only an admin may invite." : r.data?.message || "Invite failed.",
            "err",
            true,
          );
        const member = r.data.member;
        await this.refresh();
        this.feedback(r.data.emailSent ? "Invite sent to " + member.email : "Added " + member.email + ".", "ok", true);
        if (!r.data.emailSent && r.data.signInUrl) {
          this.inviteLink = r.data.signInUrl;
          this.inviteWarning =
            this.data.inviteEmail?.configured === false
              ? "You'll need to configure RESEND_API_KEY to send magic link emails. Otherwise, share the link directly:"
              : "Email couldn't be sent. Share the invite link directly.";
        }
        if (this.email.trim() === body.email && this.role === body.role) this.inviteOpen = false;
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
        )}<button type="button" class="primary" ?disabled=${this.pending.has("invite")} @click=${() => this.invite()}>
          Send invite
        </button>
      </div>
    </div>`;
    const externalTable = table(
      ["Email", "Role", "Expires", "Invited by", "Status", ""],
      externals.map((m: any) => [
        { text: m.email, cls: "mono" },
        { node: html`<span class="subline">${s.labelRole(m.role)}</span>` },
        m.expiresAt === null
          ? "No expiration"
          : (m.status === "active" ? "Ends " : "Ended ") + new Date(m.expiresAt).toISOString().slice(0, 10) + " (UTC)",
        m.invitedBy || "-",
        { badge: m.status === "active" ? "Active" : "Expired", kind: m.status === "active" ? "ok" : "warn" },
        m.status === "active" || (m.kind !== "teammate" && Date.now() - m.expiresAt >= 86400000)
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
      this.data.externalUsers?.length ? "No invitations match." : "No invitations yet. Invite a teammate above.",
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
              <h2>Users</h2>
              <button
                type="button"
                class="primary"
                title="Invite teammate"
                aria-label="Invite teammate"
                aria-expanded=${String(this.inviteOpen)}
                @click=${() => {
                  this.inviteOpen = !this.inviteOpen;
                  this.draw();
                  if (this.inviteOpen) this.root.querySelector<HTMLInputElement>("#users-email")?.focus();
                }}
              >
                Invite teammate
              </button>
            </div>
            <div class="body">
              ${invite}${roster}
              <p class=${"status " + this.tone} id="st-users" role="status">${this.message}</p>
              <p
                id="st-external"
                class=${"status" + (this.externalTone ? " " + this.externalTone : "")}
                style="margin:10px 0 0"
              >
                ${this.externalMessage}
              </p>
              ${
                this.inviteLink
                  ? html`<p class="flag-warn">${this.inviteWarning}</p>
                      <button
                        type="button"
                        @click=${async () => {
                  this.copyLabel = (await s.copyText(this.inviteLink)) ? "Copied" : "Copy failed";
                  this.draw();
                }}
                      >
                        ${this.copyLabel}
                      </button>`
                  : ""
              }
            </div>
          </section>
          ${card("Invitations", "Access granted by email. Revoking ends access to this instance.", externalTable)}
          ${card(
            "Company access",
            "",
            table(
              ["Rule", "Value", "Purpose"],
              [
                [
                  "Email domain allowlist",
                  this.data.access?.emailDomain
                    ? "@" + this.data.access.emailDomain
                    : { node: html`<span class="subline">Not configured</span>` },
                  {
                    node: html`Controls who can create an account at
                      <a href=${(inviteEmail.signInUrl || "/auth/login") + "?provider=primary"}
                        >${inviteEmail.signInUrl || "/auth/login"}</a
                      >.`,
                  },
                ],
                [
                  "Slack email allowlist",
                  this.data.access?.slackAllowFrom?.length
                    ? this.data.access.slackAllowFrom
                        .map((rule: string) => (rule.includes("@") ? rule : "@" + rule))
                        .join(", ")
                    : { node: html`<span class="subline">Not configured</span>` },
                  "Controls who the bot treats as an internal employee in shared Slack workspaces.",
                ],
              ],
              "",
            ),
          )}
        </div>
      </div>`,
    );
  }
}

export function users(root: HTMLElement, data: any, services: Services) {
  return new UsersView(root, data, services);
}
