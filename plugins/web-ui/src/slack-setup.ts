import { html, LitElement, nothing } from "lit";

// This is a bot installation, not a personal Slack account connection.
class SlackSetup extends LitElement {
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private appReady = false;
  private connected = false;
  private unavailable = false;
  private forbidden = false;
  private startedAt = 0;
  private links?: { tokenUrl: string; submitUrl: string; installUrl: string };

  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.startedAt = Date.now();
    document.addEventListener("visibilitychange", this.refreshVisible);
    window.addEventListener("focus", this.refreshVisible);
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
    this.request?.abort();
    document.removeEventListener("visibilitychange", this.refreshVisible);
    window.removeEventListener("focus", this.refreshVisible);
  }

  private refreshVisible = (): void => {
    if (!document.hidden && !this.request) void this.refresh();
  };

  private async refresh(): Promise<void> {
    if (this.request || !this.isConnected) return;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/admin/api/slack-installation", {
        signal: controller.signal,
        credentials: "same-origin",
        redirect: "error",
      });
      this.forbidden = response.status === 401 || response.status === 403;
      if (!response.ok) throw new Error("Status unavailable");
      const data = await response.json();
      if (!data.setup || data.setupUnavailable) throw new Error("Status unavailable");
      const { tokenUrl, submitUrl, installUrl } = data.setup;
      if (
        tokenUrl !== "https://api.slack.com/apps" ||
        submitUrl !== `${location.origin}/admin?slack=setup` ||
        installUrl !== `${location.origin}/admin?slack=install`
      )
        throw new Error("Invalid setup links");
      this.links = { tokenUrl, submitUrl, installUrl };
      this.appReady = data.setup.appReady === true;
      this.connected = data.configured === true && data.setup.connected === true;
      this.unavailable = false;
    } catch {
      this.unavailable = true;
      // A stale success is not evidence of a current connection.
      this.connected = false;
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      if (this.isConnected) {
        this.requestUpdate();
        if (!this.connected && !this.forbidden && Date.now() - this.startedAt < 10 * 60_000) {
          this.timer = setTimeout(() => {
            if (!document.hidden) void this.refresh();
          }, 5_000);
        }
      }
    }
  }

  protected render() {
    if (this.forbidden) return html`<p>Only a QM administrator can set up the Slack bot.</p>`;
    if (this.connected)
      return html`<div class="connector-widget connected" role="status">
        <span class="connector-widget-text"
          ><strong>Connected to Slack</strong><small>The bot is installed. You can return to onboarding.</small></span
        >
      </div>`;
    if (!this.links)
      return html`<p role="status">
        ${this.unavailable ? "Slack setup status is unavailable." : "Checking Slack setup…"}
        <button type="button" @click=${() => void this.refresh()}>Retry</button>
      </p>`;
    let progress = this.appReady ? "Waiting for Slack approval." : "Waiting for token submission.";
    if (this.unavailable) progress = "Could not check progress. Your setup has not been reset.";
    return html`<section class="slack-setup-checklist" aria-label="Add QM to Slack">
      <strong>Add QM to Slack</strong>
      <ol>
        <li>
          <a href=${this.links.tokenUrl} target="_blank" rel="noreferrer">Create token</a><br /><small
            >Under App Configuration Tokens, choose Generate Token, select your workspace, and copy the access token
            (not the refresh token).</small
          >
          <details>
            <summary>Show me how</summary>
            <img
              src=${new URL("../../../docs/images/slack-app-config-token-setup.gif", import.meta.url).href}
              alt="Generate a Slack app configuration token and copy its access token"
              loading="lazy"
            />
          </details>
        </li>
        <li>
          <a href=${this.links.submitUrl} target="_blank" rel="noopener">Submit token securely</a><br /><small
            >${this.appReady ? "App created. No more token copying needed." : "Paste it only in the secure form, never in this conversation. QM uses it to create its app, then discards it."}</small
          >
        </li>
        <li>
          <a class="connector-widget" href=${this.links.installUrl} target="_blank" rel="noopener"
            ><span class="connector-widget-text"
              ><strong>Add to Slack</strong
              ><small
                >${this.appReady ? "Review the workspace and choose Allow." : "Submit the token first, then choose Allow in Slack."}</small
              ></span
            ></a
          >
        </li>
      </ol>
      <small
        >This token can manage other apps you own in the selected workspace. Your company owns the app QM
        creates.</small
      >
      <p role="status">${progress}</p>
      <button
        type="button"
        @click=${() => {
          this.startedAt = Date.now();
          void this.refresh();
        }}
      >
        Check progress
      </button>
      ${this.unavailable ? html`<small> You can retry the existing links.</small>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-setup")) customElements.define("qm-slack-setup", SlackSetup);
