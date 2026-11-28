import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import "./slack-account.css";
import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check } from "lucide";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import { UI_BASE } from "./deep-link";

const INSTALLATION_API = `${UI_BASE}/api/admin/slack-installation`;
const SLACK_SETTINGS = `${UI_BASE}/settings/slack-settings`;

export class OnboardingSlack extends LitElement {
  static properties = {
    installAvailable: { state: true },
    connected: { state: true },
    busy: { state: true },
    error: { state: true },
    justInstalled: { state: true },
  };
  private connected = false;
  private installStarted = false;
  private justInstalled = false;
  private installAvailable: boolean | undefined;
  private unavailable = false;
  private busy = false;
  private error = "";
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private pollUntil = 0;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshVisible);
    document.addEventListener("visibilitychange", this.refreshVisible);
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refreshVisible);
    document.removeEventListener("visibilitychange", this.refreshVisible);
    this.request?.abort();
    clearTimeout(this.timer);
  }

  private refreshVisible = (): void => {
    if (!document.hidden) void this.refresh();
  };

  private async refresh(): Promise<void> {
    if (this.request || !this.isConnected) return;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(INSTALLATION_API, {
        signal: controller.signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const status = await response.json();
      const wasConnected = this.connected;
      this.installAvailable = status.installAvailable === true;
      this.connected = status.configured === true && !status.setupUnavailable && status.setup?.connected !== false;
      if (this.connected && !wasConnected && this.installStarted) {
        this.installStarted = false;
        this.justInstalled = true;
        this.dispatchEvent(new window.CustomEvent("slack-installed", { bubbles: true }));
      }
      if (!this.connected) this.justInstalled = false;
      this.unavailable = status.setupUnavailable === true && !this.installAvailable;
      this.error = "";
    } catch {
      if (this.isConnected) {
        this.connected = false;
        this.error = "Could not check the Slack installation. Try again.";
      }
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      this.dispatchEvent(
        new window.CustomEvent("slack-installation-status", { detail: { connected: this.connected } }),
      );
      if (this.isConnected && !this.connected && Date.now() < this.pollUntil)
        this.timer = setTimeout(this.refreshVisible, 5000);
    }
  }

  private watchInstall(): void {
    this.installStarted = true;
    this.pollUntil = Date.now() + 10 * 60_000;
    void this.refresh();
  }

  private async install(): Promise<void> {
    if (this.busy || this.installAvailable === undefined) return;
    try {
      if (await openDesktopBrowser(`${SLACK_SETTINGS}?slack=install`)) {
        this.watchInstall();
        return;
      }
    } catch {
      this.error = "Could not open your browser. Please try again.";
      return;
    }
    const popup = window.open("", "_blank");
    if (!popup) {
      this.error = "Allow a new tab to install QM, then try again.";
      return;
    }
    popup.opener = null;
    if (this.installAvailable === false && !this.unavailable) {
      popup.location.href = `${SLACK_SETTINGS}?setup=slack`;
      this.watchInstall();
      return;
    }
    popup.document.title = "Connecting Slack";
    popup.document.body.textContent = "Opening Slack…";
    this.busy = true;
    this.error = "";
    let failure = "Could not start Slack installation. Please try again.";
    try {
      const response = await fetch(`${INSTALLATION_API}/start`, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "install" }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== "string") {
        if (typeof result.message === "string" && result.message) failure = result.message;
        throw new Error();
      }
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.username || target.password || popup.closed) throw new Error();
      const form = popup.document.createElement("form");
      form.method = "POST";
      form.action = target.href;
      popup.document.body.append(form);
      form.submit();
      this.watchInstall();
    } catch {
      popup.close();
      this.error = failure;
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    let label = this.busy ? "Opening Slack…" : "Add to Slack";
    if (this.installAvailable === undefined) label = "Checking Slack…";
    let status = html`<div class="slack-connected" role="status">${icon(Check, 14)} QM added to Slack</div>`;
    if (this.justInstalled)
      status = html`<div class="welcome-slack slack-installed" role="status">
        <span class="slack-installed-mark"
          >${slackMark(24)}<span class="slack-installed-check">${icon(Check, 10)}</span></span
        ><span><strong>QM added to Slack</strong><small>Your team can now work with QM in Slack.</small></span>
      </div>`;
    return html`${
      this.connected
        ? status
        : html`<button
            class="welcome-slack"
            type="button"
            ?disabled=${this.busy || this.installAvailable === undefined}
            @click=${() => void this.install()}
          >
            ${slackMark(24)}<span
              ><strong>${label}</strong
              ><small>Choose your company’s own workspace, not a shared community one.</small></span
            >${icon(ArrowUpRight, 16)}
          </button>`
    }
    ${this.error ? html`<p role="status">${this.error} <button type="button" @click=${() => void this.refresh()}>Check again</button></p>` : nothing}`;
  }
}

if (!customElements.get("qm-onboarding-slack")) customElements.define("qm-onboarding-slack", OnboardingSlack);
