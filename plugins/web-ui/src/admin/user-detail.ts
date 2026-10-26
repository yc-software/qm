import { html, nothing } from "lit";
import { card, table, badge, renderer } from "./shared.ts";

export async function detail(root: HTMLElement, principal: string, s: Record<string, any>) {
  const paint = renderer(root);
  const back = { label: "← Users", onClick: () => window.history.back() };
  s.pageShell({ back, title: principal || "User" });
  paint(html`<div class="detail">Loading…</div>`);
  const r = await s.api("GET", "/api/users/" + encodeURIComponent(principal));
  if (!s.current(principal)) return;
  if (!r.ok) {
    paint(
      html`<div class="detail">
        ${r.status === 403 ? "You don't have admin access." : r.data?.message || `Failed to load user (${r.status}).`}
      </div>`,
    );
    return;
  }
  const d = r.data || {};
  s.pageShell({
    back,
    title: d.displayName || d.principalId || principal,
    context: [d.admin?.isAdmin ? s.labelRole(d.admin.role) : "member", d.scopeId || ""].filter(Boolean).join(" · "),
  });
  const personalScope = d.scopeId || "personal:" + principal;
  let onboarding = d.onboarding || "not_started";
  let busy = false;
  let hint = "";
  let resetHint = "";
  let credentials: any = null;
  let credentialError = "";
  let sort = "default";
  let selectedGrant: any = null;
  let usage: any = null;
  let usageRequest = 0;
  const stacked = (primary: any, secondary: any) =>
    html`<div>
      <div class="primaryline">${primary}</div>
      ${secondary ? html`<div class="subline">${secondary}</div>` : nothing}
    </div>`;
  const muted = (text: string) => html`<span class="subline">${text}</span>`;
  const credName = (id: string) => {
    const c = credentials?.credentials?.find((c: any) => c.id === id);
    return c ? c.service + (c.accountLabel ? " - " + c.accountLabel : "") : id;
  };
  async function setOnboarding(status: string) {
    busy = true;
    hint = "Saving…";
    draw();
    try {
      const result = await s.api("PUT", "/api/users/" + encodeURIComponent(principal) + "/onboarding", { status });
      if (!result.ok) hint = result.data?.message || "Failed (" + result.status + ").";
      else {
        onboarding = result.data?.status || status;
        hint = status === "not_started" ? "Reset. Onboarding will run on this person's next DM." : "Saved.";
      }
    } catch {
      hint = "Network error. Try again.";
    } finally {
      busy = false;
      draw();
    }
  }
  async function reset() {
    if (
      !s.confirm(
        "Delete this person's personal DM sessions (transcripts included) and clear their onboarding?\n\nThis is irreversible. Their channel history is untouched. On their next web visit they'll see the new-user welcome greeting, then onboarding.",
      )
    )
      return;
    busy = true;
    resetHint = "Resetting…";
    draw();
    try {
      const result = await s.api("POST", "/api/users/" + encodeURIComponent(principal) + "/reset");
      if (!result.ok) resetHint = result.data?.message || "Failed (" + result.status + ").";
      else if (s.current(principal)) {
        s.reload(principal);
        return;
      }
    } catch {
      resetHint = "Network error. Try again.";
    } finally {
      busy = false;
      draw();
    }
  }
  async function showUsage(grant: any) {
    const request = ++usageRequest;
    selectedGrant = grant;
    usage = null;
    draw();
    const result = await s.api(
      "GET",
      "/api/audit?scope=org:" +
        encodeURIComponent(s.orgId) +
        "&action=keychain.materialize&resource=" +
        encodeURIComponent("grant " + grant.id) +
        "&limit=2000",
    );
    if (request !== usageRequest) return;
    usage = result.ok ? result.data?.events || [] : [];
    draw();
  }
  function keychain() {
    if (credentialError) return credentialError;
    if (!credentials) return "Loading credentials and grants…";
    if (credentials.enabled === false) return html`<div><p class="empty">Keychain is not enabled.</p></div>`;
    const creds = credentials.credentials || [];
    const grants = credentials.grants || [];
    const group: Record<string, number> = { active: 0, used: 1, expired: 2, revoked: 3 };
    const timestamp = (g: any) => g.usedAt || g.revokedAt || g.createdAt || 0;
    const sorted = grants.slice().sort((a: any, b: any) => {
      if (sort === "mode") return String(a.mode).localeCompare(String(b.mode)) || timestamp(b) - timestamp(a);
      if (sort === "status") return String(a.status).localeCompare(String(b.status)) || timestamp(b) - timestamp(a);
      return (group[a.status] ?? 9) - (group[b.status] ?? 9) || timestamp(b) - timestamp(a);
    });
    return html`<div>
      ${card(
        "Credentials (" + creds.length + ")",
        "Logins this person registered in their keychain. Metadata only — secrets are never returned.",
        table(
          ["Service", "Kind", "Origin", "Account", "Added"],
          creds
            .slice()
            .sort((a: any, b: any) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
            .map((c: any) => [
              { node: stacked(c.service, c.id), cls: "mono" },
              { node: muted(c.kind || "unknown") },
              { node: muted(c.origin || "-") },
              c.accountLabel || c.envKey || c.host || "-",
              { text: c.createdAt ? s.fmtTime(c.createdAt) : "-", cls: "num" },
            ]),
          "No credentials registered.",
        ),
      )}${card(
        "Grants (" + grants.length + ")",
        "Purpose-bound grants this person issued. Every use — standing or one-time — is audited.",
        html`<div>
          ${
            selectedGrant
              ? html`<p class="kc-sortbar">
                    <button
                      type="button"
                      class="link"
                      @click=${() => {
                        ++usageRequest;
                        selectedGrant = null;
                        draw();
                      }}
                    >
                      ‹ Back to grants
                    </button>
                  </p>
                  <p class="hint">
                    ${credName(selectedGrant.credentialId) + " · " + (selectedGrant.mode || "?") + " · " + (selectedGrant.status || "?") + " · grant " + selectedGrant.id}
                  </p>
                  ${
                    usage === null
                      ? html`<p class="empty">Loading usage…</p>`
                      : table(
                          ["When", "Used by", "Scope"],
                          usage.map((e: any) => [
                            { text: s.fmtTime(e.ts), cls: "num" },
                            { node: stacked(e.principalId, "") },
                            { node: muted(e.scopeLabel || "-") },
                          ]),
                          "No recorded uses of this grant.",
                        )
                  }`
              : html`<p class="kc-sortbar">
                    Sort:
                    ${[
                      ["default", "status group"],
                      ["mode", "mode"],
                      ["status", "status A-Z"],
                    ].map(
                      ([key, label], i) =>
                        html`${i ? " · " : ""}<button
                            type="button"
                            class=${"link" + (sort === key ? " kc-sort-active" : "")}
                            @click=${() => {
                              sort = key;
                              draw();
                            }}
                          >
                            ${label}
                          </button>`,
                    )}
                  </p>
                  ${table(
                    ["Credential", "Mode", "Status", "Audience", "Purpose", "Uses"],
                    sorted.map((g: any) => [
                      { node: stacked(credName(g.credentialId), g.credentialId), cls: "mono" },
                      { node: muted(g.mode || "unknown") },
                      {
                        node: html`<span
                          ><span class=${"kc-dot kc-dot-" + (g.status || "unknown")}></span
                          >${g.status || "unknown"}</span
                        >`,
                      },
                      { node: stacked(g.audienceScopeId, s.scopeKind(g.audienceScopeId)), cls: "mono" },
                      { node: stacked(g.purpose || "-", g.usedBy ? "used by " + g.usedBy : "") },
                      {
                        action: {
                          label: "View usage ›",
                          title: "Show recorded uses of this grant",
                          run: () => showUsage(g),
                        },
                      },
                    ]),
                    "No grants.",
                  )}`
          }
        </div>`,
      )}
    </div>`;
  }
  function draw() {
    if (!s.current(principal)) return;
    const cfg = d.config;
    const ruleN = cfg?.commandPolicy?.rules?.length || 0,
      allowN = cfg?.egress?.allowedHosts?.length || 0,
      denyN = cfg?.egress?.deniedHosts?.length || 0;
    const kinds: Record<string, string> = { completed: "ok", dismissed: "muted", pending: "warn", not_started: "info" };
    paint(
      html`<div class="detail">
        <div style="margin:0 0 14px">${s.webUiAsButton(d.principalId || principal)}</div>
        <div class="user-resource-links" aria-label="Personal workspace">
          ${[
            ["history", s.plural(d.stats?.sessions ?? 0, "conversation")],
            ["files", "Files"],
            ["deployments", "Apps"],
            ["crons", "Crons"],
            ["skills", "Skills"],
            ["memory", "Memory"],
          ].map(([view, label]) => html`<a href=${s.stateToUrl({ view, scope: personalScope })}>${label} →</a>`)}
        </div>
        <div>${keychain()}</div>
        ${card(
          "Configuration",
          "Policy and connectors for this person's personal scope.",
          html`<div>
              ${
                !cfg
                  ? html`<p class="empty">Config store not available.</p>`
                  : table(
                      ["Setting", "Value"],
                      [
                        ["Custom soul", { node: muted(cfg.hasSoul ? "set · v" + (cfg.soulVersion || 1) : "default") }],
                        [
                          "Command policy",
                          cfg.commandPolicy
                            ? ruleN +
                              " rule" +
                              (ruleN === 1 ? "" : "s") +
                              " · " +
                              (cfg.commandPolicy.mode || "denylist")
                            : "default",
                        ],
                        ["Security posture", cfg.securityPosture || "auto"],
                        ["Sharing posture", cfg.sharingPosture || "isolated"],
                        ["Egress overrides", allowN || denyN ? allowN + " allow · " + denyN + " deny" : "none"],
                        ["Base model", cfg.baseModel || "org default"],
                        ["Connectors linked", String((cfg.connectors || []).length)],
                      ],
                      "No config.",
                    )
              }
            </div>
            <button
              type="button"
              class="link"
              @click=${() => s.go({ view: "governance", scope: personalScope, session: null })}
            >
              Manage in Governance →
            </button>`,
        )}${card(
          "Onboarding",
          "Personal-DM onboarding state. Reset to re-trigger the flow on this person's next DM, or wipe their DMs to replay the full new-user experience.",
          html`<div>
            <div class="obstatus">
              Current status:
              ${badge(onboarding === "not_started" ? "not started" : onboarding, kinds[onboarding] || "muted")}
            </div>
            <div class="obactions">
              ${[
                ["Reset (re-run on next DM)", "not_started"],
                ["Mark completed", "completed"],
                ["Mark dismissed", "dismissed"],
              ].map(
                ([label, status], i) =>
                  html`<button
                    type="button"
                    class=${i === 0 ? "primary" : ""}
                    ?disabled=${busy}
                    @click=${() => setOnboarding(status)}
                  >
                    ${label}
                  </button>`,
              )}
            </div>
            <p class="hint">${hint}</p>
            <div class="obdivider"></div>
            <button type="button" class="danger-link" ?disabled=${busy} @click=${reset}>
              Reset to brand-new (delete this person's DMs) →
            </button>
            <p class="hint">${resetHint}</p>
          </div>`,
        )}
      </div>`,
    );
  }
  draw();
  try {
    const result = await s.api("GET", "/api/keychain?principal=" + encodeURIComponent(d.principalId || principal));
    if (!result.ok) throw new Error(result.data?.message || "Failed to load credentials and grants.");
    credentials = result.data || {};
  } catch (error) {
    credentialError = (error as Error).message || "Failed to load credentials and grants.";
  }
  draw();
}
