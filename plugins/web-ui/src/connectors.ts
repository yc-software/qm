import { html, render, type TemplateResult } from "lit";
import { Activity, KeyRound, Link, LockKeyhole, Plug, Plus, RefreshCw, ShieldCheck } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { isActiveGrant, isExpiredCredential, KeychainOperations, keychainSummary } from "./keychain-state";

interface ConnectorProvider {
  connected?: boolean;
  needsReconnect?: boolean;
  refreshError?: string;
  available?: boolean;
  hosts?: Array<{ host?: string } | string>;
}

const CONNECTOR_LABELS: Record<string, { name: string; hosts: string; desc?: string }> = {
  google: {
    name: "Google Workspace",
    hosts: "Gmail, Calendar, Drive, Sheets",
    desc: "Lets the agent read and act in your Gmail, Calendar, and Sheets on your behalf, and read your Drive (it can save new files there, but not edit your existing ones).",
  },
  slack: {
    name: "Slack",
    hosts: "Channels & messages",
    desc: "Lets the agent act in Slack as you — read your channels and post messages on your behalf. (To chat with the agent in Slack, just DM it — you don't need this.)",
  },
  notion: {
    name: "Notion",
    hosts: "Pages & databases",
    desc: "Lets the agent read the Notion pages and databases you share with it (and edit them if you grant that access).",
  },
  linear: {
    name: "Linear",
    hosts: "Issues & projects",
    desc: "Lets the agent read and update your Linear issues on your behalf.",
  },
  github: {
    name: "GitHub",
    hosts: "Repos, issues & PRs",
    desc: "Lets the agent read and update your GitHub repos, issues, and PRs on your behalf.",
  },
  dropbox: {
    name: "Dropbox",
    hosts: "Files & folders",
    desc: "Lets the agent browse, download, and upload files in your Dropbox on your behalf, and manage shared links.",
  },
  x: {
    name: "X (Twitter)",
    hosts: "Posts & profile",
    desc: "Lets the agent read X and post, like, and follow as you — used when an action should come from your account rather than the org's.",
  },
};

const CONNECTOR_LOGOS: Record<string, string> = {
  google:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  notion:
    "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  dropbox:
    "M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z",
  x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
};

function connectorLogo(id: string): TemplateResult {
  const path = CONNECTOR_LOGOS[id];
  if (!path) return html`<span class="connector-logo">${icon(Plug, 18)}</span>`;
  return html`<span class="connector-logo"
    ><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d=${path}></path></svg
  ></span>`;
}

interface KeychainCredential {
  id: string;
  service: string;
  kind?: string;
  envKey?: string;
  accountLabel?: string;
  host?: string;
  fingerprint?: string;
  expiresAt?: number;
  createdAt?: number;
}

interface KeychainConnectorCredential {
  credentialId: string;
  host: string;
  accountType?: string;
  expiresAt?: number;
  connected: boolean;
  needsReconnect?: boolean;
}

interface KeychainGrant {
  id: string;
  credentialId: string;
  audienceScopeId: string;
  mode: "once" | "standing";
  purpose: string;
  status: "active" | "revoked" | "used";
  expiresAt?: number;
}

interface KeychainAsk {
  id: string;
  credentialId: string;
  requesterId: string;
  requesterScopeId: string;
  purpose: string;
  requestedMode?: "once" | "standing";
  expiresAt: number;
}

interface KeychainUsage {
  credentialId: string;
  ts: number;
  scopeLabel: string;
  status: string;
}

let connectorProviders: Record<string, ConnectorProvider> = {};
let keychainCredentials: KeychainCredential[] = [];
let keychainConnectorCredentials: KeychainConnectorCredential[] = [];
let keychainGrants: KeychainGrant[] = [];
let keychainAsks: KeychainAsk[] = [];
let keychainUsage: KeychainUsage[] = [];
let keychainScopeNames: Record<string, string> = {};
let connectorNotice = "";
let addingCredential: { service: string; envKey: string; purpose: string } | null = null;
let secureDropUrl: string | null = null;
let confirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;
let confirmationOpener: HTMLElement | null = null;
const keychainOperations = new KeychainOperations();

export function resetKeychainState(): void {
  keychainOperations.reset();
  connectorProviders = {};
  keychainCredentials = [];
  keychainConnectorCredentials = [];
  keychainGrants = [];
  keychainAsks = [];
  keychainUsage = [];
  keychainScopeNames = {};
  connectorNotice = "";
  addingCredential = null;
  secureDropUrl = null;
  confirmation = null;
  confirmationOpener = null;
}

function fmtDate(ms?: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

function credentialCard(c: KeychainCredential): TemplateResult {
  const subtitle = [c.accountLabel, c.host, c.envKey].filter(Boolean).join(" · ");
  const expired = isExpiredCredential(c);
  const grants = keychainGrants.filter((grant) => grant.credentialId === c.id && isActiveGrant(grant, c));
  const asks = keychainAsks.filter((ask) => ask.credentialId === c.id);
  const lastUse = keychainUsage.find((usage) => usage.credentialId === c.id);
  let added = "Encrypted at rest";
  if (c.kind !== "file" && c.expiresAt) added = `Expires ${fmtDate(c.expiresAt)}`;
  else if (c.createdAt) added = `Added ${fmtDate(c.createdAt)}`;
  return html`
    <article class="kc-resource kc-credential">
      <div class="kc-resource-main">
        <div class="kc-resource-icon">${icon(KeyRound, 18)}</div>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>${c.service}</h3>
            ${expired ? html`<span class="kc-state warning">Expired</span>` : ""}
          </div>
          ${subtitle ? html`<div class="kc-resource-meta">${subtitle}</div>` : ""}
          <div class="kc-credential-facts">
            <div class="kc-audit-line">
              ${icon(Activity, 14)}${lastUse ? html`Last used ${fmtDate(lastUse.ts)} in ${scopeName(lastUse.scopeLabel)} · ${lastUse.status}` : "No audited use yet"}
            </div>
            <div class="kc-resource-foot">${added}</div>
          </div>
        </div>
        <button
          class="kc-text-action danger"
          type="button"
          data-confirm-key=${`delete:${c.id}`}
          ?disabled=${keychainOperations.mutationInFlight}
          @click=${() => void deleteCredential(c)}
        >
          Delete
        </button>
      </div>
      ${
        asks.length
          ? html`<div class="kc-access-block pending">
              <div class="kc-access-label">Pending requests</div>
              ${asks.map(
                (ask) =>
                  html`<div class="kc-access-row">
                    <div>
                      <strong>${scopeName(ask.requesterScopeId)}</strong> requested ${ask.requestedMode ?? "one-time"}
                      access
                      <div>${ask.purpose} · expires ${fmtDate(ask.expiresAt)}</div>
                    </div>
                  </div>`,
              )}
            </div>`
          : ""
      }
      ${
        grants.length
          ? html`<div class="kc-access-block">
              <div class="kc-access-label">${icon(ShieldCheck, 14)} Active access</div>
              ${grants.map(
                (grant) =>
                  html` <div class="kc-access-row">
                    <div>
                      <strong>${scopeName(grant.audienceScopeId)}</strong> · ${grant.mode}
                      <div>${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</div>
                    </div>
                    <button
                      class="kc-text-action"
                      type="button"
                      data-confirm-key=${`revoke:${grant.id}`}
                      ?disabled=${keychainOperations.mutationInFlight}
                      @click=${() => void revokeGrant(grant)}
                    >
                      Revoke
                    </button>
                  </div>`,
              )}
            </div>`
          : ""
      }
    </article>
  `;
}

// Raw Slack IDs (C0…, G0…) mean nothing to people — always prefer a resolved
// name, and fall back to a human description. The raw ID appears only as a
// parenthetical of last resort, to disambiguate when no name is available.
function scopeName(scope: string): string {
  const resolved = keychainScopeNames[scope];
  if (resolved) return resolved;
  const [kind, ...rest] = scope.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "personal":
      return ref || "a personal DM";
    case "channel":
      return ref ? `a Slack channel (${ref})` : "a Slack channel";
    case "group":
      return "a group DM";
    case "team":
      return ref ? `a team (${ref})` : "a team";
    case "org":
      return "the whole org";
    default:
      return scope;
  }
}

function addCredentialCard(): TemplateResult {
  const draft = addingCredential!;
  return html`<section class="kc-add-card" aria-labelledby="kc-add-title">
    <div class="kc-panel-head">
      <div>
        <span class="kc-eyebrow">New credential</span>
        <h2 id="kc-add-title">Add a credential</h2>
        <p>
          Describe the credential here, then paste the secret itself on a private one-time page. It goes straight to
          your encrypted keychain — it is never shown in chat or stored on this page.
        </p>
      </div>
      <div class="kc-panel-icon">${icon(LockKeyhole, 20)}</div>
    </div>
    ${
      secureDropUrl
        ? html`
            <div class="kc-success" role="status">
              <strong>Your one-time page is ready</strong><span>Open it in a new tab and paste the secret there.</span>
            </div>
            <div class="kc-form-actions">
              <a class="btn primary" href=${secureDropUrl} target="_blank" rel="noopener noreferrer"
                >Open the one-time page</a
              ><button
                class="btn"
                type="button"
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Done
              </button>
            </div>
          `
        : html`
            <div class="kc-form-grid">
              <label class="skill-field"
                ><span>Service</span
                ><input
                  class="skill-desc-input"
                  placeholder="Stripe"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.service}
                  @input=${(e: Event) => {
                    draft.service = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field"
                ><span>Environment variable <em>optional</em></span
                ><input
                  class="skill-desc-input"
                  placeholder="STRIPE_API_KEY"
                  autocapitalize="characters"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.envKey}
                  @input=${(e: Event) => {
                    draft.envKey = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field kc-purpose-field"
                ><span>Purpose</span
                ><input
                  class="skill-desc-input"
                  placeholder="What may the agent use this credential for?"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.purpose}
                  @input=${(e: Event) => {
                    draft.purpose = (e.target as HTMLInputElement).value;
                  }}
              /></label>
            </div>
            <div class="kc-form-actions">
              <button
                class="btn"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Cancel</button
              ><button
                class="btn primary"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => void createDrop()}
              >
                ${keychainOperations.dropInFlight ? "Preparing…" : "Continue"}
              </button>
            </div>
          `
    }
  </section>`;
}

function confirmationCard(): TemplateResult {
  const pending = confirmation!;
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeConfirmation()}
  >
    <article
      class="kc-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-body"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeConfirmation)}
    >
      <span class="kc-eyebrow danger">Check impact</span>
      <h2 id="kc-confirm-title">${pending.title}</h2>
      <p id="kc-confirm-body">${pending.body}</p>
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${closeConfirmation}>Cancel</button
        ><button class="btn danger" type="button" @click=${() => void pending.run()}>${pending.action}</button>
      </div>
    </article>
  </div>`;
}

function closeConfirmation(): void {
  const opener = confirmationOpener;
  const key = opener?.dataset.confirmKey;
  confirmation = null;
  confirmationOpener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find(
          (element) => element.dataset.confirmKey === key,
        )
      : null,
  );
}

export function clearConnectorNotice(): void {
  connectorNotice = "";
}

export function noteConnectorResult(provider: string, status: string): void {
  const name = CONNECTOR_LABELS[provider]?.name ?? provider;
  connectorNotice = status === "connected" ? `${name}: connected.` : `${name}: connection failed.`;
}

function drawConnectors(loading = false): void {
  if (appState.currentView !== "keychain") return;
  const entries = Object.entries(connectorProviders);
  const connectorCredentialStates = keychainConnectorCredentials.map((credential) => ({
    id: credential.credentialId,
    kind: "connector",
  }));
  const summary = keychainSummary(
    entries.map(([, provider]) => provider),
    [...keychainCredentials, ...connectorCredentialStates],
    keychainGrants,
    keychainAsks,
  );
  const connectorCards = entries.map(([id, p]) => {
    const meta = CONNECTOR_LABELS[id] ?? { name: id, hosts: "" };
    const connected = Boolean(p.connected);
    const needsReconnect = Boolean(p.needsReconnect);
    const available = Boolean(p.available);
    const hosts = new Set(
      (p.hosts ?? [])
        .map((entry) => (typeof entry === "string" ? entry : entry.host))
        .filter((host): host is string => Boolean(host)),
    );
    const credentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
    const credentialsById = new Map(
      credentials.map((credential) => [credential.credentialId, { id: credential.credentialId, kind: "connector" }]),
    );
    const grants = keychainGrants.filter((grant) => isActiveGrant(grant, credentialsById.get(grant.credentialId)));
    let connectionState: TemplateResult | string = html`<span class="kc-state neutral">Not connected</span>`;
    if (needsReconnect) connectionState = html`<span class="kc-state warning">Reconnect needed</span>`;
    else if (connected) connectionState = "";
    return html`
      <article class="kc-resource kc-account">
        <div class="kc-resource-main">
          ${connectorLogo(id)}
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>${meta.name}</h3>
              ${connectionState}
            </div>
            ${meta.hosts ? html`<div class="kc-resource-meta">${meta.hosts}</div>` : ""}
          </div>
        </div>
        ${meta.desc ? html`<p class="kc-resource-description">${meta.desc}</p>` : ""}
        ${needsReconnect && p.refreshError ? html`<div class="kc-inline-warning" role="status">Refresh failed: ${p.refreshError}</div>` : ""}
        ${
          grants.length
            ? html`<div class="kc-access-block">
                <div class="kc-access-label">${icon(ShieldCheck, 14)} Active access</div>
                ${grants.map(
                  (grant) =>
                    html` <div class="kc-access-row">
                      <div>
                        <strong>${scopeName(grant.audienceScopeId)}</strong> · ${grant.mode}
                        <div>${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</div>
                      </div>
                      <button
                        class="kc-text-action"
                        type="button"
                        data-confirm-key=${`revoke:${grant.id}`}
                        ?disabled=${keychainOperations.mutationInFlight}
                        @click=${() => void revokeGrant(grant)}
                      >
                        Revoke
                      </button>
                    </div>`,
                )}
              </div>`
            : ""
        }
        <div class="kc-resource-actions">
          ${available ? html`<button class="btn" type="button" @click=${() => void startConnector(id)}>${connected || needsReconnect ? "Reconnect" : "Connect account"}</button>` : ""}
          ${connected || needsReconnect ? html`<button class="kc-text-action danger" type="button" data-confirm-key=${`disconnect:${id}`} ?disabled=${keychainOperations.mutationInFlight} @click=${() => void revokeConnector(id)}>Disconnect</button>` : ""}
        </div>
      </article>
    `;
  });
  if (!appState.mainEl) return;
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane keychain-page scoped-view" : "pane keychain-page";
  render(
    html`
      ${scopedViewTopbar("keychain", () => drawConnectors())}
      <div class="kc-page-content" ?inert=${Boolean(confirmation)}>
        <header class="kc-hero">
          <div class="kc-hero-copy">
            <h1>Keychain</h1>
            <p>Accounts and credentials your agent may use on your behalf.</p>
            <div class="kc-trust-note">
              ${icon(ShieldCheck, 14)}<span>Secrets stay encrypted and every use or shared grant is audited.</span>
            </div>
          </div>
          <div class="kc-hero-actions">
            <button
              class="pane-refresh"
              type="button"
              aria-label="Refresh keychain"
              title="Refresh keychain"
              @click=${() => {
                connectorNotice = "";
                void renderConnectors();
              }}
            >
              ${icon(RefreshCw, 17)}
            </button>
            <button
              class="btn primary"
              type="button"
              @click=${() => {
                addingCredential = { service: "", envKey: "", purpose: "" };
                secureDropUrl = null;
                drawConnectors();
              }}
            >
              ${icon(Plus, 16)} Add credential
            </button>
          </div>
        </header>
        <div class="kc-summary" aria-label="Keychain summary">
          <div><span>${loading ? "—" : summary.connected}</span><small>Connected accounts</small></div>
          <div><span>${loading ? "—" : keychainCredentials.length}</span><small>Stored credentials</small></div>
          <div><span>${loading ? "—" : summary.activeGrants}</span><small>Active grants</small></div>
          <div class=${summary.attention ? "needs-attention" : ""}>
            <span>${loading ? "—" : summary.attention}</span><small>Need attention</small>
          </div>
        </div>
        ${connectorNotice || loading ? html`<div class="kc-notice" role="status">${loading ? "Loading your keychain…" : connectorNotice}</div>` : ""}
        ${addingCredential ? addCredentialCard() : ""}
        <section class="kc-section" aria-labelledby="kc-accounts-title">
          <div class="kc-section-head">
            <div class="kc-section-title">
              <h2 id="kc-accounts-title">Linked accounts</h2>
              <span>${entries.length}</span>
            </div>
            <p>Provider APIs the agent can use as you.</p>
          </div>
          <div class="kc-resource-list">
            ${
              connectorCards.length
                ? connectorCards
                : html`<div class="kc-empty">
                    ${icon(Link, 20)}
                    <div>
                      <strong>No accounts available</strong
                      ><span>Your workspace has not configured any account providers yet.</span>
                    </div>
                  </div>`
            }
          </div>
        </section>
        <section class="kc-section" aria-labelledby="kc-credentials-title">
          <div class="kc-section-head">
            <div class="kc-section-title">
              <h2 id="kc-credentials-title">Stored credentials</h2>
              <span>${keychainCredentials.length}</span>
            </div>
            <p>API keys, tokens, and files you added through the one-time page.</p>
          </div>
          <div class="kc-resource-list">
            ${
              keychainCredentials.length
                ? keychainCredentials.map(credentialCard)
                : html`<div class="kc-empty">
                    ${icon(KeyRound, 20)}
                    <div>
                      <strong>No stored credentials</strong><span>Add one without pasting a secret into chat.</span>
                    </div>
                    <button
                      class="btn"
                      type="button"
                      @click=${() => {
                        addingCredential = { service: "", envKey: "", purpose: "" };
                        secureDropUrl = null;
                        drawConnectors();
                      }}
                    >
                      Add credential
                    </button>
                  </div>`
            }
          </div>
        </section>
      </div>
      ${confirmation ? confirmationCard() : ""}
    `,
    host,
  );
  replacePanePreservingFocus(host);
  if (confirmation) focusDialogCancel(host);
}

export async function renderConnectors(): Promise<void> {
  if (appState.currentView !== "keychain") return;
  const seq = appState.viewRenderSeq;
  const load = keychainOperations.beginLoad();
  drawConnectors(true);
  const [conn, keys] = await Promise.allSettled([
    api<{ providers?: Record<string, ConnectorProvider> }>("/api/connectors"),
    api<{
      credentials?: KeychainCredential[];
      connectorCredentials?: KeychainConnectorCredential[];
      grants?: KeychainGrant[];
      asks?: KeychainAsk[];
      usage?: KeychainUsage[];
      scopeNames?: Record<string, string>;
    }>("/api/keychain/overview"),
  ]);
  if (seq !== appState.viewRenderSeq || !keychainOperations.isCurrentLoad(load) || appState.currentView !== "keychain")
    return;
  const notices: string[] = [];
  if (conn.status === "fulfilled") {
    connectorProviders = Object.fromEntries(
      Object.entries(conn.value.providers ?? {}).filter(([, p]) => p.available || p.connected || p.needsReconnect),
    );
  } else {
    connectorProviders = {};
    notices.push(errMessage(conn.reason, "Failed to load connectors."));
  }
  if (keys.status === "fulfilled") {
    keychainCredentials = (keys.value.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
    keychainConnectorCredentials = keys.value.connectorCredentials ?? [];
    keychainGrants = keys.value.grants ?? [];
    keychainAsks = keys.value.asks ?? [];
    keychainUsage = keys.value.usage ?? [];
    keychainScopeNames = keys.value.scopeNames ?? {};
  } else {
    keychainCredentials = [];
    keychainConnectorCredentials = [];
    keychainGrants = [];
    keychainAsks = [];
    keychainUsage = [];
    keychainScopeNames = {};
    notices.push(errMessage(keys.reason, "Failed to load stored keys."));
  }
  if (notices.length) connectorNotice = notices.join(" ");
  drawConnectors(false);
}

async function deleteCredential(credential: KeychainCredential): Promise<void> {
  const active = keychainGrants.filter(
    (grant) => grant.credentialId === credential.id && isActiveGrant(grant, credential),
  );
  const impact = active.length
    ? ` It will immediately revoke ${active.length} active grant${active.length === 1 ? "" : "s"}: ${active.map((grant) => scopeName(grant.audienceScopeId)).join(", ")}.`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Delete ${credential.service}?`,
    body: `${impact} Automations using it may stop working. The credential cannot be recovered.`.trim(),
    action: "Delete credential",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performDeleteCredential(credential, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

function beginKeychainMutation() {
  const operation = keychainOperations.beginMutation();
  if (operation) return operation;
  confirmation = null;
  confirmationOpener = null;
  connectorNotice = "Another keychain change is still in progress.";
  drawConnectors();
  return null;
}

async function performDeleteCredential(credential: KeychainCredential, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api(`/api/keychain/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not delete the key.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function revokeGrant(grant: KeychainGrant): Promise<void> {
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Revoke access for ${scopeName(grant.audienceScopeId)}?`,
    body: `This ${grant.mode === "standing" ? "standing" : "one-time"} access ends immediately. Automations using it may stop working.`,
    action: "Revoke access",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeGrant(grant.id, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeGrant(id: string, stateEpoch: number): Promise<void> {
  try {
    await api(`/api/keychain/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = "Access revoked ✓";
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not revoke access.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function createDrop(): Promise<void> {
  if (keychainOperations.dropInFlight) return;
  if (!addingCredential?.service.trim() || !addingCredential.purpose.trim()) {
    connectorNotice = "Service and purpose are required.";
    return drawConnectors();
  }
  const submittedDraft = { ...addingCredential };
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(submittedDraft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("No one-time page URL was returned.");
    secureDropUrl = result.url;
    connectorNotice = "Your one-time page is ready.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "Could not create the one-time page.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function startConnector(provider: string): Promise<void> {
  const stateEpoch = keychainOperations.captureEpoch();
  connectorNotice = "";
  try {
    const r = await api<{ authorizeUrl?: string }>(`/api/connectors/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (r.authorizeUrl) {
      location.href = r.authorizeUrl;
      return;
    }
    connectorNotice = "No authorization URL was returned.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "Could not start the connector.");
  }
  drawConnectors(false);
}

async function revokeConnector(provider: string): Promise<void> {
  const hosts = new Set(
    (connectorProviders[provider]?.hosts ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry.host))
      .filter((host): host is string => Boolean(host)),
  );
  const providerCredentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
  const credentialIds = new Set(providerCredentials.map((credential) => credential.credentialId));
  const credentialsById = new Map(
    providerCredentials.map((credential) => [
      credential.credentialId,
      { id: credential.credentialId, kind: "connector" },
    ]),
  );
  const active = keychainGrants.filter(
    (grant) => credentialIds.has(grant.credentialId) && isActiveGrant(grant, credentialsById.get(grant.credentialId)),
  );
  const impact = active.length
    ? ` It will also stop ${active.length} active credential grant${active.length === 1 ? "" : "s"} for this account.`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Disconnect ${CONNECTOR_LABELS[provider]?.name ?? provider}?`,
    body: `${impact} Automations using this account may stop working.`.trim(),
    action: "Disconnect account",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeConnector(provider, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeConnector(provider: string, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api("/api/connectors/revoke", { method: "POST", body: JSON.stringify({ provider }) });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not disconnect.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}
