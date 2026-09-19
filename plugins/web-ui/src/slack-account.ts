import { LitElement, html, nothing } from "lit";
import { slackMark } from "./ui";
import { withBase } from "./core-bridge";

interface SlackAttempt {
  user: string;
  state: string;
  ticket: string;
  expiresAt: number;
}

let returnUrl: URL | null = null;

export function captureSlackReturn(url: string): void {
  const parsed = new URL(url);
  returnUrl = parsed.searchParams.has("slackReturn") ? parsed : null;
}

export class SlackAccount extends LitElement {
  static properties = {
    user: {},
    busy: { state: true },
    error: { state: true },
    connected: { state: true },
    label: { state: true },
  };
  user = "";
  private busy = false;
  private error = "";
  private connected = false;
  private label = "";
  private attempt: SlackAttempt | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected firstUpdated(): void {
    const url = returnUrl ?? new URL(location.href);
    returnUrl = null;
    const state = url.searchParams.get("slackReturn");
    try {
      const saved = JSON.parse(sessionStorage.getItem("qm-slack-account") ?? "null") as SlackAttempt | null;
      if (saved?.user === this.user && saved.expiresAt > Date.now()) this.attempt = saved;
    } catch {
      this.attempt = null;
    }
    if (state) {
      const cancelled = url.searchParams.has("error");
      for (const key of ["slackReturn", "status", "error", "connectedAccountId"]) url.searchParams.delete(key);
      history.replaceState(history.state, "", url);
      if (!this.attempt || this.attempt.state !== state) {
        this.error =
          "This connection expired or was started in another QM account. Sign in to the account you want to connect and try again.";
        return;
      }
      if (cancelled) {
        this.clearAttempt();
        this.error = "Slack authorization was cancelled. Your QM account has not been linked.";
        return;
      }
      void this.complete();
    } else void this.status();
  }

  private clearAttempt(): void {
    this.attempt = null;
    sessionStorage.removeItem("qm-slack-account");
  }

  private async status(): Promise<void> {
    try {
      const response = await fetch(withBase("/api/composio/slack"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const result = await response.json();
      this.connected = result.connected === true;
      this.label = [result.user, result.workspace].filter(Boolean).join(" · ");
    } catch {
      return;
    }
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const state = crypto.randomUUID();
      const response = await fetch(withBase("/api/composio/slack/authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, returnTo: withBase("/?view=settings") }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? "Could not start Slack authorization. Please try again.");
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        !["connect.composio.dev", "app.composio.dev"].includes(url.hostname) ||
        url.username ||
        url.password ||
        typeof result.ticket !== "string"
      )
        throw Error("Could not verify the Slack authorization link.");
      this.attempt = { user: this.user, state, ticket: result.ticket, expiresAt: Date.now() + 20 * 60_000 };
      sessionStorage.setItem("qm-slack-account", JSON.stringify(this.attempt));
      location.assign(url.href);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not connect Slack.";
    } finally {
      this.busy = false;
    }
  }

  private async complete(): Promise<void> {
    if (this.busy || !this.attempt) return;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(withBase("/api/composio/slack/complete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: this.attempt.ticket }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? "Could not verify your Slack account. Try again.");
      this.connected = true;
      this.label = [result.user, result.workspace].filter(Boolean).join(" · ");
      this.clearAttempt();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not verify your Slack account.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    return html`<section class="settings-row slack-account" aria-label="Your Slack account">
      <div class="settings-row-copy">
        <div class="settings-row-title">
          ${slackMark(20)} ${this.connected ? "Your Slack account is linked" : "Connect your Slack account"}
        </div>
        <p class="settings-row-note">
          ${this.connected ? this.label : "Let QM recognize you in Slack and search conversations you can access. Connect the Slack account you want to use with this QM account."}
        </p>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      </div>
      ${this.connected ? nothing : html`<button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.connect()}>${this.busy ? "Connecting…" : "Connect Slack"}</button>`}
      ${this.attempt && !this.connected ? html`<button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.complete()}>Check connection</button>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-account")) customElements.define("qm-slack-account", SlackAccount);
