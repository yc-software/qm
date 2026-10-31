import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check, Link2, UserRound } from "lucide";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import "./slack-account.css";
import { withBase } from "./core-bridge";
import {
  clearAttempt,
  createReturnCapture,
  loadAttempt,
  saveAttempt,
  watchVisible,
  type OAuthAttempt,
} from "./oauth-attempt";

interface SlackAttempt extends OAuthAttempt {
  ticket: string;
}

const ATTEMPT_KEY = "qm-slack-account";
const slackReturn = createReturnCapture((params) => params.has("slackReturn"));

export const captureSlackReturn = slackReturn.capture;

export class SlackAccount extends LitElement {
  static properties = {
    user: {},
    reply: { type: Boolean },
    busy: { state: true },
    error: { state: true },
    connected: { state: true },
    label: { state: true },
  };
  user = "";
  reply = false;
  private busy = false;
  private error = "";
  private connected = false;
  private label = "";
  private nativeOAuth = false;
  private attempt: SlackAttempt | null = null;
  private unwatch = (): void => {};

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unwatch = watchVisible(() => void this.status());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unwatch();
  }

  protected firstUpdated(): void {
    const url = slackReturn.take();
    const state = url.searchParams.get("slackReturn");
    this.attempt = loadAttempt<SlackAttempt>(ATTEMPT_KEY, this.user);
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
        this.dropAttempt();
        this.error = "Slack authorization was cancelled. Your QM account has not been linked.";
        return;
      }
      void this.complete();
    } else void this.status();
  }

  private dropAttempt(): void {
    this.attempt = null;
    clearAttempt(ATTEMPT_KEY);
  }

  private async status(): Promise<void> {
    try {
      const response = await fetch(withBase("/api/composio/slack"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const result = await response.json();
      this.nativeOAuth = result.nativeOAuth === true;
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
      if (await openDesktopBrowser(withBase("/settings"))) return;
      await this.status();
      if (this.nativeOAuth) {
        const response = await fetch(withBase("/api/connectors/slack/start"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ returnTo: `${location.pathname}${location.search}` }),
          signal: AbortSignal.timeout(30_000),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.message ?? "Could not start Slack authorization.");
        const url = new URL(result.authorizeUrl);
        if (
          url.origin !== "https://slack.com" ||
          url.pathname !== "/oauth/v2/authorize" ||
          url.username ||
          url.password
        )
          throw Error("Could not verify the Slack authorization link.");
        location.assign(url.href);
        return;
      }
      const state = crypto.randomUUID();
      const response = await fetch(withBase("/api/composio/slack/authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, returnTo: `${location.pathname}${location.search}` }),
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
      saveAttempt(ATTEMPT_KEY, this.attempt);
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
      this.dropAttempt();
      this.dispatchEvent(new CustomEvent("slack-linked", { bubbles: true }));
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not verify your Slack account.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    return html`<section class="slack-account" aria-label="Your Slack account">
      ${
        this.connected && !this.reply
          ? html`<div class="slack-connected" role="status">
              ${icon(Check, 14)}<span>Your Slack account is linked${this.label ? ` · ${this.label}` : ""}</span>
            </div>`
          : html`<button class="welcome-slack" type="button" ?disabled=${this.busy} @click=${() => void this.connect()}>
              <div class="slack-link-icon" aria-hidden="true">
                <span class="slack-link-person">${icon(UserRound, 17)}</span>
                <span class="slack-link-service">${slackMark(18)}</span>
                <span class="slack-link-chain">${icon(Link2, 13)}</span>
              </div>
              <span
                ><strong>${this.busy ? "Linking Slack…" : "Link your Slack account"}</strong
                ><small
                  >${this.reply ? "Send replies here as yourself in Slack." : "Let QM search Slack and take action on your behalf."}</small
                ></span
              >
              ${icon(ArrowUpRight, 16)}
            </button>`
      }
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error}</p>` : nothing}
      ${this.attempt && !this.connected ? html`<button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.complete()}>Check connection</button>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-account")) customElements.define("qm-slack-account", SlackAccount);
