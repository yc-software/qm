import { html, render } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type { AdminPage } from "./sections.ts";
import { textField } from "./setting-controls.ts";

interface TeamsStatus {
  configured?: boolean;
  tenantId?: string;
  appId?: string;
  endpoint?: string;
  signInRedirect?: string;
  message?: string;
}

const PORTALS = {
  bots: "https://dev.teams.microsoft.com/tools/bots",
  tenant: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/TenantOverview.ReactView",
  apps: "https://admin.teams.microsoft.com/policies/manage-apps",
  setup: "https://admin.teams.microsoft.com/policies/app-setup",
  registrations: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
};

let page: AdminPage;
let data: TeamsStatus = {};
let draft = { tenantId: "", appId: "", appSecret: "" };
let editing = false;
let busy = "";
let message = "";
let tone = "";
let copied = "";

const draw = () => page?.host.isConnected && render(template(), page.host);

function say(text: string, kind: string) {
  message = text;
  tone = kind;
  draw();
}

async function load() {
  const result = await page.api<TeamsStatus>("GET", "/teams");
  if (!page.current()) return;
  if (!result.ok) return say(result.data?.message || "Failed to load Microsoft Teams status.", "err");
  data = result.data;
  editing = !data.configured;
  draft = { tenantId: data.tenantId || "", appId: data.appId || "", appSecret: "" };
  draw();
}

export async function mount(next: AdminPage) {
  page = next;
  message = "";
  draw();
  await load();
}

async function save() {
  if (busy) return;
  const body = {
    tenantId: draft.tenantId.trim(),
    appId: draft.appId.trim(),
    ...(draft.appSecret.trim() ? { appSecret: draft.appSecret.trim() } : {}),
  };
  if (!body.tenantId || !body.appId) return say("Enter both the directory (tenant) ID and the bot ID.", "err");
  busy = "save";
  say("Checking these details with Microsoft…", "saving");
  try {
    const result = await page.api<TeamsStatus>("PUT", "/teams", body);
    if (!result.ok) return say(result.data?.message || "Microsoft Teams validation failed.", "err");
    data = result.data;
    editing = false;
    draft.appSecret = "";
    say("Connected. Download the Teams app below and add it to Teams.", "ok");
  } finally {
    busy = "";
    draw();
  }
}

async function remove() {
  if (busy || !confirm("Disconnect Microsoft Teams? QM stops answering in Teams until you connect a bot again."))
    return;
  busy = "remove";
  draw();
  try {
    const result = await page.api<TeamsStatus>("DELETE", "/teams");
    if (!result.ok) return say(result.data?.message || "Disconnect failed.", "err");
    data = result.data;
    editing = true;
    draft = { tenantId: "", appId: "", appSecret: "" };
    say("Microsoft Teams disconnected.", "ok");
  } finally {
    busy = "";
    draw();
  }
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value);
  copied = value;
  draw();
  setTimeout(() => {
    if (copied === value) copied = "";
    draw();
  }, 1500);
}

function value(text: string | undefined, id: string) {
  if (!text) return html`<p><em>Available once this deployment has a public URL.</em></p>`;
  return html`<p>
    <code id=${id}>${text}</code>
    <button class="btn" type="button" @click=${() => copy(text)}>${copied === text ? "Copied" : "Copy"}</button>
  </p>`;
}

function link(href: string, label: string) {
  return html`<a href=${href} target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
}

function connection() {
  return html`<div class="app-connection">
    <div class="app-connection-info">
      <h3 id="teams-state">${data.configured ? "Connected" : "Not connected"}</h3>
      <p class="hint" id="teams-description">
        ${
          data.configured
            ? html`Bot <code>${data.appId}</code> in Microsoft organization <code>${data.tenantId}</code>.`
            : "Follow the steps below to give this workspace its own Teams bot."
        }
      </p>
    </div>
    <div class="app-connection-actions">
      <button
        class=${classMap({ btn: true, hidden: !data.configured || editing })}
        id="teams-edit"
        @click=${() => {
          editing = true;
          draw();
        }}
      >
        Change bot
      </button>
      <button
        class=${classMap({ btn: true, danger: true, hidden: !data.configured })}
        id="teams-delete"
        ?disabled=${!!busy}
        @click=${remove}
      >
        Disconnect
      </button>
    </div>
  </div>`;
}

function editor() {
  const set = (key: keyof typeof draft) => (text: string) => {
    draft = { ...draft, [key]: text };
  };
  return html`<div id="teams-editor" class=${editing ? "app-editor" : "app-editor hidden"}>
    ${textField("Directory (tenant) ID", "", "teams-tenant-id", draft.tenantId, set("tenantId"), {
      auto: "off",
      placeholder: "00000000-0000-0000-0000-000000000000",
    })}
    ${textField("Bot ID", "", "teams-app-id", draft.appId, set("appId"), {
      auto: "off",
      placeholder: "00000000-0000-0000-0000-000000000000",
    })}
    ${textField(
      "Client secret",
      data.configured ? "leave empty to keep the current secret" : "",
      "teams-app-secret",
      draft.appSecret,
      set("appSecret"),
      { type: "password", auto: "off" },
    )}
    <button class="btn primary" id="teams-save" ?disabled=${!!busy} @click=${save}>Verify and connect</button>
  </div>`;
}

function steps() {
  return html`<ol id="teams-steps">
    <li>
      <strong>Create your bot.</strong> Sign in to the ${link(PORTALS.bots, "Teams Developer Portal")} as an admin of
      your Microsoft organization, open <strong>Bot management</strong> and choose <strong>New bot</strong>. Name it
      after your agent.
      <ul>
        <li>
          Under <strong>Configure</strong>, pick <strong>HTTPS endpoint</strong>, paste this address and choose
          <strong>Save</strong>: ${value(data.endpoint, "teams-endpoint")}
        </li>
        <li>Under <strong>Client secrets</strong>, create a secret and copy it. Microsoft shows it only once.</li>
        <li>Copy the bot ID from the bot's page or the browser address bar.</li>
      </ul>
    </li>
    <li>
      <strong>Find your directory (tenant) ID</strong> on the ${link(PORTALS.tenant, "Microsoft Entra overview")} page.
    </li>
    <li>
      <strong>Connect the bot to this workspace.</strong> Paste the three values below and choose
      <strong>Verify and connect</strong>. QM checks them with Microsoft before saving. ${editor()}
    </li>
    <li>
      <strong>Add the app to Teams.</strong> Download the app below once the bot is connected. It already carries your
      bot, your branding and the permission to read messages in the teams and chats it is added to, so QM can follow
      conversations and join in when it can help. In the ${link(PORTALS.apps, "Teams admin center")}, open
      <strong>Manage apps → Actions → Upload new app</strong> and choose the downloaded file. If uploads are blocked,
      turn on <strong>Upload custom apps</strong> in ${link(PORTALS.setup, "App setup policies")}. Download and upload
      again whenever you change the bot.
      <p>
        <button
          class="btn primary"
          type="button"
          id="teams-download"
          ?disabled=${!data.configured}
          @click=${() => location.assign(page.apiBase + "/teams/app-package")}
        >
          Download the Teams app
        </button>
      </p>
    </li>
    <li>
      <strong>Try it.</strong> In Teams, open <strong>Apps → Built for your org</strong>, add the app, send it a direct
      message, then add it to a team and mention it in a channel.
    </li>
    <li>
      <strong>Sign your employees in with Microsoft.</strong> In
      ${link(PORTALS.registrations, "Entra app registrations")}, open the registration whose application ID matches your
      bot ID.
      <ul>
        <li>
          Under <strong>Authentication</strong>, add a <strong>Web</strong> platform with this redirect URI:
          ${value(data.signInRedirect, "teams-redirect")}
        </li>
        <li>
          Under <strong>Token configuration</strong>, add the optional ID token claims <code>email</code> and
          <code>xms_edov</code>. QM only trusts an email address Microsoft confirms your organization owns.
        </li>
        <li>
          Ask whoever runs this QM deployment to switch sign-in to Microsoft for your directory and limit it to your
          email domain. People outside that domain are refused.
        </li>
      </ul>
    </li>
  </ol>`;
}

function template() {
  return html`<div id="view-governance">
    <div class="governance-content">
      <section class="card app-card" id="card-teams">
        <div class="head"><h2>Your Teams bot</h2></div>
        <div class="body">
          ${connection()}
          <details id="teams-guide" class="app-guide" .open=${editing || !data.configured}>
            <summary>
              <span>${data.configured ? "Setup steps" : "Set up Microsoft Teams"}</span>
              <span class="app-guide-arrow" aria-hidden="true">›</span>
            </summary>
            ${steps()}
          </details>
          <span class=${"status app-status " + tone} role="status" id="st-teams">${message}</span>
        </div>
      </section>
    </div>
  </div>`;
}
