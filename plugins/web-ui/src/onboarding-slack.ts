import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check } from "lucide";
import { icon, slackMark } from "./ui";

export class OnboardingSlack extends LitElement {
  static properties = {
    installAvailable: { state: true },
    adminBase: {},
    connected: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  adminBase = "/admin";
  private connected = false;
  private installAvailable: boolean | undefined;
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
      const response = await fetch(`${this.adminBase}/api/slack-installation`, {
        signal: controller.signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const status = await response.json();
      this.installAvailable = status.installAvailable === true;
      this.connected = status.configured === true && !status.setupUnavailable && status.setup?.connected !== false;
      this.error = "";
    } catch {
      if (this.isConnected) {
        this.connected = false;
        this.error = "Could not check Slack connection. Try again.";
      }
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      if (this.isConnected && !this.connected && Date.now() < this.pollUntil)
        this.timer = setTimeout(this.refreshVisible, 5000);
    }
  }

  private async install(): Promise<void> {
    if (this.busy || this.installAvailable === undefined) return;
    const popup = window.open("", "_blank");
    if (!popup) {
      this.error = "Allow a new tab to connect Slack, then try again.";
      return;
    }
    popup.opener = null;
    if (this.installAvailable === false) {
      popup.location.href = `${this.adminBase}/connectors?setup=slack`;
      return;
    }
    popup.document.title = "Connecting Slack";
    popup.document.body.textContent = "Opening Slack…";
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(`${this.adminBase}/api/slack-installation/start`, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "install" }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== "string") throw new Error();
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.username || target.password || popup.closed) throw new Error();
      const form = popup.document.createElement("form");
      form.method = "POST";
      form.action = target.href;
      popup.document.body.append(form);
      form.submit();
      this.pollUntil = Date.now() + 10 * 60_000;
      void this.refresh();
    } catch {
      popup.close();
      this.error = "Could not start Slack installation. Please try again.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    let label = this.busy ? "Opening Slack…" : "Add to Slack";
    if (this.installAvailable === undefined) label = "Checking Slack…";
    return html`${
      this.connected
        ? html`<div class="welcome-slack" role="status">
            ${slackMark(24)}<span><strong>Connected to Slack</strong><small>QM is ready in your workspace.</small></span
            >${icon(Check, 16)}
          </div>`
        : html`<button
            class="welcome-slack"
            type="button"
            ?disabled=${this.busy || this.installAvailable === undefined}
            @click=${() => void this.install()}
          >
            ${slackMark(24)}<span
              ><strong>${label}</strong><small>Work with QM where your team already talks.</small></span
            >${icon(ArrowUpRight, 16)}
          </button>`
    }
    ${this.error ? html`<p role="status">${this.error} <button type="button" @click=${() => void this.refresh()}>Check again</button></p>` : nothing}`;
  }
}

if (!customElements.get("qm-onboarding-slack")) customElements.define("qm-onboarding-slack", OnboardingSlack);
