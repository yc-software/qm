import { composerInput, resizeComposerInput } from "./composer-input";
import { ArrowUp } from "lucide";
import { icon } from "./icons";
import { tip } from "./tooltip";
import { LitElement, html, nothing } from "lit";
import { withBase } from "./core-bridge";
import { reportHandledError } from "./browser-errors.ts";
import "./slack-account";
import "./slack-reply.css";

const FOCUS_REFRESH_MS = 60_000;
const KNOWN_KEY = "qm-slack-reply-known";
type Known = { user: string; connected: boolean; label: string };

function remembered(user: string): Known | null {
  try {
    const known = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "null") as Known | null;
    return known?.user === user ? known : null;
  } catch {
    return null;
  }
}
function remember(known: Known): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch {
    return;
  }
}

export class SlackReply extends LitElement {
  static properties = {
    sessionId: {},
    user: {},
    connected: { state: true },
    linkAvailable: { state: true },
    sending: { state: true },
    error: { state: true },
    text: { state: true },
    label: { state: true },
  };
  sessionId = "";
  user = "";
  private connected: boolean | null = null;
  private linkAvailable = false;
  private checkedAt = 0;
  private sending = false;
  private error = "";
  private text = "";
  private label = "";
  private inputObserver: ResizeObserver | null = null;
  private observedInput: HTMLTextAreaElement | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshOnFocus);
    this.requestUpdate();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refreshOnFocus);
    this.inputObserver?.disconnect();
    this.inputObserver = null;
    this.observedInput = null;
  }
  protected updated(): void {
    const input = this.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input !== this.observedInput) {
      this.inputObserver?.disconnect();
      this.inputObserver = null;
      this.observedInput = input;
    }
    if (!input) return;
    resizeComposerInput(input);
    if (!this.inputObserver && typeof ResizeObserver !== "undefined") {
      let width = input.clientWidth;
      this.inputObserver = new ResizeObserver(() => {
        if (width === input.clientWidth) return;
        width = input.clientWidth;
        resizeComposerInput(input);
      });
      this.inputObserver.observe(input);
    }
  }
  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("user") || this.connected !== null) return;
    const known = remembered(this.user);
    if (known) {
      this.connected = known.connected;
      this.linkAvailable = !known.connected;
      this.label = known.label;
    }
  }
  protected firstUpdated(): void {
    void this.check(false);
  }
  private refreshOnFocus = (): void => {
    if (Date.now() - this.checkedAt >= FOCUS_REFRESH_MS) void this.check(false);
  };
  private refresh = (): Promise<void> => this.check(true);
  private async check(explicit: boolean): Promise<void> {
    this.checkedAt = Date.now();
    try {
      const response = await this.request("reply-status");
      const result = await response.json();
      if (response.ok) {
        this.connected = result.connected === true;
        this.linkAvailable = true;
        this.label = result.user ?? "yourself";
        this.error = "";
        remember({ user: this.user, connected: this.connected, label: this.label });
      } else if (result.error === "composio_unavailable") {
        this.connected = false;
        this.linkAvailable = false;
        this.error = "Slack linking isn’t configured for your account on this deployment.";
      } else if (explicit) this.error = result.message ?? "Could not check your Slack connection.";
    } catch (error) {
      reportHandledError("web:slack_reply_status", error);
      if (explicit) this.error = "Could not check your Slack connection.";
    }
  }
  private request(action: string, message?: { text: string; clientMessageId: string }): Promise<Response> {
    return fetch(withBase(`/api/composio/slack/${action}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, ...message }),
      signal: AbortSignal.timeout(60_000),
    });
  }
  private async send(event: Event): Promise<void> {
    event.preventDefault();
    if (this.connected === false || this.sending || !this.text.trim()) return;
    this.sending = true;
    this.error = "";
    try {
      const response = await this.request("reply", { text: this.text, clientMessageId: crypto.randomUUID() });
      const result = await response.json();
      if (!response.ok || !result.sent) {
        if (result.connected === false) {
          this.connected = false;
          this.linkAvailable = true;
          remember({ user: this.user, connected: false, label: this.label });
        }
        this.error = result.message ?? "Could not send your Slack message.";
        return;
      }
      this.text = "";
      this.dispatchEvent(new CustomEvent("slack-sent", { bubbles: true }));
    } catch {
      this.error = "The send outcome is unknown. Check Slack before trying again.";
    } finally {
      this.sending = false;
    }
  }
  protected render() {
    if (this.connected !== false)
      return html`<form class="composer-wrap" @submit=${(e: Event) => void this.send(e)}>
        ${composerInput({
          value: this.text,
          placeholder: `Reply in Slack as ${this.label || "yourself"}`,
          label: `Reply in Slack as ${this.label || "yourself"}`,
          disabled: this.sending,
          maxLength: 4000,
          onInput: (e) => {
            this.text = (e.target as HTMLTextAreaElement).value;
          },
          onKeydown: (e) => {
            if (e.isComposing || e.keyCode === 229 || e.key !== "Enter" || e.shiftKey) return;
            void this.send(e);
          },
        })}
        <div class="composer-toolbar">
          <div class="composer-left"></div>
          <div class="composer-right">
            <button
              class="send-btn"
              type="submit"
              aria-label="Send to Slack"
              ${tip("Send to Slack")}
              ?disabled=${this.sending || !this.text.trim()}
            >
              ${icon(ArrowUp, 16)}
            </button>
          </div>
        </div>
        ${this.error ? html`<div class="composer-error" role="alert">${this.error}</div>` : nothing}
      </form>`;
    return html`<div class="slack-reply-box">
      ${this.linkAvailable ? html`<qm-slack-account .user=${this.user} .reply=${true} @slack-linked=${this.refresh}></qm-slack-account>` : nothing}
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error} <button class="btn" @click=${this.refresh}>Check connection</button></p>` : nothing}
    </div>`;
  }
}
if (!customElements.get("qm-slack-reply")) customElements.define("qm-slack-reply", SlackReply);
