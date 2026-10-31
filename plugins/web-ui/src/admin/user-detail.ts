import { withBase } from "../core-bridge.ts";
import { html, render } from "lit";
import { formatMessageTime } from "../message-time.ts";
import type { AdminPage } from "./sections.ts";
import { pageHeader, card, table, badge, stacked, subline } from "./shared.ts";

export const labelRole = (role: string) => (role === "org_admin" ? "admin" : String(role || "").replace(/_/g, " "));

const ONBOARDING_KIND: Record<string, string> = {
  completed: "ok",
  dismissed: "muted",
  pending: "warn",
  not_started: "info",
};

async function openWebUiAs(target: string) {
  try {
    const res = await fetch("/auth/impersonate?target=" + encodeURIComponent(target), {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      return alert("Couldn't start impersonation: " + (j?.message || "Failed (" + res.status + ")"));
    }
  } catch (e) {
    return alert("Couldn't start impersonation: " + ((e as Error)?.message || e));
  }
  window.open(withBase("/"), "_blank", "noopener");
}

export async function detail(page: AdminPage) {
  const principal = page.params.get("principal") || "";
  const back = { label: "Users", href: page.href("users") };
  const show = (body: unknown, title: unknown = principal || "User", context?: unknown) =>
    render(
      html`${pageHeader({ back, title, context })}
        <div class="detail">${body}</div>`,
      page.host,
    );
  show("Loading…");
  const [r, kc] = await Promise.all([
    page.api("GET", "/api/users/" + encodeURIComponent(principal)),
    page.api("GET", "/api/keychain?principal=" + encodeURIComponent(principal)),
  ]);
  if (!page.current()) return;
  if (!r.ok)
    return show(
      r.status === 403 ? "You don't have admin access." : r.data?.message || `Failed to load user (${r.status}).`,
    );
  const d = r.data || {};
  const personalScope = d.scopeId || "personal:" + principal;
  let [onboarding, busy, hint, resetHint] = [d.onboarding || "not_started", false, "", ""];
  const creds = kc.data?.credentials || [];
  const credName = (id: string) => {
    const c = creds.find((c: any) => c.id === id);
    return c ? c.service + (c.accountLabel ? " - " + c.accountLabel : "") : id;
  };
  async function setOnboarding(status: string) {
    [busy, hint] = [true, "Saving…"];
    draw();
    const result = await page.api("PUT", "/api/users/" + encodeURIComponent(principal) + "/onboarding", { status });
    if (!result.ok) hint = result.data?.message || "Failed (" + result.status + ").";
    else {
      onboarding = result.data?.status || status;
      hint = status === "not_started" ? "Reset. Onboarding will run on this person's next DM." : "Saved.";
    }
    busy = false;
    draw();
  }
  async function reset() {
    if (
      !window.confirm(
        "Delete this person's personal DM sessions (transcripts included) and clear their onboarding?\n\nThis is irreversible. Their channel history is untouched. On their next web visit they'll see the new-user welcome greeting, then onboarding.",
      )
    )
      return;
    [busy, resetHint] = [true, "Resetting…"];
    draw();
    const result = await page.api("POST", "/api/users/" + encodeURIComponent(principal) + "/reset");
    if (result.ok && page.current()) return detail(page);
    resetHint = result.data?.message || "Failed (" + result.status + ").";
    busy = false;
    draw();
  }
  const keychainCards = () => {
    if (!kc.ok) return html`<p class="empty">${kc.data?.message || "Failed to load credentials and grants."}</p>`;
    if (kc.data?.enabled === false) return html`<p class="empty">Keychain is not enabled.</p>`;
    return html`${card(
      "Credentials (" + creds.length + ")",
      "Logins this person registered in their keychain. Metadata only — secrets are never returned.",
      table(
        ["Service", "Kind", "Origin", "Account", "Added"],
        creds.map((c: any) => [
          { node: stacked(c.service, c.id), cls: "mono" },
          { node: subline(c.kind || "unknown") },
          { node: subline(c.origin || "-") },
          c.accountLabel || c.envKey || c.host || "-",
          { text: c.createdAt ? formatMessageTime(c.createdAt) : "-", cls: "num" },
        ]),
        "No credentials registered.",
      ),
    )}${card(
      "Grants (" + (kc.data?.grants || []).length + ")",
      "Purpose-bound grants this person issued. Every use — standing or one-time — is audited.",
      table(
        ["Credential", "Mode", "Status", "Audience", "Purpose"],
        (kc.data?.grants || []).map((g: any) => [
          { node: stacked(credName(g.credentialId), g.credentialId), cls: "mono" },
          { node: subline(g.mode || "unknown") },
          { node: subline(g.status || "unknown") },
          { text: g.audienceScopeId, cls: "mono" },
          { node: stacked(g.purpose || "-", g.usedBy ? "used by " + g.usedBy : "") },
        ]),
        "No grants.",
      ),
    )}`;
  };
  function draw() {
    if (!page.current()) return;
    show(
      html`<button type="button" class="link" @click=${() => openWebUiAs(d.principalId || principal)}>
          Open web UI as this person ↗
        </button>
        <div class="user-resource-links" aria-label="Personal workspace">
          ${[
            ["history", `${d.stats?.sessions ?? 0} conversation${d.stats?.sessions === 1 ? "" : "s"}`],
            ["files", "Files"],
            ["deployments", "Apps"],
            ["crons", "Crons"],
            ["skills", "Skills"],
            ["memory", "Memory"],
            ["governance", "Governance"],
          ].map(([view, label]) => html`<a href=${page.href(view, { scope: personalScope })}>${label} →</a>`)}
        </div>
        ${keychainCards()}
        ${card(
          "Onboarding",
          "Personal-DM onboarding state. Reset to re-trigger the flow on this person's next DM, or wipe their DMs to replay the full new-user experience.",
          html`<div class="obstatus">
              Current status:
              ${badge(onboarding === "not_started" ? "not started" : onboarding, ONBOARDING_KIND[onboarding] || "muted")}
            </div>
            <div class="obactions">
              ${[
                ["Reset (re-run on next DM)", "not_started"],
                ["Mark completed", "completed"],
                ["Mark dismissed", "dismissed"],
              ].map(
                ([label, status]) =>
                  html`<button class="btn" type="button" ?disabled=${busy} @click=${() => setOnboarding(status)}>
                    ${label}
                  </button>`,
              )}
            </div>
            <p class="hint">${hint}</p>
            <button type="button" class="danger-link" ?disabled=${busy} @click=${reset}>
              Reset to brand-new (delete this person's DMs) →
            </button>
            <p class="hint">${resetHint}</p>`,
        )}`,
      d.displayName || d.principalId || principal,
      [d.admin?.isAdmin ? labelRole(d.admin.role) : "member", d.scopeId].filter(Boolean).join(" · "),
    );
  }
  draw();
}
