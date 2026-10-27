import { html, nothing } from "lit";
import { card, table, renderer, stacked, subline as muted } from "./shared.ts";
import { fmtTime, labelRole, plural, scopeKind } from "./format.ts";
const USAGE_LIMIT = 2000;
type Detail = Record<string, any>;

export async function detail(root: HTMLElement, principal: string, s: Record<string, any>) {
  const paint = renderer(root);
  const back = { label: "← Users", onClick: () => window.history.back() };
  s.pageShell({ back, title: principal || "User" });
  paint(html`<div class="detail">Loading…</div>`);
  const r = await s.api("GET", "/api/users/" + encodeURIComponent(principal));
  if (!s.current(principal)) return;
  if (!r.ok)
    return paint(
      html`<div class="detail">
        ${r.status === 403 ? "You don't have admin access." : r.data?.message || `Failed to load user (${r.status}).`}
      </div>`,
    );
  const d = r.data || {};
  s.pageShell({
    back,
    title: d.displayName || d.principalId || principal,
    context: [d.admin?.isAdmin ? labelRole(d.admin.role) : "member", d.scopeId || ""].filter(Boolean).join(" · "),
  });
  const personalScope = d.scopeId || "personal:" + principal;
  const u: Detail = { s, d, principal, paint, personalScope, busy: false };
  Object.assign(u, { resetHint: "", sort: "default", credentialError: "", usageRequest: 0 });
  draw(u);
  try {
    const result = await s.api("GET", "/api/keychain?principal=" + encodeURIComponent(d.principalId || principal));
    if (!result.ok) throw new Error(result.data?.message || "Failed to load credentials and grants.");
    u.credentials = result.data || {};
  } catch (error) {
    u.credentialError = (error as Error).message || "Failed to load credentials and grants.";
  }
  draw(u);
}
const credName = (u: Detail, id: string) => {
  const c = u.credentials?.credentials?.find((c: any) => c.id === id);
  return c ? c.service + (c.accountLabel ? " - " + c.accountLabel : "") : id;
};
async function reset(u: Detail) {
  const { s, principal } = u;
  const warning =
    "Delete this person's personal DM sessions (transcripts included)?\n\nThis is irreversible. Their channel history is untouched. On their next web visit they'll see the new-user welcome greeting, then onboarding.";
  if (!s.confirm(warning)) return;
  [u.busy, u.resetHint] = [true, "Resetting…"];
  draw(u);
  try {
    const result = await s.api("POST", "/api/users/" + encodeURIComponent(principal) + "/reset");
    if (!result.ok) u.resetHint = result.data?.message || "Failed (" + result.status + ").";
    else if (s.current(principal)) {
      s.reload(principal);
      return;
    }
  } catch {
    u.resetHint = "Network error. Try again.";
  } finally {
    u.busy = false;
    draw(u);
  }
}
async function showUsage(u: Detail, grant: any) {
  const request = ++u.usageRequest;
  u.selectedGrant = grant;
  u.usage = null;
  draw(u);
  const resource = encodeURIComponent("grant " + grant.id);
  const result = await u.s.api(
    "GET",
    `/api/audit?scope=org:${encodeURIComponent(u.s.orgId)}&action=keychain.materialize&resource=${resource}&limit=${USAGE_LIMIT}`,
  );
  if (request !== u.usageRequest) return;
  u.usage = result.ok
    ? result.data?.events || []
    : { error: result.data?.message || "Failed (" + result.status + ")." };
  draw(u);
}
function usageView({ usage }: Detail) {
  if (usage === null) return html`<p class="empty">Loading usage…</p>`;
  if (usage.error) return html`<p class="empty">${"Couldn't load usage: " + usage.error}</p>`;
  return html`${usage.length >= USAGE_LIMIT ? html`<p class="hint">Showing the ${USAGE_LIMIT.toLocaleString()} most recent uses.</p>` : nothing}${table(
    ["When", "Used by", "Scope"],
    usage.map((e: any) => [
      { text: fmtTime(e.ts), cls: "num" },
      { node: stacked(e.principalId, "") },
      { node: muted(e.scopeLabel || "-") },
    ]),
    "No recorded uses of this grant.",
  )}`;
}
function keychain(u: Detail) {
  const { credentials, credentialError, selectedGrant, sort } = u;
  if (credentialError) return credentialError;
  if (!credentials) return "Loading credentials and grants…";
  if (credentials.enabled === false) return html`<div><p class="empty">Keychain is not enabled.</p></div>`;
  const creds = credentials.credentials || [];
  const grants = credentials.grants || [];
  const group: Record<string, number> = { active: 0, used: 1, expired: 2, revoked: 3 };
  const timestamp = (g: any) => g.usedAt || g.revokedAt || g.createdAt || 0;
  const order = (a: any, b: any) =>
    sort === "default"
      ? (group[a.status] ?? 9) - (group[b.status] ?? 9)
      : String(a[sort]).localeCompare(String(b[sort]));
  const sorted = grants.slice().sort((a: any, b: any) => order(a, b) || timestamp(b) - timestamp(a));
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
            { text: c.createdAt ? fmtTime(c.createdAt) : "-", cls: "num" },
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
                      ++u.usageRequest;
                      u.selectedGrant = null;
                      draw(u);
                    }}
                  >
                    ‹ Back to grants
                  </button>
                </p>
                <p class="hint">
                  ${credName(u, selectedGrant.credentialId) + " · " + (selectedGrant.mode || "?") + " · " + (selectedGrant.status || "?") + " · grant " + selectedGrant.id}
                </p>
                ${usageView(u)}`
            : html`<p class="kc-sortbar">
                  Sort:
                  ${Object.entries({ default: "status group", mode: "mode", status: "status A-Z" }).map(
                    ([key, label], i) =>
                      html`${i ? " · " : ""}<button
                          type="button"
                          class=${"link" + (sort === key ? " kc-sort-active" : "")}
                          @click=${() => ((u.sort = key), draw(u))}
                        >
                          ${label}
                        </button>`,
                  )}
                </p>
                ${table(
                  ["Credential", "Mode", "Status", "Audience", "Purpose", "Uses"],
                  sorted.map((g: any) => [
                    { node: stacked(credName(u, g.credentialId), g.credentialId), cls: "mono" },
                    { node: muted(g.mode || "unknown") },
                    {
                      node: html`<span
                        ><span class=${"kc-dot kc-dot-" + (g.status || "unknown")}></span>${g.status || "unknown"}</span
                      >`,
                    },
                    { node: stacked(g.audienceScopeId, scopeKind(g.audienceScopeId)), cls: "mono" },
                    { node: stacked(g.purpose || "-", g.usedBy ? "used by " + g.usedBy : "") },
                    {
                      action: {
                        label: "View usage ›",
                        title: "Show recorded uses of this grant",
                        run: () => showUsage(u, g),
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
function draw(u: Detail) {
  const { s, d, principal, personalScope, busy, resetHint } = u;
  if (!s.current(principal)) return;
  const cfg = d.config;
  const ruleN = cfg?.commandPolicy?.rules?.length || 0,
    allowN = cfg?.egress?.allowedHosts?.length || 0,
    denyN = cfg?.egress?.deniedHosts?.length || 0;
  u.paint(
    html`<div class="detail">
      <div style="margin:0 0 14px">${s.webUiAsButton(d.principalId || principal)}</div>
      <div class="user-resource-links" aria-label="Personal workspace">
        ${[
          ["history", plural(d.stats?.sessions ?? 0, "conversation")],
          ["files", "Files"],
          ["deployments", "Apps"],
          ["crons", "Crons"],
          ["skills", "Skills"],
          ["memory", "Memory"],
        ].map(([view, label]) => html`<a href=${s.stateToUrl({ view, scope: personalScope })}>${label} →</a>`)}
      </div>
      <div>${keychain(u)}</div>
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
                      [
                        "Custom instructions",
                        { node: muted(cfg.hasInstructions ? "set · v" + (cfg.instructionsVersion || 1) : "default") },
                      ],
                      [
                        "Command policy",
                        cfg.commandPolicy
                          ? `${ruleN} rule${ruleN === 1 ? "" : "s"} · ${cfg.commandPolicy.mode || "denylist"}`
                          : "default",
                      ],
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
        "Wipe this person's DMs to replay the full new-user experience.",
        html`<div>
          <button type="button" class="danger-link" ?disabled=${busy} @click=${() => reset(u)}>
            Reset to brand-new (delete this person's DMs) →
          </button>
          <p class="hint">${resetHint}</p>
        </div>`,
      )}
    </div>`,
  );
}
