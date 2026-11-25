import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { can } from "./shell-state";

interface PersonaSlackStatus {
  status: "unconnected" | "pending_install" | "connected";
  appId?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  oauthAuthorizeUrl?: string;
  hasOrgConfigToken: boolean;
  publicUrlConfigured: boolean;
  manifestCreateUrl: string;
}

interface PersonaSlackUiState {
  personaId: string;
  loading: boolean;
  busy: boolean;
  status: PersonaSlackStatus | null;
  showSetup: boolean;
  showManual: boolean;
  error: string;
  notice: string;
}

let state: PersonaSlackUiState | null = null;
let loadSeq = 0;

export function resetPersonaSlack(): void {
  loadSeq++;
  state = null;
}

export async function loadPersonaSlack(personaId: string, redraw: () => void): Promise<void> {
  const seq = ++loadSeq;
  state = {
    personaId,
    loading: true,
    busy: false,
    status: null,
    showSetup: false,
    showManual: false,
    error: "",
    notice: "",
  };
  redraw();
  try {
    const status = await api<PersonaSlackStatus>(`/api/personas/${encodeURIComponent(personaId)}/slack`);
    if (seq !== loadSeq || !state || state.personaId !== personaId) return;
    state.status = status;
    state.loading = false;
  } catch (e) {
    if (seq !== loadSeq || !state || state.personaId !== personaId) return;
    state.loading = false;
    state.error = errMessage(e, "Couldn't load Slack app status.");
  }
  redraw();
}

export function personaSlackSection(personaId: string, redraw: () => void): TemplateResult | typeof nothing {
  if (!state || state.personaId !== personaId) return nothing;
  const current = state;
  const isOrgAdmin = can("admin") || can("owner");

  const runCreate = async (body: Record<string, unknown> = {}) => {
    current.busy = true;
    current.error = "";
    current.notice = "";
    redraw();
    try {
      const next = await api<PersonaSlackStatus>(`/api/personas/${encodeURIComponent(personaId)}/slack/create`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      current.status = next;
      current.showSetup = false;
      current.notice = "Slack app created. Click Install in Slack to finish connecting.";
      if (next.oauthAuthorizeUrl) window.open(next.oauthAuthorizeUrl, "_blank", "noopener");
    } catch (e) {
      current.error = errMessage(e, "Couldn't create Slack app.");
    }
    current.busy = false;
    redraw();
  };

  const onAddClick = () => {
    if (current.status?.hasOrgConfigToken && current.status.publicUrlConfigured) {
      void runCreate();
    } else {
      current.showSetup = !current.showSetup;
      current.error = "";
      redraw();
    }
  };

  const submitConfigToken = async (e: SubmitEvent) => {
    e.preventDefault();
    if (current.busy) return;
    const form = e.currentTarget as HTMLFormElement;
    const raw = ((form.elements.namedItem("token") as HTMLInputElement | null)?.value ?? "").trim();
    const saveOrg = Boolean((form.elements.namedItem("saveOrg") as HTMLInputElement | null)?.checked);
    if (!raw) {
      current.error = "Paste a Slack App Configuration refresh token (xoxe-1-…) or access token (xoxe.xoxp-…).";
      redraw();
      return;
    }
    const tokenBody = raw.startsWith("xoxe.") ? { accessToken: raw } : { refreshToken: raw };
    const createBody = raw.startsWith("xoxe.") ? { configToken: raw } : { refreshToken: raw };
    current.busy = true;
    current.error = "";
    redraw();
    try {
      if (isOrgAdmin && saveOrg) {
        await api("/api/admin/slack-config-token", { method: "PUT", body: JSON.stringify(tokenBody) });
        await runCreate({});
      } else {
        await runCreate(createBody);
      }
    } catch (err) {
      current.error = errMessage(err, "Couldn't save config token.");
      current.busy = false;
      redraw();
    }
  };

  const submitManual = async (e: SubmitEvent) => {
    e.preventDefault();
    if (current.busy) return;
    const form = e.currentTarget as HTMLFormElement;
    const botToken = ((form.elements.namedItem("botToken") as HTMLInputElement | null)?.value ?? "").trim();
    const signingSecret = ((form.elements.namedItem("signingSecret") as HTMLInputElement | null)?.value ?? "").trim();
    const appId = ((form.elements.namedItem("appId") as HTMLInputElement | null)?.value ?? "").trim();
    current.busy = true;
    current.error = "";
    redraw();
    try {
      current.status = await api<PersonaSlackStatus>(`/api/personas/${encodeURIComponent(personaId)}/slack`, {
        method: "PUT",
        body: JSON.stringify({ botToken, signingSecret, ...(appId ? { appId } : {}) }),
      });
      current.showSetup = false;
      current.showManual = false;
      current.notice = "Slack app connected.";
    } catch (err) {
      current.error = errMessage(err, "Couldn't connect Slack app.");
    }
    current.busy = false;
    redraw();
  };

  const disconnect = async (deleteRemote: boolean) => {
    if (current.busy) return;
    const prompt = deleteRemote
      ? "Disconnect and delete this Slack app from Slack?"
      : "Disconnect this Slack app from the bot?";
    if (!window.confirm(prompt)) return;
    current.busy = true;
    current.error = "";
    current.notice = "";
    redraw();
    try {
      current.status = await api<PersonaSlackStatus>(`/api/personas/${encodeURIComponent(personaId)}/slack`, {
        method: "DELETE",
        body: JSON.stringify({ deleteRemote }),
      });
      current.notice = "Slack app disconnected.";
    } catch (err) {
      current.error = errMessage(err, "Couldn't disconnect Slack app.");
    }
    current.busy = false;
    redraw();
  };

  const status = current.status;

  const bodyTpl = (): TemplateResult => {
    if (current.loading) return html`<div class="hint">Loading…</div>`;
    if (status?.status === "connected") {
      return html`<div class="persona-slack-connected">
        <div class="hint">
          Connected${status.teamName ? ` to ${status.teamName}` : ""}${status.appId ? ` · App ${status.appId}` : ""}
        </div>
        <div class="actions">
          <button class="btn small" type="button" ?disabled=${current.busy} @click=${() => void disconnect(false)}>
            Disconnect
          </button>
          ${
            status.hasOrgConfigToken && status.appId
              ? html`<button
                  class="btn small"
                  type="button"
                  ?disabled=${current.busy}
                  @click=${() => void disconnect(true)}
                >
                  Disconnect &amp; delete in Slack
                </button>`
              : nothing
          }
        </div>
      </div>`;
    }
    if (status?.status === "pending_install") {
      return html`<div class="persona-slack-pending">
        <div class="hint">App created (${status.appId ?? "pending"}). Finish installing it in Slack:</div>
        <div class="actions">
          ${
            status.oauthAuthorizeUrl
              ? html`<a
                  class="btn primary small"
                  href=${status.oauthAuthorizeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  >Install in Slack</a
                >`
              : nothing
          }
          <button class="btn small" type="button" ?disabled=${current.busy} @click=${() => void disconnect(false)}>
            Cancel
          </button>
        </div>
      </div>`;
    }
    return html`<div class="hint">Give this bot its own Slack bot user and @handle.</div>
      ${
        current.showSetup && status
          ? html`<div class="persona-slack-setup">
              ${
                status.publicUrlConfigured
                  ? html`<form class="resource-form" @submit=${submitConfigToken}>
                      <p class="hint">
                        Generate an App Configuration Token at
                        <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer"
                          >api.slack.com/apps</a
                        >
                        (bottom of page → <strong>Your App Configuration Tokens → Generate Token</strong>) and paste the
                        Refresh Token (<code>xoxe-1-…</code>).
                      </p>
                      <label>
                        App Configuration Token
                        <input
                          name="token"
                          type="password"
                          autocomplete="off"
                          placeholder="xoxe-1-… or xoxe.xoxp-…"
                          ?disabled=${current.busy}
                        />
                      </label>
                      ${
                        isOrgAdmin
                          ? html`<label class="checkbox-row">
                              <input name="saveOrg" type="checkbox" checked ?disabled=${current.busy} />
                              Save for this workspace so future bot apps are 1-click
                            </label>`
                          : nothing
                      }
                      <div class="actions">
                        <button class="btn primary small" type="submit" ?disabled=${current.busy}>
                          ${current.busy ? "Creating…" : "Create Slack app"}
                        </button>
                      </div>
                    </form>`
                  : html`<p class="hint">
                      Automatic app creation needs <code>PUBLIC_WEB_URL</code> configured on this instance.
                    </p>`
              }
              <div class="persona-slack-manual-toggle">
                <button
                  class="btn-link"
                  type="button"
                  @click=${() => {
                    current.showManual = !current.showManual;
                    redraw();
                  }}
                >
                  ${current.showManual ? "Hide manual setup" : "Or connect an existing Slack app"}
                </button>
              </div>
              ${
                current.showManual
                  ? html`<form class="resource-form" @submit=${submitManual}>
                      <p class="hint">
                        Need a new app?
                        <a href=${status.manifestCreateUrl} target="_blank" rel="noopener noreferrer"
                          >Create from manifest in Slack</a
                        >, then paste its Bot Token and Signing Secret below.
                      </p>
                      <label>
                        Bot Token
                        <input name="botToken" type="password" autocomplete="off" placeholder="xoxb-…" required />
                      </label>
                      <label>
                        Signing Secret
                        <input name="signingSecret" type="password" autocomplete="off" required />
                      </label>
                      <label>
                        App ID <span class="hint">(optional)</span>
                        <input name="appId" autocomplete="off" placeholder="A0…" />
                      </label>
                      <div class="actions">
                        <button class="btn small" type="submit" ?disabled=${current.busy}>Connect app</button>
                      </div>
                    </form>`
                  : nothing
              }
            </div>`
          : nothing
      }`;
  };

  return html`<section class="persona-section persona-slack-section">
    <div class="persona-section-head">
      <h3>Slack app</h3>
      ${
        status?.status === "unconnected"
          ? html`<button class="btn small" type="button" ?disabled=${current.busy} @click=${onAddClick}>
              ${current.busy ? "Creating…" : "Add Slack app"}
            </button>`
          : nothing
      }
    </div>
    ${current.notice ? html`<div class="action-notice" role="status">${current.notice}</div>` : nothing}
    ${current.error ? html`<div class="form-error" role="alert">${current.error}</div>` : nothing} ${bodyTpl()}
  </section>`;
}
